#!/usr/bin/env node
// src/cli/edittrail.mjs
// edit-trail 命令行。核心逻辑全部在 src/core/，这里只做参数解析、打印与进程控制，
// 所以同一个引擎既可以被 WPS 加载项调用，也可以被 MCP server / 守护进程调用。

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, saveSnapshot } from '../core/snapshot.mjs';
import { diffSnapshots } from '../core/diff.mjs';
import { readJournal, recordVersion } from '../core/journal.mjs';
import { ensureInitialRecord } from '../core/initial.mjs';
import { renderReport, renderDiffMarkdown } from '../core/report.mjs';
import { renderChangeLine } from '../core/report.mjs';
import { buildLineage, extractVersion } from '../core/lineage.mjs';
import { startWatch, watchOnce } from '../core/watch.mjs';
import { humanTime, RECORDS_DIRNAME, LEGACY_RECORDS_DIRNAMES, newEdittrailDir } from '../core/paths.mjs';
import { migrateDocDir } from '../core/journal.mjs';
import { extractRevisions, renderRevisions } from '../core/revisions.mjs';
import { comConverter, isLegacyDoc, legacyTypeOf, siblingTarget } from '../core/legacy.mjs';

const USAGE = `edit-trail：把「文档落盘」变成「可被模型读懂的变更日志」

用法：
  edittrail snapshot <file> [-o out.json] [--json]
      解析 xlsx/docx/pptx，输出结构化快照（默认打印摘要，-o 写文件）

  edittrail diff <a> <b> [--json] [--md [out.md]] [--no-content]
      两份同类型文档的结构化差异；--json 输出契约格式

  edittrail init <file> [--force]
      给一份文档建基线（写 journal 第一条 + snapshot.json）

  edittrail watch <dir|file> [--interval 1500] [--once] [--recursive] [--actor wps-user]
      观察落盘；启动时先为已有文档建基线，之后每次稳定落盘记一条 journal
      --recursive 递归子目录（默认只看目录这一层）

  edittrail report <file> [--since <seq|sha>] [--md [out.md]] [--json]
      渲染大模型友好的 markdown 变更简报

  edittrail lineage <file>
      扫描同目录同族版本，写 <dir>/revision history/<file>.edittrail/lineage.json 并打印版本序列表

  edittrail migrate [dir] [--dry]
      把旧布局 <文档>.edittrail/ 搬进 <目录>/revision history/（默认当前目录，递归；--dry 只看不做）

  edittrail convert <dir|file> [--recursive] [--force] [--dry]
      把 .doc/.xls/.ppt 另存为同目录同名 OOXML（靠本机 WPS COM）；
      --recursive 递归子目录，--force 覆盖已存在的目标，--dry 只看不做

  edittrail revisions <file.docx> [--limit 50] [--json]
      读 docx 原生修订（w:ins / w:del + 作者 + 时间），回答「谁改的」；
      仅当编辑时开了「修订」模式才有记录，否则提示回落到 diff/journal

通用选项：
  --actor <wps-user|model|script|unknown>   默认 unknown
  --source <watcher|addin|cli|manual>       默认 cli
  -h, --help
`;

function parseArgs(argv) {
  const args = [];
  const flags = new Map();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { flags.set('help', true); continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'md' || key === 'o') {
        // 可选值：后面紧跟的不是 flag 就当作输出路径
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) { flags.set(key, next); i++; } else flags.set(key, true);
        continue;
      }
      if (['json', 'once', 'no-content', 'force', 'md', 'quiet'].includes(key)) { flags.set(key, true); continue; }
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) { flags.set(key, next); i++; } else flags.set(key, true);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && a !== '-') {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (key === 'o' && next && !next.startsWith('-')) { flags.set(key, next); i++; } else flags.set(key, true);
      continue;
    }
    args.push(a);
  }
  return { args, flags };
}

function die(msg, code = 1) {
  process.stderr.write(`edittrail: ${msg}\n`);
  process.exit(code);
}

function needFile(file) {
  if (!file) die('缺少文件路径（-h 看用法）', 2);
  if (!fs.existsSync(file)) die(`文件不存在：${file}`);
  return path.resolve(file);
}

function printSummaryLine(rec) {
  if (!rec) {
    process.stdout.write('未变：内容与上一条记录相同，未追加\n');
    return;
  }
  const ts = (() => { try { return humanTime(new Date(rec.tsMs ?? rec.ts)); } catch { return rec.ts; } })();
  const lineage = rec.lineageFrom ? `（前驱 ${rec.lineageFrom.file}）` : '';
  process.stdout.write(`seq ${rec.seq} · ${ts} · ${rec.changeCount} 处改动${lineage} · ${rec.summary}\n`);
}

