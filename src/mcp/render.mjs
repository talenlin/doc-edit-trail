// edit-trail · 面向大模型的「变更简报」渲染（markdown）
// 目标：模型读完 200 字就知道「哪里被改过、改成什么」，而不是自己去 diff。
import path from 'node:path';

const KIND_LABEL = {
  'cell.changed': '改值',
  'cell.added': '新增单元格',
  'cell.removed': '删除单元格',
  'formula.changed': '改公式',
  'sheet.added': '新增 sheet',
  'sheet.removed': '删除 sheet',
  'sheet.renamed': 'sheet 改名',
  'sheet.moved': 'sheet 移位',
  'merge.changed': '合并单元格变化',
  'pagebreak.changed': '分页符变化',
  'row.height': '行高变化',
  'row.hidden': '行显隐变化',
  'col.width': '列宽变化',
  'chart.changed': '图表变化',
  'media.changed': '图片/媒体变化',
  'style.changed': '样式变化',
  'para.changed': '改段落',
  'para.added': '新增段落',
  'para.removed': '删除段落',
  'table.changed': '表格变化',
  'heading.level': '标题级别变化',
  'slide.added': '新增页',
  'slide.removed': '删除页',
  'slide.changed': '页面变化',
  'shape.text.changed': '形状文本变化',
  'doc.version.created': '新建版本',
};

const ACTOR_LABEL = {
  'wps-user': '用户手改（WPS）',
  'model': '模型写回',
  'script': '脚本生成',
  'unknown': '未知来源',
};

export function kindLabel(k) {
  return KIND_LABEL[k] || k;
}

export function actorLabel(a) {
  return ACTOR_LABEL[a] || a || '未知来源';
}

