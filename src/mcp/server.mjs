#!/usr/bin/env node
// edit-trail · MCP server (stdio, newline-delimited JSON-RPC, zero dependency)
// 让大模型在"再读文档"之前先拿到「自上次读过以来发生了什么变化」，
// 而不是重新通读并自行 diff。
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readJournal, readReaders, writeReaders, listLineage, resolveSince,
  readerKey, displayName, journalPath,
} from './store.mjs';
import { renderChanges, renderTrail, renderVersions } from './render.mjs';
import { extractRevisions, renderRevisions } from '../core/revisions.mjs';

const SERVER_NAME = 'edit-trail';
const SERVER_VERSION = '0.0.3';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 本地时区格式化：journal/readers 里存的是带时区的 ISO，直接 toISOString() 会显示成 UTC（差 8 小时）
function fmtLocal(iso) {
  const ms = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso || '?');
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function log(...a) {  process.stderr.write('[edit-trail-mcp] ' + a.join(' ') + '\n');
}

// ─────────────────────────── 工具定义 ───────────────────────────
const TOOLS = [
  {
    name: 'doc_changes',
    description:
      '获取某个 Office 文档（xlsx/docx/pptx）自上次读取以来的变更简报：谁改的（用户手改/模型写回）、' +
      '改在哪个 sheet!单元格 / 哪一段 / 哪一页，修改前后的文字。' +
      '在"用户说他自己改过文档"或"要接着改一份之前改过的文档"时，应先调用本工具，避免重新通读全文做 diff。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '文档绝对路径（或相对当前工作目录）' },
        reader: { type: 'string', description: '读取者标识，用于自动推进"上次读到哪"的游标；默认取当前会话' },
        since: { type: 'string', description: '可选：从某个 sha 前缀 / seq / 版本号(v2.3) / ISO 时间开始算；不给则用 reader 游标' },
        advance: { type: 'boolean', description: '是否把 reader 游标推进到本次结果（默认 true）' },
        maxChanges: { type: 'integer', description: '最多列出多少条改动（默认 40）' },
        includeStyle: { type: 'boolean', description: '是否包含纯样式变化（默认 false，通常噪声）' },
      },
      required: ['file'],
    },
  },
  {
    name: 'doc_trail',
    description: '列出文档的落盘时间线：每次保存的时间、版本、来源、改动条数、sha。用于快速判断"改了几轮、什么时候改的"。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        limit: { type: 'integer', description: '显示最近多少条，默认 20' },
      },
      required: ['file'],
    },
  },
  {
    name: 'doc_versions',
    description: '列出文档族（同一文档的 v1.0/v2.3/v3.0… 等按文件名区分的版本）及其追踪状态、累计改动数。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' } },
      required: ['file'],
    },
  },
  {
    name: 'doc_scan',
    description: '立刻对文档做一次快照并记录（用于"用户刚改完、还没被守护进程捕获"的情况），返回本次差异。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        actor: { type: 'string', description: 'wps-user | model | script | unknown，默认 wps-user' },
      },
      required: ['file'],
    },
  },
  {
    name: 'doc_revisions',
    description:
      '读 docx 的原生修订标记（w:ins / w:del / 格式修订），回答"谁改的"：作者、时间、段落 paraId 锚点、文本。' +
      '仅当编辑时开着「修订」模式才有内容；用户点过「接受所有修订」后为空。xlsx/pptx 没有这条通道。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        limit: { type: 'integer', description: '最多列出多少条，默认 50' },
      },
      required: ['file'],
    },
  },
];

// ─────────────────────────── 工具实现 ───────────────────────────
function errText(msg) {
  return { content: [{ type: 'text', text: msg }], isError: true };
}

function resolveTarget(file) {
  const abs = path.resolve(file);
  const own = readJournal(abs);
  if (own.records.length) return { file: abs, journal: own, note: null };
  // 该文件没有 journal：找同族里最新的已追踪版本
  const lin = listLineage(abs);
  const tracked = lin.members.filter(m => m.tracked && m.journalSeqMax !== null);
  if (tracked.length) {
    const best = tracked[tracked.length - 1];
    return {
      file: best.file,
      journal: readJournal(best.file),
      note: `\`${displayName(abs)}\` 尚未被追踪；以下展示同族已追踪的最新版本 \`${best.name}\`。`,
    };
  }
  return { file: abs, journal: own, note: null };
}

