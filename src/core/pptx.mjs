// src/core/pptx.mjs
// pptx 结构化快照（本机没有真实 pptx 样本，按 OOXML 常规结构实现，
// 但保持「只取形状名 + 文本」这一最小面，避免过度解析版式）。

import { parseXml, childNamed, childrenNamed, findAll } from './xml.mjs';

function slideIndex(part) {
  const m = part.match(/slide(\d+)\.xml$/);
  return m ? Number(m[1]) : 0;
}

function shapeName(shapeNode) {
  // p:sp → p:nvSpPr/p:cNvPr@name；p:graphicFrame → p:nvGraphicFramePr/p:cNvPr@name
  const holders = ['p:nvSpPr', 'p:nvGraphicFramePr', 'p:nvPicPr', 'p:nvCxnSpPr'];
  for (const h of holders) {
    const nv = childNamed(shapeNode, h);
    if (!nv) continue;
    const cNvPr = childNamed(nv, 'p:cNvPr');
    if (cNvPr && cNvPr.attrs.name) return cNvPr.attrs.name;
  }
  return null;
}

function shapeText(shapeNode) {
  const parts = [];
  for (const t of findAll(shapeNode, (n) => n.name === 'a:t')) parts.push(t.text || '');
  return parts.join('');
}

/**
 * 解析 pptx 为结构化快照。
 * @param {import('./zip.mjs').ZipArchive} zip
 */
export function parsePptx(zip) {
  const slideParts = zip
    .list()
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideIndex(a) - slideIndex(b));
  if (!slideParts.length) throw new Error('pptx: 未找到 ppt/slides/slideN.xml');

  const slides = [];
  for (const part of slideParts) {
    const xml = zip.tryReadText(part);
    if (!xml) continue;
    const doc = parseXml(xml);
    const shapes = [];
    for (const node of findAll(doc, (n) => n.name === 'p:sp' || n.name === 'p:graphicFrame'
      || n.name === 'p:pic' || n.name === 'p:cxnSp')) {
      const text = shapeText(node);
      const name = shapeName(node);
      if (!text && !name) continue;
      shapes.push({ name, text });
    }
    slides.push({ index: slides.length + 1, slideNumber: slideIndex(part), part, shapes });
  }

  return {
    docType: 'pptx',
    slideCount: slides.length,
    slides,
    partCount: zip.list().length,
  };
}