function fmtTime(r) {
  const ms = r.tsMs ?? (r.ts ? Date.parse(r.ts) : NaN);
  if (Number.isNaN(ms)) return r.ts || '?';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(iso) {
  const ms = iso instanceof Date ? iso.getTime() : Date.parse(iso);
  if (Number.isNaN(ms)) return String(iso || '?');
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// journal 不存 version 字段，版本号从文件名里取（这正是实测中的常见情况：版本靠文件名区分）
// 注意不能用 \bv：文件名里是 `_v2.4`，下划线也属于 \w，`\b` 在 `_v` 之间不成立。
function versionOfName(name) {
  const s = String(name || '');
  const m = /[_\-\s（(][vV](\d+(?:\.\d+)*)/.exec(s) || /[vV](\d+(?:\.\d+)*)/.exec(s);
  return m ? `v${m[1]}` : null;
}

function sha8(s) {
  return s ? String(s).slice(0, 8) : '????????';
}

function quote(v, max = 60) {
  if (v === undefined || v === null) return '∅';
  let s = String(v).replace(/\r?\n/g, ' ⏎ ');
  if (s.length > max) s = s.slice(0, max) + '…';
  return s === '' ? '（空）' : s;
}

function summarizeCounts(counts) {
  if (!counts || typeof counts !== 'object') return '';
  // 与 src/core/diff.mjs 的 classifyChange 同口径（MCP 侧不 import 引擎内部，保持口径副本）
  const cls = (kind) => {
    if (/^(sheet\.|merge\.|row\.|col\.|pagebreak\.|slide\.(added|removed)|doc\.version)/.test(kind)) return 'structure';
    if (/^(cell\.|para\.|table\.|formula\.|shape\.|heading\.|slide\.changed)/.test(kind)) return 'text';
    if (/^(chart\.|media\.)/.test(kind)) return 'chart';
    return 'other';
  };
  const groups = { structure: 0, text: 0, chart: 0, other: 0 };
  for (const [k, n] of Object.entries(counts)) groups[cls(k)] += n;
  const label = { structure: '结构', text: '文本', chart: '图表', other: '样式/其他' };
  return Object.entries(groups).filter(([, n]) => n > 0).map(([g, n]) => `${label[g]} ${n}`).join(' / ');
}

/** 单条 change → 一行 markdown */
export function changeLine(c) {
  const anchor = c.anchor || [c.sheet, c.cell].filter(Boolean).join('!') || '?';
  const label = kindLabel(c.kind);
  if (c.kind === 'cell.changed' || c.kind === 'para.changed' || c.kind === 'shape.text.changed' || c.kind === 'cell.added' || c.kind === 'cell.removed' || c.kind === 'para.added' || c.kind === 'para.removed') {
    const before = c.before !== undefined ? quote(c.before) : (c.beforeFull !== undefined ? quote(c.beforeFull) : '∅');
    const after = c.after !== undefined ? quote(c.after) : (c.afterFull !== undefined ? quote(c.afterFull) : '∅');
    const delta = typeof c.charDelta === 'number' && c.charDelta !== 0 ? `（${c.charDelta > 0 ? '+' : ''}${c.charDelta} 字）` : '';
    return `- \`${anchor}\` ${label}：\`${before}\` → \`${after}\`${delta}`;
  }
  if (c.kind === 'sheet.renamed') return `- ${label}：\`${quote(c.before, 30)}\` → \`${quote(c.after, 30)}\``;
  if (c.kind === 'chart.changed' || c.kind === 'media.changed') return `- \`${anchor}\` ${label}${c.after ? `：${quote(c.after, 80)}` : ''}`;
  if (c.kind === 'style.changed') return `- \`${anchor}\` ${label}${c.after ? `：${quote(c.after, 40)}` : ''}`;
  if (c.before !== undefined || c.after !== undefined) return `- \`${anchor}\` ${label}：\`${quote(c.before, 40)}\` → \`${quote(c.after, 40)}\``;
  return `- \`${anchor}\` ${label}`;
}

/**
 * 渲染变更简报。
 * @param {object} opt {file, records, sinceLabel, maxChanges, includeStyle, totalRecords, baselineNotice}
 */
export function renderChanges(opt) {
  const { file, records, sinceLabel, maxChanges = 40, includeStyle = false, totalRecords = 0, baselineNotice = null } = opt;
  const lines = [];
  const shown = records.filter(r => (r.changeCount || 0) > 0);
  const allChanges = [];
  for (const r of shown) for (const c of r.changes || []) allChanges.push({ ...c, __rec: r });

  const total = allChanges.length;
  const kindCounts = {};
  for (const c of allChanges) kindCounts[c.kind] = (kindCounts[c.kind] || 0) + 1;

  lines.push(`# 变更简报 · ${file}`);
  lines.push('');
  if (!records.length) {
    if (sinceLabel && totalRecords > 0) {
      lines.push(`_自 ${sinceLabel} 以来没有新的落盘改动（journal 共 ${totalRecords} 条记录）。文档内容与上次读取一致，无需重新 diff。_`);
    } else {
      lines.push('_没有找到变更记录。可能还没建立基线，或该文档未被监听。_');
    }
    return lines.join('\n');
  }
  if (!shown.length && baselineNotice) {
    lines.push(baselineNotice);
    return lines.join('\n').trim() + '\n';
  }
  const last = records[records.length - 1];
  const first = records[0];
  const lin = last.lineageFrom || first.lineageFrom || null;
  if (lin) {
    lines.push(`> 对照版本：${lin.version ? 'v' + String(lin.version).replace(/^v/, '') : '?'}（${lin.file || '同族前一版'}）→ 当前文件`);
  }
  lines.push(`> 自 ${first && sinceLabel ? `${sinceLabel}` : `${fmtTime(first)}（${sha8(first.sha256)}）`} 以来：${shown.length} 次落盘，${total} 处实质改动。`);
  const head = [];
  if (last.prevSha256 || first.sha256) head.push(`当前 ${sha8(last.sha256)} · ${fmtTime(last)}`);
  const summary = summarizeCounts(kindCounts);
  if (summary) head.push(`构成：${summary}`);
  if (head.length) lines.push(`> ${head.join(' · ')}`);
  lines.push('');

  // 一句话结论：优先用引擎给的 summary
  const summaries = shown.map(r => r.summary).filter(Boolean);
  if (summaries.length) {
    lines.push(`**摘要**：${summaries.slice(-3).join('；')}`);
    lines.push('');
  }

  const visible = allChanges.filter(c => includeStyle || c.kind !== 'style.changed');
  const hiddenStyle = total - visible.length;

  // 按版本分节
  let count = 0;
  for (const r of shown) {
    const cs = (r.changes || []).filter(c => includeStyle || c.kind !== 'style.changed');
    if (!cs.length) continue;
    const linFrom = r.lineageFrom ? `（对照 ${r.lineageFrom.version ? 'v' + String(r.lineageFrom.version).replace(/^v/, '') : r.lineageFrom.file}）` : '';
    const hiddenHere = (r.changes || []).length - cs.length;
    const styleNote = hiddenHere > 0 ? `（另 ${hiddenHere} 处样式）` : '';
    lines.push(`## ${fmtTime(r)} · ${actorLabel(r.actor)} · ${cs.length} 处${styleNote}${linFrom}${r.version ? ` · v${String(r.version).replace(/^v/, '')}` : ''}`);
    for (const c of cs) {
      if (count >= maxChanges) break;
      lines.push(changeLine(c));
      count++;
    }
    if (count >= maxChanges) {
      lines.push(`- …（还有 ${Math.max(0, visible.length - maxChanges)} 处未展开，可用 maxChanges 调大）`);
      break;
    }
    lines.push('');
  }
  if (hiddenStyle > 0) {
    lines.push(`_（另有 ${hiddenStyle} 处纯样式变化未展开，需要时传 includeStyle=true）_`);
  }
  return lines.join('\n').trim() + '\n';
}

/** 时间线：每次落盘一行 */
export function renderTrail(opt) {
  const { file, records, limit = 20 } = opt;
  const lines = [`# 落盘时间线 · ${file}`, ''];
  if (!records.length) {
    lines.push('_无记录_');
    return lines.join('\n');
  }
  const rows = records.slice(-limit);
  lines.push('| seq | 时间 | 版本 | 来源 | 改动 | sha |');
  lines.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.seq ?? '?'} | ${fmtTime(r)} | ${r.version ? 'v' + String(r.version).replace(/^v/, '') : (versionOfName(r.file) || '—')} | ${actorLabel(r.actor)}/${r.source || '—'} | ${r.changeCount ?? 0} | ${sha8(r.sha256)} |`);
  }
  if (records.length > rows.length) lines.push('', `_（共 ${records.length} 条，仅显示最近 ${rows.length} 条）_`);
  return lines.join('\n') + '\n';
}

/** 文档族版本表 */
export function renderVersions(opt) {
  const { file, lineage } = opt;
  const lines = [`# 文档版本 · ${file}`, ''];
  lines.push(`文档族：\`${lineage.lineageId}\`，共 ${lineage.members.length} 个版本文件。`);
  lines.push('');
  lines.push('| 版本 | 文件 | 修改时间 | 大小 | 已追踪 | 累计改动 |');
  lines.push('|---|---|---|---|---|---|');
  for (const m of lineage.members) {
    const mark = path.resolve(m.file) === path.resolve(file) ? ' ←' : '';
    lines.push(`| ${m.version ? 'v' + m.version : '—'} | ${m.name}${mark} | ${fmtClock(m.mtime)} | ${(m.size / 1024).toFixed(0)}KB | ${m.tracked ? '是' : '否'} | ${m.changeCount} |`);
  }
  const untracked = lineage.members.filter(m => !m.tracked);
  if (untracked.length) {
    lines.push('');
    lines.push(`_未追踪 ${untracked.length} 个版本：可用 \`edittrail init <file>\` 建基线，之后落盘才会被记录。_`);
  }
  return lines.join('\n') + '\n';
}
