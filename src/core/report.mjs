// src/core/report.mjs
// journal → 大模型友好的 markdown 简报。
//
// 目标读者是「下一次读文档的模型」：它不需要知道 OOXML 细节，只需要知道
// 「哪个 sheet 的哪个单元格从什么变成了什么」。所以：
// - 按版本分节（每节一个落盘版本），再按 sheet/章节分组；
// - 每条改动一行，带锚点与前后值；
// - 纯样式差异、整表位移这类噪声在 diff 层就被折叠/抵消了，这里只做展示限额。

import path from 'node:path';
import { readJournal } from './journal.mjs';
import { humanTime } from './paths.mjs';
import { classifyChange } from './diff.mjs';
import { lineageKey, extractVersion } from './lineage.mjs';

export const MAX_LINES_PER_VERSION = 200;
export const MAX_LINES_PER_GROUP = 60;
export const PREVIEW_CHARS = 80;

const GROUP_LABEL = {
  structure: '结构',
  text: '文本',
  chart: '图表',
  other: '样式/其他',
};

function focusOf(change) {
  if (change.sheet) return change.sheet;
  const anchor = String(change.anchor || '');
  if (anchor.startsWith('para:')) return '正文段落';
  if (anchor.startsWith('table:')) return '表格';
  if (anchor.startsWith('slide:')) return '幻灯片';
  if (anchor.startsWith('chart:')) return '图表';
  if (anchor.startsWith('media:')) return '图片/媒体';
  const bang = anchor.split('!')[0];
  return bang || '其他';
}

/** 值 → 行内代码，去掉换行、限长；null/空单独标注。 */
export function previewValue(value, opts = {}) {
  if (value === null || value === undefined) return null;
  const max = opts.max ?? PREVIEW_CHARS;
  let s = String(value).replace(/\r?\n/g, '⏎');
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max) + '…';
  return '`' + s.replace(/`/g, 'ˋ') + '`';
}

/** 单条 change → 一行 markdown。 */
export function renderChangeLine(change) {
  const before = previewValue(change.before);
  const after = previewValue(change.after);
  const anchor = change.anchor || '?';
  const tag = change.styleChanged ? '〔含样式〕' : '';
  if (change.kind.endsWith('.added') || (before === null && after !== null)) {
    return `- \`${anchor}\` 新增：${after || '（空）'}${tag}`;
  }
  if (change.kind.endsWith('.removed') || (after === null && before !== null)) {
    return `- \`${anchor}\` 删除：${before || '（空）'}${tag}`;
  }
  if (change.kind === 'style.changed') {
    return `- \`${anchor}\` 样式：${before || '—'} → ${after || '—'}`;
  }
  return `- \`${anchor}\`：${before || '（空）'} → ${after || '（空）'}${tag}`;
}

/** 统计一段 changes 的分类计数（结构/文本/图表/其他）。 */
export function groupCounts(changes) {
  const out = { structure: 0, text: 0, chart: 0, other: 0 };
  for (const c of changes) out[classifyChange(c.kind)]++;
  return out;
}

export function formatGroupCounts(counts) {
  return Object.entries(counts)
    .filter(([, n]) => n)
    .map(([k, n]) => `${GROUP_LABEL[k] || k} ${n}`)
    .join(' / ');
}

/**
 * 渲染一段 changes（按 focus 分组 + 限额折叠）。
 * @returns {string[]} markdown 行
 */
export function renderChangeGroups(changes, opts = {}) {
  const maxPerGroup = opts.maxPerGroup ?? MAX_LINES_PER_GROUP;
  const maxLines = opts.maxLines ?? MAX_LINES_PER_VERSION;
  const groups = new Map();
  for (const c of changes) {
    const key = focusOf(c);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const lines = [];
  let emitted = 0;
  for (const [group, items] of ordered) {
    if (emitted >= maxLines) {
      const rest = ordered.reduce((n, [, list]) => n + list.length, 0) - emitted;
      if (rest > 0) lines.push(`- …其余 ${rest} 条改动已折叠`);
      break;
    }
    lines.push(`### ${group}（${items.length} 处）`);
    const room = Math.min(items.length, maxPerGroup, maxLines - emitted);
    for (const c of items.slice(0, room)) {
      lines.push(renderChangeLine(c));
      emitted++;
    }
    if (items.length > room) {
      const kinds = new Map();
      for (const c of items.slice(room)) kinds.set(c.kind, (kinds.get(c.kind) || 0) + 1);
      const desc = [...kinds.entries()].map(([k, n]) => `${k} × ${n}`).join('、');
      lines.push(`- …另有 ${items.length - room} 条同类改动（${desc}）`);
    }
    lines.push('');
  }
  return lines;
}

/** 版本标题：`## v2.4 2026-01-14 09:00 · actor=wps-user`。 */
function versionHeading(record, file) {
  const ver = extractVersion(file);
  const label = record.prevSha256 === null ? '基线' : ver ? `v${ver}` : `seq ${record.seq}`;
  let ts = record.ts;
  try { ts = humanTime(new Date(record.tsMs ?? record.ts)); } catch { /* 用原字符串 */ }
  return `## ${label} ${ts} · actor=${record.actor || 'unknown'} · source=${record.source || 'unknown'} · seq ${record.seq}`;
}

/**
 * 按 since 过滤记录（since = seq 数字或 sha 前缀）。
 * 语义：返回「该版本之后」的记录；数字为 seq，sha 为其所在记录。
 */
export function selectRecords(records, since) {
  if (since === undefined || since === null || since === '') return records;
  const s = String(since).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return records.filter((r) => (Number(r.seq) || 0) > n);
  }
  const idx = records.findIndex((r) => String(r.sha256 || '').startsWith(s));
  if (idx < 0) return records;
  return records.slice(idx + 1);
}