/**
 * 只有基线、没有任何变更记录时的说明。
 * 这是最容易误导模型的一态：若直接把「0 处改动」喂给模型，它会以为文档没被动过，
 * 而实际上很可能是「新版本文件还没和上一版对照」（示例文档 里 v2.3→v2.4 正是这种情况）。
 */
function buildBaselineNotice(file, slice) {
  if (!slice.length) return null;
  if (slice.some(r => (r.changeCount || 0) > 0)) return null;
  const b = slice[slice.length - 1];
  const ms = b.tsMs ?? Date.parse(b.ts);
  let when = '?';
  if (!Number.isNaN(ms)) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  const lines = ['**该文件已建立基线，但还没有变更记录。**', ''];
  lines.push(`- 基线：${when} · \`${b.sha256 ? String(b.sha256).slice(0, 8) : '????????'}\` · ${b.size ?? '?'} 字节`);
  if (b.summary) lines.push(`- 内容规模：${b.summary.replace(/^建立基线[：:]?\s*/, '')}`);
  lines.push('');
  let members = [];
  try {
    members = listLineage(file).members.filter(m => m.tracked);
  } catch { /* ignore */ }
  if (members.length > 1) {
    lines.push('同族版本（同一文档的多个版本文件，靠文件名区分）：');
    for (const m of members) {
      const tag = m.version ? `v${m.version}` : '—';
      const cur = path.resolve(m.file) === path.resolve(file) ? ' ←当前' : '';
      lines.push(`- ${tag} · \`${m.name}\` · 已记录 ${m.changeCount} 处改动${cur}`);
    }
    lines.push('');
  }
  lines.push('两种可能：①该文件自基线建立后确实没再被保存过；②这是文档族的新版本（如 v2.4），追踪器尚未把它与上一版对照。');
  lines.push('');
  lines.push('若需要确认「相对上一版改了什么」，可调用 `doc_scan` 重建快照，或让维护者执行 `edittrail diff <上一版> <当前版>`（一次结构级 diff，不需要通读全文）。');
  return lines.join('\n');
}

function tool_doc_changes(args) {
  const file = args.file;
  if (!file) return errText('缺少参数 file');
  const t = resolveTarget(file);
  const { journal } = t;
  if (!journal.exists) {
    return errText(
      `没有找到变更记录：\`${journalPath(t.file)}\` 不存在。\n` +
      `请先建立基线：\`node "${path.join(PROJECT_ROOT, 'src', 'cli', 'edittrail.mjs')}" init "${t.file}"\`，` +
      `或启动守护进程 \`edittrail watch <目录>\`。`
    );
  }
  const records = journal.records;
  const rk = readerKey(args.reader);
  const readers = readReaders(t.file);
  const cursor = readers.readers?.[rk] || null;

  let since = args.since;
  let sinceLabel = null;
  if (!since && cursor) {
    if (cursor.seq != null) since = String(cursor.seq);
    else if (cursor.sha256) since = cursor.sha256;
    sinceLabel = cursor.ts ? `上次读取 ${fmtLocal(cursor.ts)}（${String(cursor.sha256 || '').slice(0, 8)}）` : null;
  }
  let slice = records;
  let resolved = null;
  if (since) {
    resolved = resolveSince(records, since);
    if (resolved && resolved.index >= 0) slice = records.slice(resolved.index);
    else if (resolved && resolved.index === -1 && resolved.kind !== 'unknown') slice = [];
    if (!sinceLabel) sinceLabel = resolved ? `since ${resolved.label}` : null;
  }
  if (!since) sinceLabel = '首次读取（展示全部已记录改动）';

  const md = renderChanges({
    file: displayName(t.file),
    records: slice,
    sinceLabel,
    totalRecords: records.length,
    maxChanges: Math.max(1, Math.min(500, args.maxChanges || 40)),
    includeStyle: !!args.includeStyle,
    baselineNotice: buildBaselineNotice(t.file, slice),
  });

  const note = t.note ? `> 注：${t.note}\n\n` : '';
  const bad = journal.badLines ? `\n\n_（journal 有 ${journal.badLines} 行损坏已跳过）_` : '';
  const text = note + md + bad;

  const wantAdvance = args.advance !== false;
  const last = records[records.length - 1];
  let advanced = false;
  if (wantAdvance && last) {
    readers.readers = readers.readers || {};
    readers.readers[rk] = {
      sha256: last.sha256 ?? null,
      seq: last.seq ?? null,
      ts: new Date().toISOString(),
      file: path.basename(t.file),
    };
    const w = writeReaders(t.file, readers);
    advanced = !!w.ok;
  }

  return {
    content: [{ type: 'text', text }],
    structuredContent: {
      file: t.file,
      reader: rk,
      since: resolved ? resolved.label : null,
      advanced,
      records: slice.map(r => ({
        seq: r.seq, ts: r.ts, actor: r.actor, source: r.source, version: r.version ?? null,
        sha256: r.sha256, changeCount: r.changeCount ?? 0, summary: r.summary ?? null,
        changes: (r.changes || []).slice(0, 200),
      })),
    },
  };
}