// ------------------------------------------------------------------ 命令

function cmdSnapshot(args, flags) {
  const file = needFile(args[0]);
  const built = buildSnapshot(file);
  const payload = {
    file: built.name,
    docType: built.docType,
    size: built.size,
    mtime: built.mtime,
    sha256: built.sha256,
    snapshot: built.snapshot,
  };
  const out = flags.get('o');
  if (out && out !== true) {
    saveSnapshot(built, { path: path.resolve(out) });
    process.stdout.write(`快照已写入 ${path.resolve(out)}（${built.docType}，sha256 ${built.sha256.slice(0, 12)}…）\n`);
    return 0;
  }
  if (flags.get('json')) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    return 0;
  }
  process.stdout.write(`${built.name}\n  类型 ${built.docType} · ${built.size} 字节 · ${built.mtime}\n  sha256 ${built.sha256}\n`);
  const s = built.snapshot;
  if (built.docType === 'xlsx') {
    process.stdout.write(`  ${s.sheetCount} 个 sheet：${s.sheets.map((x) => x.name).join(' · ')}\n`);
    const cells = s.sheets.reduce((n, x) => n + Object.keys(x.cells).length, 0);
    process.stdout.write(`  ${cells} 个非空单元格 · ${s.charts.length} 个图表 · ${s.media.length} 个媒体\n`);
  } else if (built.docType === 'docx') {
    process.stdout.write(`  ${s.paragraphCount} 个正文段落 · ${s.tables.length} 个表格 · 修订 ins/del=${s.trackChanges.ins}/${s.trackChanges.del}\n`);
  } else {
    process.stdout.write(`  ${s.slideCount} 页幻灯片\n`);
  }
  return 0;
}

function cmdDiff(args, flags) {
  const a = needFile(args[0]);
  const b = needFile(args[1]);
  const sa = buildSnapshot(a);
  const sb = buildSnapshot(b);
  if (sa.docType !== sb.docType) die(`两份文件类型不同：${sa.docType} vs ${sb.docType}`, 2);
  const result = diffSnapshots(sa.snapshot, sb.snapshot, { noContent: !!flags.get('no-content') });
  const payload = {
    a: { sha256: sa.sha256, size: sa.size },
    b: { sha256: sb.sha256, size: sb.size },
    docType: sa.docType,
    changes: result.changes,
    counts: result.counts,
  };
  if (flags.get('json')) {
    process.stdout.write(JSON.stringify({ ...payload, totalChanges: result.totalChanges, truncated: !!result.truncated }, null, 2) + '\n');
    return 0;
  }
  const md = renderDiffMarkdown(a, b, result);
  const mdOut = flags.get('md');
  if (mdOut && mdOut !== true) {
    fs.writeFileSync(path.resolve(mdOut), md, 'utf8');
    process.stdout.write(`差异简报已写入 ${path.resolve(mdOut)}（${result.totalChanges} 处改动）\n`);
    return 0;
  }
  process.stdout.write(md);
  return 0;
}

function cmdInit(args, flags) {
  const file = needFile(args[0]);
  const res = ensureInitialRecord(file, {
    force: !!flags.get('force'),
    actor: flags.get('actor') || 'unknown',
    source: 'cli',
  });
  if (res.action === 'exists') {
    process.stdout.write(`${path.basename(file)} 已有基线，未改动（force 可重建）\n`);
    if (res.record) printSummaryLine(res.record);
    return 0;
  }
  if (res.predecessor) {
    const p = res.predecessor;
    process.stdout.write(
      `同族前驱：${p.file}（${p.hasSnapshot ? '有快照' : '无快照，无法跨版本 diff'}）\n`,
    );
  }
  printSummaryLine(res.record);
  return 0;
}