/**
 * 渲染完整变更简报。
 *
 * @param {string} file 文档路径
 * @param {object} [opts]
 * @param {string|number} [opts.since] 只看这之后的记录
 * @param {string} [opts.title] 覆盖标题里的文件名
 * @returns {{markdown:string, records:Array, selected:Array, counts:object}}
 */
export function renderReport(file, opts = {}) {
  const abs = path.resolve(file);
  const journal = readJournal(abs);
  const selected = selectRecords(journal.records, opts.since);
  const name = opts.title || path.basename(abs);
  const allChanges = selected.flatMap((r) => (Array.isArray(r.changes) ? r.changes : []));
  const counts = groupCounts(allChanges);
  const totalChanges = selected.reduce((n, r) => n + (Number(r.changeCount) || 0), 0);

  const lines = [];
  lines.push(`# 变更简报 · ${name}`);
  lines.push('');
  lines.push(`> 文档族：${lineageKey(name)} · 记录 ${selected.length}/${journal.records.length} 版 · 改动 ${totalChanges} 处${journal.badLines ? ` · 损坏行 ${journal.badLines}` : ''}`);
  // 旧格式是「先转 OOXML 再比结构」，不说明一下会让人以为引擎直接读了 .doc
  const legacy = selected.find((r) => r.sourceFormat);
  if (legacy) {
    const converted = legacy.convertedBytes ? `，转换后 ${Math.round(legacy.convertedBytes / 1024)} KB` : '';
    lines.push(`> 源格式：.${legacy.sourceFormat}（已转成 ${legacy.docType} 比较${converted}；sha256 记的是源文件）`);
  }
  if (totalChanges) lines.push(`> 本次共 ${totalChanges} 处实质改动：${formatGroupCounts(counts)}`);
  lines.push('');

  if (!selected.length) {
    lines.push(journal.exists ? '（该范围内没有变更记录）' : '（尚未建立基线：先运行 `edittrail init <file>` 或 `edittrail watch <file>`）');
    return { markdown: lines.join('\n') + '\n', records: journal.records, selected, counts, totalChanges };
  }

  for (const record of selected) {
    lines.push(versionHeading(record, abs));
    if (record.summary) lines.push('');
    if (record.summary) lines.push(`> ${record.summary}`);
    if (record.lineageFrom) {
      const from = record.lineageFrom;
      lines.push(`> 前驱快照：${from.file}${from.version ? `（v${from.version}）` : ''}${from.sha256 ? ` · ${String(from.sha256).slice(0, 8)}` : ''}`);
    }
    lines.push('');
    const changes = Array.isArray(record.changes) ? record.changes : [];
    if (!changes.length) {
      lines.push('（这一版没有记录到实质改动）');
      lines.push('');
      continue;
    }
    lines.push(...renderChangeGroups(changes));
    if (record.truncated) lines.push(`- （记录本身已截断：共 ${record.totalChanges} 处，journal 只保留前 ${changes.length} 条）`);
    lines.push('');
  }
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', records: journal.records, selected, counts, totalChanges };
}

/** 一次性 diff 的 markdown（`edittrail diff a b --md`）。 */
export function renderDiffMarkdown(aFile, bFile, result, opts = {}) {
  const nameA = path.basename(aFile);
  const nameB = path.basename(bFile);
  const lines = [`# 差异简报 · ${nameA} → ${nameB}`, ''];
  const total = result.totalChanges ?? result.changes.length;
  if (!total) {
    lines.push(`> 两份文件没有实质结构/文本差异${result.stats && result.stats.movedCells ? `（${result.stats.movedCells} 个单元格整体搬移，未计入）` : ''}。`);
    return lines.join('\n') + '\n';
  }
  lines.push(`> 共 ${total} 处实质改动：${formatGroupCounts(groupCounts(result.changes))}`);
  if (result.stats) {
    const s = result.stats;
    const bits = [];
    if (s.rowsAdded || s.rowsRemoved) bits.push(`行增删 ${s.rowsAdded || 0}/${s.rowsRemoved || 0}`);
    if (s.sheetsAdded || s.sheetsRemoved || s.sheetsRenamed) bits.push(`sheet +${s.sheetsAdded || 0}/-${s.sheetsRemoved || 0}/改名 ${s.sheetsRenamed || 0}`);
    if (s.movedCells) bits.push(`整体搬移 ${s.movedCells} cell`);
    if (s.styleOnly) bits.push(`纯样式 ${s.styleOnly} 处（已折叠）`);
    if (bits.length) lines.push(`> ${bits.join(' · ')}`);
  }
  lines.push('');
  lines.push(...renderChangeGroups(result.changes, opts));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