function tool_doc_trail(args) {
  if (!args.file) return errText('缺少参数 file');
  const t = resolveTarget(args.file);
  if (!t.journal.exists) return errText(`没有找到变更记录：\`${journalPath(t.file)}\` 不存在。`);
  const md = renderTrail({
    file: displayName(t.file),
    records: t.journal.records,
    limit: Math.max(1, Math.min(500, args.limit || 20)),
  });
  return { content: [{ type: 'text', text: (t.note ? `> ${t.note}\n\n` : '') + md }], structuredContent: { records: t.journal.records } };
}

function tool_doc_versions(args) {
  if (!args.file) return errText('缺少参数 file');
  const abs = path.resolve(args.file);
  const lin = listLineage(abs);
  return {
    content: [{ type: 'text', text: renderVersions({ file: displayName(abs), lineage: lin }) }],
    structuredContent: lin,
  };
}

function tool_doc_revisions(args) {
  if (!args.file) return errText('缺少参数 file');
  const abs = path.resolve(args.file);
  if (!fs.existsSync(abs)) return errText(`文件不存在：${abs}`);
  if (!/\.docx$/i.test(abs)) {
    return errText('只有 .docx 有原生修订标记（xlsx/pptx 没有）；这类文档请用 doc_changes 看落盘 diff。');
  }
  const res = extractRevisions(abs);
  const limit = Number(args.limit) > 0 ? Number(args.limit) : 50;
  const lines = renderRevisions(res, { limit });
  const head = `\`${displayName(abs)}\` · ${res.count} 条原生修订`;
  return {
    content: [{ type: 'text', text: `${head}\n\n${lines.join('\n')}` }],
    structuredContent: {
      file: path.basename(abs),
      count: res.count,
      authors: res.authors,
      types: res.types,
      revisions: res.revisions,
    },
  };
}

function findCli() {
  const cands = [
    process.env.EDITTRAIL_CLI,
    path.join(PROJECT_ROOT, 'src', 'cli', 'edittrail.mjs'),
    path.join(PROJECT_ROOT, 'src', 'cli', 'et.mjs'),
    path.join(PROJECT_ROOT, 'src', 'cli', 'index.mjs'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return null;
}

function runCli(cliPath, argv, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...argv], { cwd: PROJECT_ROOT, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -1, out, err: err + '\n(timeout)' });
    }, timeoutMs);
    child.stdout.on('data', d => (out += d.toString('utf8')));
    child.stderr.on('data', d => (err += d.toString('utf8')));
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: err + '\n' + e.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

