// src/core/docx.mjs
// docx 结构化快照。
//
// 实测文档暴露的陷阱：同一批文档里有的带 w14:paraId、有的完全不带
// （同一组文档里，旧版一个都没有、新版几乎每段都有）。所以段落锚点必须允许「无 ID」回退到序号，
// 上层 diff 也要能在一边有 ID、一边没 ID 时按文本/序号对齐。
//
// 另外 WPS 的标题经常不是 pStyle（例如直接给 run 加 <w:b/> + <w:sz w:val="40">），
// 因此 headingLevel 由 pStyle/outlineLvl 推导，bold/italic/size 从 run 级读取。

import { parseXml, childNamed, childrenNamed, findAll } from './xml.mjs';

function runText(runNode) {
  let text = '';
  for (const child of runNode.children) {
    if (child.name === 'w:t') text += child.text || '';
    else if (child.name === 'w:tab') text += '\t';
    else if (child.name === 'w:br' || child.name === 'w:cr') text += '\n';
    else if (child.name === 'w:noBreakHyphen') text += '-';
  }
  return text;
}

/** 收集段落里的可见 run（跳过 <w:del> 删除内容，保留 <w:ins> 插入内容）。 */
function collectRuns(node, out = [], insideDeleted = false) {
  for (const child of node.children) {
    if (child.name === 'w:del' || child.name === 'w:moveFrom') {
      collectRuns(child, out, true);
      continue;
    }
    if (child.name === 'w:r') {
      if (!insideDeleted) out.push(child);
      continue;
    }
    collectRuns(child, out, insideDeleted);
  }
  return out;
}

function isOn(rPr, name) {
  if (!rPr) return false;
  const node = childNamed(rPr, name);
  if (!node) return false;
  const val = node.attrs['w:val'];
  return val === undefined || val === '1' || val === 'true' || val === 'on';
}

function runProps(runNode) {
  const rPr = childNamed(runNode, 'w:rPr');
  const szNode = rPr ? childNamed(rPr, 'w:sz') : null;
  return {
    bold: isOn(rPr, 'w:b'),
    italic: isOn(rPr, 'w:i'),
    size: szNode ? Number(szNode.attrs['w:val']) / 2 : null,
  };
}

