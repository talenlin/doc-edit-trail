// src/core/revisions.mjs
// docx 原生修订（Track Changes）读取：直接读 OOXML 里的 <w:ins>/<w:del>/<w:moveFrom>/<w:moveTo>
// 以及各类 *PrChange（格式修订）。
//
// 为什么需要它：L0 的「快照 + diff」能回答「改成了什么」，但回答不了「谁改的」——
// 除非用户在编辑时开着「修订」，那时 Word/WPS 会把作者和时间直接写进 XML。
// 这条通道零宿主依赖：只要文件里有修订标记，不需要加载项、不需要 COM、不需要联网。
//
// 能力边界（必须记住）：
//   - 只有编辑时开启了「修订」模式才有记录；关着改的，XML 里什么都不会留。
//   - 用户点「接受所有修订」后标记消失，只剩最终文本 → 只能回落到 L0 diff。
//   - 这里给的是「修订条目」，不是「净变化」：同一段可能既有 ins 又有 del。
//   - 坐标是文档顺序 + w14:paraId（有就用），不是我们 journal 里的 anchor 体系。

import { parseZip, readZipFile } from './zip.mjs';
import { parseXml, textOf } from './xml.mjs';

const TYPE_OF_TAG = new Map([
  ['w:ins', 'insert'],
  ['w:del', 'delete'],
  ['w:moveFrom', 'moveFrom'],
  ['w:moveTo', 'moveTo'],
]);

const LABEL = {
  insert: '新增',
  delete: '删除',
  moveFrom: '移出',
  moveTo: '移入',
  format: '格式',
};

const TEXT_LIMIT = 200;

function clamp(s) {
  const t = String(s ?? '');
  return t.length > TEXT_LIMIT ? `${t.slice(0, TEXT_LIMIT)}…` : t;
}

function isPrChange(name) {
  return name.startsWith('w:') && name.endsWith('PrChange');
}

/** 文档顺序遍历，带着「最近的 w:p」上下文，收集修订节点。 */
function collect(node, state, out) {
  for (const child of node.children) {
    if (child.name === 'w:p') {
      state.para = child;
      state.paraIndex += 1;
    }
    const kind = TYPE_OF_TAG.get(child.name) || (isPrChange(child.name) ? 'format' : null);
    if (kind) out.push({ kind, node: child, para: state.para, paraIndex: state.para ? state.paraIndex : null });
    collect(child, state, out);
  }
}

function toRecord(entry, part, seq) {
  const { kind, node, para, paraIndex } = entry;
  const attrs = node.attrs || {};
  const paraId = para ? para.attrs['w14:paraId'] : undefined;
  return {
    seq,
    part,
    type: kind,
    label: LABEL[kind] || kind,
    author: attrs['w:author'] || '(未署名)',
    date: attrs['w:date'] || null,
    revisionId: attrs['w:id'] !== undefined ? Number(attrs['w:id']) : null,
    anchor: paraId ? `para:${paraId}` : (paraIndex ? `para:#${paraIndex}` : null),
    paragraph: para ? clamp(textOf(para).trim()) : '',
    text: clamp(textOf(node)),
    formatName: kind === 'format' ? (attrs['w:name'] || null) : null,
  };
}

function docxParts(zip) {
  const parts = ['word/document.xml'];
  for (const name of zip.list()) {
    if (/^word\/(header|footer)\d*\.xml$/.test(name)) parts.push(name);
  }
  parts.push('word/footnotes.xml', 'word/endnotes.xml');
  return parts.filter((p) => zip.has(p));
}

/**
 * 读一份 docx 里的原生修订。
 * @param {string|Buffer} input 文件路径或 docx 字节
 * @returns {{count:number, hasParts:boolean, authors:Record<string,number>, types:Record<string,number>, revisions:Array}}
 */
export function extractRevisions(input) {
  const zip = typeof input === 'string' ? readZipFile(input) : parseZip(input);
  const parts = docxParts(zip);
  if (parts.length === 0) {
    throw new Error('不是 docx：找不到 word/document.xml（xlsx/pptx 没有原生修订通道）');
  }

  const revisions = [];
  for (const part of parts) {
    const xml = zip.readText(part);
    if (!xml || (xml.indexOf('w:ins') < 0 && xml.indexOf('w:del') < 0 && xml.indexOf('PrChange') < 0)) continue;
    const root = parseXml(xml);
    const hits = [];
    collect(root, { para: null, paraIndex: 0 }, hits);
    for (const hit of hits) revisions.push(toRecord(hit, part, revisions.length + 1));
  }

  const authors = {};
  const types = {};
  for (const r of revisions) {
    authors[r.author] = (authors[r.author] || 0) + 1;
    types[r.type] = (types[r.type] || 0) + 1;
  }
  return { count: revisions.length, hasParts: parts.length > 0, authors, types, revisions };
}

/** 渲染成给人/模型看的行（CLI 与将来的 MCP 共用）。 */
export function renderRevisions(res, opts = {}) {
  const limit = opts.limit ?? 50;
  const lines = [];
  if (!res.count) {
    lines.push('没有原生修订标记（w:ins / w:del）。');
    lines.push('可能原因：① 编辑时没开「修订」模式；② 已点过「接受所有修订」；③ 这段文字是被脚本/模型整体重写的。');
    lines.push('这种情况下用 `edittrail diff <上一版> <这一版>` 或查看 journal 更可靠。');
    return lines;
  }
  const byType = Object.entries(res.types)
    .map(([k, v]) => `${LABEL[k] || k} ${v}`)
    .join(' / ');
  const byAuthor = Object.entries(res.authors)
    .sort((a, b) => b[1] - a[1])
    .map(([a, v]) => `${a} ${v}`)
    .join('、');
  lines.push(`原生修订 ${res.count} 处（${byType}）· 作者：${byAuthor}`);
  for (const r of res.revisions.slice(0, limit)) {
    const when = r.date ? r.date.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '') : '时间未知';
    const where = r.anchor ? `\`${r.anchor}\`` : '（段落未知）';
    const body = r.text ? `「${r.text}」` : '（空）';
    lines.push(`- [${r.label}] ${r.author} ${when} · ${where} · ${body}`);
  }
  if (res.count > limit) lines.push(`… 另有 ${res.count - limit} 处未列出（--json 可看全部）`);
  return lines;
}