function cmdWatch(args, flags) {
  const target = args[0] ? path.resolve(args[0]) : process.cwd();
  if (!fs.existsSync(target)) die(`目标不存在：${target}`);
  const actor = flags.get('actor') || 'wps-user';
  const opts = {
    actor,
    baseline: true,
    recursive: !!flags.get('recursive'),
    logger: {
      info: (m) => process.stdout.write(`  · ${m}\n`),
      warn: (m) => process.stderr.write(`  ! ${m}\n`),
    },
  };
  const report = (res) => {
    for (const b of res.baselined) {
      const tag = b.lineageFrom ? '[跨版本]' : '[基线]';
      const from = b.lineageFrom ? `（前驱 ${b.lineageFrom.file}）` : '';
      process.stdout.write(`${tag} ${path.basename(b.file)} → seq ${b.seq}${from}：${b.summary || ''}\n`);
    }
    for (const r of res.recorded) {
      process.stdout.write(`[变更] ${path.basename(r.file)} → seq ${r.seq}，${r.changeCount} 处：${r.summary}\n`);
    }
    for (const p of res.pending) process.stdout.write(`[等待落盘稳定] ${path.basename(p.file)}\n`);
    for (const e of res.errors) process.stderr.write(`[错误] ${path.basename(e.file)}: ${e.error}\n`);
  };

  if (flags.get('once')) {
    const res = watchOnce(target, { ...opts, requireStable: false });
    report(res);
    process.stdout.write(`扫描完成：${res.docs} 个文档，基线 ${res.baselined.length}，记录 ${res.recorded.length}，未变 ${res.unchanged}，错误 ${res.errors.length}\n`);
    return res.errors.length ? 1 : 0;
  }

  const intervalMs = Number(flags.get('interval')) || 1500;
  process.stdout.write(`观察 ${target}（每 ${intervalMs}ms，actor=${actor}）… Ctrl+C 退出\n`);
  const watcher = startWatch(target, {
    ...opts,
    intervalMs,
    onTick: report,
    onError: (e) => process.stderr.write(`[错误] ${e.message}\n`),
  });
  const stop = () => {
    watcher.stop();
    process.stdout.write('\n已停止观察。\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return null; // 不退出：交给事件循环
}

function cmdReport(args, flags) {
  const file = needFile(args[0]);
  const res = renderReport(file, { since: flags.get('since') });
  if (flags.get('json')) {
    process.stdout.write(JSON.stringify({
      file: path.basename(file),
      records: res.selected.length,
      totalChanges: res.totalChanges,
      counts: res.counts,
      markdown: res.markdown,
    }, null, 2) + '\n');
    return 0;
  }
  const mdOut = flags.get('md');
  if (mdOut && mdOut !== true) {
    fs.writeFileSync(path.resolve(mdOut), res.markdown, 'utf8');
    process.stdout.write(`简报已写入 ${path.resolve(mdOut)}（${res.totalChanges} 处改动）\n`);
    return 0;
  }
  process.stdout.write(res.markdown);
  return 0;
}

function cmdLineage(args, flags) {
  const file = needFile(args[0]);
  const res = buildLineage(file);
  process.stdout.write(`文档族：${res.lineageId}（${res.members.length} 个版本）\n`);
  for (const m of res.members) {
    const mark = m.file === path.basename(file) ? '→' : ' ';
    const ver = m.version ? `v${m.version}` : '无版本号';
    const track = m.tracked ? `journal ${m.journalSeqMax}` : '未跟踪';
    process.stdout.write(`${mark} ${ver.padEnd(12)} ${String(m.size).padStart(9)}B  ${m.mtime}  ${track}  ${m.file}\n`);
  }
  process.stdout.write(`已写入 ${res.path}\n`);
  return 0;
}

function cmdRevisions(args, flags) {
  const file = needFile(args[0]);
  const res = extractRevisions(file);
  if (flags.get('json')) {
    process.stdout.write(JSON.stringify({ file: path.basename(file), ...res }, null, 2) + '\n');
    return 0;
  }
  const limit = Number(flags.get('limit') || 50);
  for (const line of renderRevisions(res, { limit: Number.isFinite(limit) ? limit : 50 })) {
    process.stdout.write(`${line}\n`);
  }
  return 0;
}

// ------------------------------------------------------------------ migrate

function collectLegacyDirs(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(dir, e.name);
      if (e.name.endsWith('.edittrail')) {
        const parentName = path.basename(dir);
        if (parentName === RECORDS_DIRNAME) continue;
        // 中间布局：<dir>/revised record/<doc>.edittrail → 文档在上一级
        const docFile = LEGACY_RECORDS_DIRNAMES.includes(parentName)
          ? path.join(path.dirname(dir), path.basename(full).slice(0, -'.edittrail'.length))
          : full.slice(0, -'.edittrail'.length);
        out.push({ dir: full, docFile, fromRecordsDir: LEGACY_RECORDS_DIRNAMES.includes(parentName) });
        continue;
      }
      if (e.name === RECORDS_DIRNAME) continue;
      walk(full);
    }
  };
  walk(path.resolve(root));
  return out;
}

function cmdMigrate(args, flags) {
  const root = args[0] ? path.resolve(args[0]) : process.cwd();
  if (!fs.existsSync(root)) die(`目录不存在：${root}`, 2);
  const legacy = collectLegacyDirs(root);
  if (!legacy.length) {
    process.stdout.write(`没有旧布局的 .edittrail 目录（${root}）\n`);
    return 0;
  }
  const dry = !!flags.get('dry');
  let moved = 0;
  for (const item of legacy) {
    const to = newEdittrailDir(item.docFile);
    if (dry) {
      process.stdout.write(`[dry] ${path.relative(root, item.dir)} → ${path.relative(root, to)}\n`);
      continue;
    }
    const res = migrateDocDir(item.docFile);
    if (res.moved) {
      moved++;
      process.stdout.write(`[搬到] ${path.relative(root, to)}\n`);
    }
  }
  if (!dry) removeEmptyLegacyRecordDirs(root);
  process.stdout.write(`共 ${legacy.length} 个旧目录，搬迁 ${moved} 个到 ${RECORDS_DIRNAME}/\n`);
  return 0;
}