async function tool_doc_scan(args) {
  if (!args.file) return errText('缺少参数 file');
  const abs = path.resolve(args.file);
  const cli = findCli();
  if (!cli) {
    return errText(`找不到 edittrail CLI（预期在 ${path.join(PROJECT_ROOT, 'src', 'cli', 'edittrail.mjs')}）。可用环境变量 EDITTRAIL_CLI 指定。`);
  }
  const before = readJournal(abs).records.length;
  const r = await runCli(cli, ['watch', abs, '--once', '--actor', args.actor || 'wps-user']);
  if (r.code !== 0) {
    return errText(`扫描失败（exit ${r.code}）：\n${(r.err || r.out || '').slice(0, 2000)}`);
  }
  const j = readJournal(abs);
  if (!j.exists) return errText(`扫描后仍无 journal。CLI 输出：\n${(r.out || '').slice(0, 1000)}`);
  const added = j.records.slice(before);
  if (!added.length) {
    // 没有新记录时不要再把「最近一条记录」当成本次扫描结果贴出来，两句话会互相矛盾。
    const lastRec = j.records[j.records.length - 1];
    const bits = [`**本次扫描没有新的落盘变化**（journal 共 ${j.records.length} 条记录）。`];
    if (lastRec) {
      bits.push(`最近一条是 seq ${lastRec.seq} · ${fmtLocal(lastRec.ts)} · ${lastRec.changeCount ?? 0} 处改动 —— 那是之前记录的，不是这次扫描产生的。`);
    }
    bits.push('若文档刚在 WPS 里改过但还没保存，扫描看不到；保存后再扫一次，或用 `doc_changes` 读已有轨迹。');
    return {
      content: [{ type: 'text', text: bits.join('\n\n') + (r.err ? `\n\n_stderr: ${r.err.slice(0, 400)}_` : '') }],
      structuredContent: { added: 0, records: [] },
    };
  }
  const md = renderChanges({
    file: displayName(abs),
    records: added,
    sinceLabel: '本次扫描前',
    maxChanges: 100,
  });
  return {
    content: [{ type: 'text', text: md + (r.err ? `\n\n_stderr: ${r.err.slice(0, 400)}_` : '') }],
    structuredContent: { added: added.length, records: added },
  };
}

// ─────────────────────────── JSON-RPC ───────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  if (!method) {
    if (id !== undefined) fail(id, -32600, 'Invalid Request');
    return;
  }
  if (id === undefined) return; // notification：不需要响应
  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: (params && params.protocolVersion) || '2024-11-05',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions:
            'edit-trail：文档修改轨迹。处理 xlsx/docx/pptx 前，若用户提到"我自己改过/改了一版"，' +
            '先调 doc_changes 拿变更简报，再做修改；不要重新通读全文做 diff。',
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        let res;
        if (name === 'doc_changes') res = tool_doc_changes(args);
        else if (name === 'doc_trail') res = tool_doc_trail(args);
        else if (name === 'doc_versions') res = tool_doc_versions(args);
        else if (name === 'doc_scan') res = await tool_doc_scan(args);
        else if (name === 'doc_revisions') res = tool_doc_revisions(args);
        else return fail(id, -32602, `Unknown tool: ${name}`);
        return ok(id, res);
      }
      case 'resources/list':
        return ok(id, { resources: [] });
      case 'prompts/list':
        return ok(id, { prompts: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    log('handler error', method, e && e.stack || e);
    return fail(id, -32603, String(e && e.message || e));
  }
}

const inflight = new Set();
function dispatch(msg) {
  const p = handle(msg)
    .catch(e => log('fatal', e && e.stack || e))
    .finally(() => inflight.delete(p));
  inflight.add(p);
}

  let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, '').replace(/^\uFEFF/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log('bad json', line.slice(0, 200));
      continue;
    }
    dispatch(msg);
  }
});
// stdin 关闭时可能还有在途请求（doc_scan 要 spawn 引擎 CLI，比管道关闭慢），
// 先等它们全部回完再退出，否则客户端看到的是「无响应」。
process.stdin.on('end', async () => {
  while (inflight.size) await Promise.allSettled([...inflight]);
  process.stdout.write('', () => process.exit(0));
});
log(`started (root=${PROJECT_ROOT})`);