function headingLevelOf(pPr, styleName) {
  if (pPr) {
    const outline = childNamed(pPr, 'w:outlineLvl');
    if (outline && outline.attrs['w:val'] !== undefined) {
      const lvl = Number(outline.attrs['w:val']);
      if (Number.isInteger(lvl) && lvl >= 0 && lvl < 9) return lvl + 1;
    }
  }
  if (styleName) {
    const m = String(styleName).match(/(?:Heading|heading|标题)\s*(\d)/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** 解析单个 <w:p>；返回 null 表示空段落以外的纯空壳（无语义内容也无 ID 时仍保留，避免序号错位）。 */
export function parseParagraph(pNode) {
  const pPr = childNamed(pNode, 'w:pPr');
  const styleNode = pPr ? childNamed(pPr, 'w:pStyle') : null;
  const style = styleNode ? styleNode.attrs['w:val'] || null : null;
  const jcNode = pPr ? childNamed(pPr, 'w:jc') : null;
  const align = jcNode ? jcNode.attrs['w:val'] || null : null;
  const runs = collectRuns(pNode);
  let text = '';
  const props = { bold: false, italic: false, size: null };
  let visibleRuns = 0;
  for (const run of runs) {
    const t = runText(run);
    if (!t) continue;
    visibleRuns++;
    text += t;
    const p = runProps(run);
    if (p.bold) props.bold = true;
    if (p.italic) props.italic = true;
    if (p.size !== null) props.size = Math.max(props.size || 0, p.size);
  }
  const headingLevel = headingLevelOf(pPr, style);
  const styleSig = [style || '', props.bold ? 'b' : '', props.italic ? 'i' : '',
    props.size === null ? '' : `sz${props.size}`, align || '', headingLevel === null ? '' : `h${headingLevel}`].join('|');
  return {
    paraId: pNode.attrs['w14:paraId'] || null,
    text,
    style,
    bold: props.bold,
    italic: props.italic,
    size: props.size,
    align,
    headingLevel,
    styleSig,
    visibleRuns,
  };
}

/** 深度收集名为 name 的后代，但遇到 stopName 子树就不再深入（用于跳过嵌套表）。 */
function collectDescendants(node, name, stopName, out = []) {
  for (const child of node.children) {
    if (child.name === stopName && name !== stopName) continue;
    if (child.name === name) out.push(child);
    else collectDescendants(child, name, stopName, out);
  }
  return out;
}

function parseTable(tblNode) {
  const rows = [];
  for (const tr of collectDescendants(tblNode, 'w:tr', 'w:tbl')) {
    const cells = [];
    for (const tc of collectDescendants(tr, 'w:tc', 'w:tbl')) {
      const texts = [];
      for (const p of findAll(tc, (n) => n.name === 'w:p')) {
        const runs = collectRuns(p);
        let cellText = '';
        for (const run of runs) cellText += runText(run);
        if (cellText) texts.push(cellText);
      }
      cells.push(texts.join('\n'));
    }
    rows.push(cells);
  }
  return { rows, rowCount: rows.length, colCount: rows.reduce((m, r) => Math.max(m, r.length), 0) };
}

/**
 * 解析 docx 为结构化快照。
 * @param {import('./zip.mjs').ZipArchive} zip
 */
export function parseDocx(zip) {
  const docPart = 'word/document.xml';
  const xml = zip.tryReadText(docPart);
  if (!xml) throw new Error('docx: 缺少 word/document.xml');
  const doc = parseXml(xml);
  const body = findAll(doc, (n) => n.name === 'w:body')[0] || doc;

  const paragraphs = [];
  const tables = [];
  let trackIns = 0;
  let trackDel = 0;

  // 只遍历 body 的一级内容；表格内部的 w:p 单独归入 tables，不占段落序号
  const visit = (node, inTable) => {
    for (const child of node.children) {
      if (child.name === 'w:p') {
        if (!inTable) {
          const para = parseParagraph(child);
          para.i = paragraphs.length;
          paragraphs.push(para);
        }
      } else if (child.name === 'w:tbl') {
        tables.push({ tableIndex: tables.length, ...parseTable(child) });
      } else if (child.name === 'w:sdt') {
        const content = childNamed(child, 'w:sdtContent');
        if (content) visit(content, inTable);
      } else if (child.name === 'w:ins' || child.name === 'w:del') {
        // 正文级修订标记
        if (child.name === 'w:ins') trackIns++;
        else trackDel++;
        visit(child, inTable);
      } else if (child.name === 'w:sectPr') {
        continue;
      } else if (child.name === 'w:customXml' || child.name === 'w:smartTag' || child.name === 'w:bookmarkStart') {
        visit(child, inTable);
      }
    }
  };
  visit(body, false);

  // 页眉页脚（可选）：只给 part -> 段落列表，用于发现「页眉里改了字」
  const headersFooters = {};
  for (const entry of zip.list()) {
    if (!/^word\/(header|footer)\d*\.xml$/.test(entry)) continue;
    const text = zip.tryReadText(entry);
    if (!text) continue;
    const hDoc = parseXml(text);
    const ps = [];
    for (const p of findAll(hDoc, (n) => n.name === 'w:p')) {
      const para = parseParagraph(p);
      if (para.text) ps.push({ i: ps.length, paraId: para.paraId, text: para.text });
    }
    headersFooters[entry] = ps;
  }

  return {
    docType: 'docx',
    paragraphCount: paragraphs.length,
    paragraphs,
    tables,
    headersFooters,
    trackChanges: { ins: trackIns, del: trackDel },
    partCount: zip.list().length,
  };
}