/** 迁移后清掉空的中间布局目录（只删空目录，非空一律不动）。 */function removeEmptyLegacyRecordDirs(root) {
  for (const name of LEGACY_RECORDS_DIRNAMES) {
    const dirs = [];
    const walk = (dir) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (!e.isDirectory() || e.name === 'node_modules' || e.name === '.git') continue;
        const full = path.join(dir, e.name);
        if (e.name === name) dirs.push(full);
        else walk(full);
      }
    };
    walk(path.resolve(root));
    for (const dir of dirs) {
      try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
    }
  }
}

function collectLegacyFiles(root, recursive) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      if (e.name === RECORDS_DIRNAME || LEGACY_RECORDS_DIRNAMES.includes(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (recursive && depth < 12) walk(full, depth + 1);
        continue;
      }
      if (e.isFile() && isLegacyDoc(full)) out.push(full);
    }
  };
  walk(path.resolve(root), 0);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function cmdConvert(args, flags) {
  const target = args[0] ? path.resolve(args[0]) : process.cwd();
  if (!fs.existsSync(target)) die(`路径不存在：${target}`, 2);
  const dry = !!flags.get('dry');
  const force = !!flags.get('force');
  const stat = fs.statSync(target);
  const files = stat.isDirectory() ? collectLegacyFiles(target, !!flags.get('recursive')) : [target];
  if (!files.length) {
    process.stdout.write(`没有可转换的旧格式文件（${target}）\n`);
    return 0;
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const dst = siblingTarget(file);
    const rel = path.relative(target, file) || path.basename(file);
    if (!dst) { skipped++; continue; }
    if (fs.existsSync(dst) && !force) {
      skipped++;
      process.stdout.write(`[跳过] ${rel}（目标已存在：${path.basename(dst)}）\n`);
      continue;
    }
    if (dry) {
      process.stdout.write(`[dry] ${rel} → ${path.basename(dst)}\n`);
      continue;
    }
    const t0 = Date.now();
    try {
      const tmp = path.join(path.dirname(dst), `.convert-${process.pid}-${Date.now()}${path.extname(dst)}`);
      comConverter({ kind: legacyTypeOf(file), src: file, dst: tmp });
      fs.renameSync(tmp, dst);
      done++;
      process.stdout.write(`[转换] ${rel} → ${path.basename(dst)}（${((Date.now() - t0) / 1000).toFixed(1)}s）\n`);
    } catch (e) {
      failed++;
      try { for (const f of fs.readdirSync(path.dirname(dst))) if (f.startsWith(`.convert-${process.pid}-`) && f.endsWith(path.extname(dst))) fs.unlinkSync(path.join(path.dirname(dst), f)); } catch {}
      process.stdout.write(`[失败] ${rel}：${e && e.message ? e.message : e}\n`);
    }
  }
  process.stdout.write(`共 ${files.length} 个旧格式文件：转换 ${done}，跳过 ${skipped}，失败 ${failed}\n`);
  return failed ? 1 : 0;
}

// ------------------------------------------------------------------ main

function main(argv) {
  const { args, flags } = parseArgs(argv);
  const cmd = args.shift();
  if (!cmd || flags.get('help') || cmd === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  switch (cmd) {
    case 'snapshot': return cmdSnapshot(args, flags);
    case 'diff': return cmdDiff(args, flags);
    case 'init': return cmdInit(args, flags);
    case 'watch': return cmdWatch(args, flags);
    case 'report': return cmdReport(args, flags);
    case 'lineage': return cmdLineage(args, flags);
    case 'revisions': return cmdRevisions(args, flags);
    case 'migrate': return cmdMigrate(args, flags);
    case 'convert': return cmdConvert(args, flags);
    default:
      die(`未知命令：${cmd}（-h 看用法）`, 2);
  }
}

const isEntry = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  } catch {
    return false;
  }
})();

if (isEntry) {
  try {
    const code = main(process.argv.slice(2));
    if (typeof code === 'number') process.exitCode = code;
  } catch (e) {
    process.stderr.write(`edittrail: ${e && e.stack ? e.stack : e}\n`);
    process.exitCode = 1;
  }
}

export { main, parseArgs };
