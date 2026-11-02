// src/core/xlsx.mjs
// xlsx 结构化快照。
//
// 真实 WPS 生成文件（示例文档 系列）的关键事实，决定了这里的实现方式：
//   1. workbook.xml 里的 r:id 与 sheetN.xml 的编号并不总是一一对应（rId9 是 theme、
//      rId10 是 sharedStrings），所以必须按 rels 的 Target 解析 part 名，不能由 rId 序号猜；
//   2. 大量单元格是「只有样式、没有值」的占位（<c r="C3" s="61"/>），必须丢弃，
//      否则 diff 会被样式噪声淹没；
//   3. 图表是两级引用：sheetN.xml → drawingN.xml → chartN.xml，且 chart 里带
//      strCache/numCache（缓存了真实数据），所以图表变化可以从缓存里看出规模变化；
//   4. 图片只记 hash，不解析像素。

import { createHash } from 'node:crypto';
import { parseXml, childNamed, childrenNamed, findAll, find, textOf } from './xml.mjs';

const REL_CHART = '/chart';
const REL_DRAWING = '/drawing';
const REL_WORKSHEET = '/worksheet';

// ------------------------------------------------------------------ 路径工具

/** posix 风格 dirname（'' 表示根）。 */
export function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** posix 风格 join，处理 '.' 与 '..'（不越过根）。 */
export function posixJoin(baseDir, rel) {
  const raw = baseDir ? `${baseDir}/${rel}` : rel;
  const out = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join('/');
}

/** part 对应的 rels part：xl/workbook.xml → xl/_rels/workbook.xml.rels */
export function relsPathFor(part) {
  const dir = posixDirname(part);
  const base = dir ? part.slice(dir.length + 1) : part;
  return dir ? `${dir}/_rels/${base}.rels` : `_rels/${base}.rels`;
}

/**
 * 解析某个 part 的关系表。
 * @returns {Map<string, {id:string, type:string, target:string, mode:string|null, part:string|null}>}
 */
export function parseRelationships(zip, part) {
  const rels = new Map();
  const text = zip.tryReadText(relsPathFor(part));
  if (!text) return rels;
  const doc = parseXml(text);
  for (const rel of findAll(doc, (n) => n.name === 'Relationship')) {
    const id = rel.attrs.Id || '';
    const target = rel.attrs.Target || '';
    const type = rel.attrs.Type || '';
    const mode = rel.attrs.TargetMode || null;
    let resolved = null;
    if (mode !== 'External' && target) {
      resolved = target.startsWith('/')
        ? posixJoin('', target.slice(1))
        : posixJoin(posixDirname(part), target);
    }
    rels.set(id, { id, type, target, mode, part: resolved });
  }
  return rels;
}

// ------------------------------------------------------------------ 共享字符串

/** 富文本 <si> 可能由多个 <r><t> 组成，拼接；跳过 <rPh>（注音）。 */
function sharedStringText(si) {
  let out = '';
  for (const child of si.children) {
    if (child.name === 't') out += child.text || '';
    else if (child.name === 'r') {
      for (const t of child.children) if (t.name === 't') out += t.text || '';
    }
  }
  return out;
}

function parseSharedStrings(zip, workbookRels) {
  let part = null;
  for (const rel of workbookRels.values()) {
    if (rel.type.endsWith('/sharedStrings') && rel.part) { part = rel.part; break; }
  }
  if (!part) part = 'xl/sharedStrings.xml';
  const text = zip.tryReadText(part);
  if (!text) return [];
  const doc = parseXml(text);
  const sst = find(doc, (n) => n.name === 'sst');
  if (!sst) return [];
  return childrenNamed(sst, 'si').map(sharedStringText);
}

// ------------------------------------------------------------------ 单元格

const KNOWN_CELL_TYPES = new Set(['n', 's', 'str', 'b', 'e', 'inlineStr', 'd']);

function readCell(cellNode, sst) {
  const ref = cellNode.attrs.r;
  if (!ref) return null;
  const rawType = cellNode.attrs.t;
  let type = rawType && KNOWN_CELL_TYPES.has(rawType) ? rawType : 'n';
  const styleAttr = cellNode.attrs.s;
  const fNode = childNamed(cellNode, 'f');
  const vNode = childNamed(cellNode, 'v');
  const isNode = childNamed(cellNode, 'is');

  let value = null;
  if (type === 's' && vNode) {
    const idx = Number(vNode.text);
    value = Number.isInteger(idx) && idx >= 0 && idx < sst.length ? sst[idx] : (vNode.text || '');
    // 共享字符串索引失效时保留原始索引，避免把内容静默吞掉
    if (value === undefined || value === null) value = vNode.text || '';
  } else if (type === 'inlineStr') {
    if (isNode) {
      for (const t of findAll(isNode, (n) => n.name === 't')) value = (value || '') + (t.text || '');
    }
    type = 'inlineStr';
  } else if (vNode) {
    value = vNode.text || '';
  } else if (fNode && type === 'str') {
    value = '';
  }

  const hasFormula = Boolean(fNode && (fNode.text || '').trim());
  // 空 cell（只有样式）直接丢弃：WPS 会在整行生成 s= 的占位单元格
  if ((value === null || value === '') && !hasFormula) return null;

  const cell = { v: value === null ? '' : value, t: type };
  if (styleAttr !== undefined) cell.s = Number(styleAttr);
  if (hasFormula) cell.f = fNode.text;
  return { ref, cell };
}

function parseSheetCells(sheetNode, sst) {
  const cellMap = {};
  const rowNodes = findAll(sheetNode, (n) => n.name === 'row');
  for (const row of rowNodes) {
    // 只处理 sheetData 下的 row：用父级判断太贵，靠 <c> 存在性过滤即可
    for (const child of row.children) {
      if (child.name !== 'c') continue;
      const parsed = readCell(child, sst);
      if (parsed) cellMap[parsed.ref] = parsed.cell;
    }
  }
  return cellMap;
}

// ------------------------------------------------------------------ 图表

function chartTitleText(chartNode) {
  const title = find(chartNode, (n) => n.name === 'c:title');
  if (!title) return null;
  const parts = [];
  for (const t of findAll(title, (n) => n.name === 'a:t')) parts.push(t.text || '');
  const s = parts.join('').trim();
  return s || null;
}

function numCacheHash(serNode, refName) {
  const cache = findAll(serNode, (n) => n.name === refName);
  if (!cache.length) return { count: 0, hash: null, points: [] };
  const cacheNode = find(cache[0], (n) => n.name === 'c:numCache' || n.name === 'c:strCache');
  if (!cacheNode) return { count: 0, hash: null, points: [] };
  const pts = findAll(cacheNode, (n) => n.name === 'c:pt').map((pt) => {
    const v = childNamed(pt, 'c:v');
    return { idx: Number(pt.attrs.idx || 0), v: v ? v.text || '' : '' };
  });
  const hash = pts.length
    ? createHash('sha1').update(pts.map((p) => `${p.idx}=${p.v}`).join('|')).digest('hex').slice(0, 12)
    : null;
  return { count: pts.length, hash, points: pts };
}

/** 解析单个 chart part；返回可直接参与 diff 的指纹对象。 */
export function parseChartXml(xml, part = null) {
  const doc = parseXml(xml);
  const chartNode = find(doc, (n) => n.name === 'c:chart') || doc;
  const plot = find(chartNode, (n) => n.name === 'c:plotArea') || chartNode;
  const typeNode = plot.children.find((c) => /^c:\w+Chart$/.test(c.name) && c.name !== 'c:chart') || null;
  const type = typeNode ? typeNode.name.replace(/^c:/, '') : 'unknown';
  const series = [];
  const serNodes = findAll(typeNode || chartNode, (n) => n.name === 'c:ser');
  for (const ser of serNodes) {
    let name = '';
    const tx = find(ser, (n) => n.name === 'c:tx');
    if (tx) {
      const cachePt = find(tx, (n) => n.name === 'c:v');
      name = cachePt ? cachePt.text || '' : '';
      if (!name) {
        const strPt = find(tx, (n) => n.name === 'c:pt');
        if (strPt) {
          const v = childNamed(strPt, 'c:v');
          name = v ? v.text || '' : '';
        }
      }
      if (!name) {
        const fNode = find(tx, (n) => n.name === 'c:f');
        if (fNode) name = `=${fNode.text || ''}`;
      }
    }
    const cat = numCacheHash(ser, 'c:cat');
    const val = numCacheHash(ser, 'c:val');
    const catRefNode = find(ser, (n) => n.name === 'c:cat');
    const catRef = catRefNode ? find(catRefNode, (n) => n.name === 'c:f') : null;
    series.push({
      name,
      catCount: cat.count,
      valCount: val.count,
      valHash: val.hash,
      valPoints: val.points.map((p) => p.v),
      catRef: catRef ? catRef.text : null,
    });
  }
  return {
    part,
    type,
    title: chartTitleText(chartNode),
    seriesCount: series.length,
    series,
    fingerprint: createHash('sha256').update(xml).digest('hex').slice(0, 16),
  };
}

/**
 * 行级结构元数据：行高 / 隐藏 / 分页符。
 * 真实 WPS 文件里「删掉整节」的表现之一是若干行的 ht/customHeight 消失、行分页符减少，
 * 这些信号对模型理解「删了一块」比 22 条「单元格被清空」有用得多。
 */
function parseSheetMeta(wsNode) {
  const rowMeta = {};
  const sheetData = childNamed(wsNode, 'sheetData');
  const rows = sheetData ? childrenNamed(sheetData, 'row') : [];
  for (const row of rows) {
    const r = Number(row.attrs.r || 0);
    if (!r) continue;
    const hidden = row.attrs.hidden === '1' || row.attrs.hidden === 'true';
    const hasHt = row.attrs.ht !== undefined;
    const customHeight = row.attrs.customHeight === '1' || row.attrs.customHeight === 'true';
    if (!hasHt && !hidden && !customHeight) continue;
    rowMeta[String(r)] = {
      ht: hasHt ? Number(row.attrs.ht) : null,
      hidden,
      customHeight,
    };
  }
  const breaksOf = (nodeName) => {
    const node = childNamed(wsNode, nodeName);
    if (!node) return [];
    return childrenNamed(node, 'brk')
      .map((b) => Number(b.attrs.id))
      .filter((n) => Number.isFinite(n))
      .sort((x, y) => x - y);
  };
  return { rowMeta, rowBreaks: breaksOf('rowBreaks'), colBreaks: breaksOf('colBreaks') };
}

function drawingPartOf(sheetPart, sheetRels) {
  for (const rel of sheetRels.values()) {
    if (rel.type.endsWith(REL_DRAWING) && rel.part) return rel.part;
  }
  return null;
}

function chartPartsOfDrawing(zip, drawingPart) {
  const out = [];
  if (!drawingPart) return out;
  const rels = parseRelationships(zip, drawingPart);
  for (const rel of rels.values()) {
    if (rel.type.endsWith(REL_CHART) && rel.part) out.push(rel.part);
  }
  return out;
}

// ------------------------------------------------------------------ 主入口

/**
 * 解析 xlsx 为结构化快照（纯函数：入参是已打开的 ZipArchive）。
 * @param {import('./zip.mjs').ZipArchive} zip
 * @returns {object} 快照
 */
export function parseXlsx(zip) {
  const workbookPart = 'xl/workbook.xml';
  const wbText = zip.tryReadText(workbookPart);
  if (!wbText) throw new Error('xlsx: 缺少 xl/workbook.xml（不是 xlsx 或已损坏）');
  const wbDoc = parseXml(wbText);
  const wbNode = wbDoc.children.find((c) => c.name === 'workbook') || wbDoc;
  const sheetsNode = childNamed(wbNode, 'sheets');
  if (!sheetsNode) throw new Error('xlsx: workbook.xml 里没有 <sheets>');

  const workbookRels = parseRelationships(zip, workbookPart);
  const sharedStrings = parseSharedStrings(zip, workbookRels);

  const sheetEntries = childrenNamed(sheetsNode, 'sheet');
  const sheets = [];
  const chartsByPart = new Map();

  sheetEntries.forEach((sheetNode, order) => {
    const name = sheetNode.attrs.name || `Sheet${order + 1}`;
    const rid = sheetNode.attrs['r:id'] || '';
    const rel = workbookRels.get(rid) || null;
    let part = rel && rel.part ? rel.part : null;
    if (!part) part = `xl/worksheets/sheet${order + 1}.xml`;
    const sheetXml = zip.tryReadText(part);
    if (!sheetXml) {
      // 缺 part 时不静默：记成空 sheet，并在快照里留痕
      sheets.push({
        name, order, state: sheetNode.attrs.state || 'visible',
        sheetId: Number(sheetNode.attrs.sheetId || 0), part,
        dims: null, merges: [], cells: {}, missingPart: true,
        rowMeta: {}, rowBreaks: [], colBreaks: [], drawing: null,
      });
      return;
    }
    const sheetDoc = parseXml(sheetXml);
    const wsNode = sheetDoc.children.find((c) => c.name === 'worksheet') || sheetDoc;
    const dimNode = childNamed(wsNode, 'dimension');
    const mergeNode = childNamed(wsNode, 'mergeCells');
    const merges = mergeNode ? childrenNamed(mergeNode, 'mergeCell').map((m) => m.attrs.ref).filter(Boolean) : [];
    const cells = parseSheetCells(wsNode, sharedStrings);
    const meta = parseSheetMeta(wsNode);

    // 图表：sheet → drawing → chart（两级 rels）
    const sheetRels = parseRelationships(zip, part);
    const drawingPart = drawingPartOf(part, sheetRels);
    const drawingXml = drawingPart ? zip.tryReadText(drawingPart) : null;
    const drawing = drawingXml
      ? { part: drawingPart, sha256: createHash('sha256').update(drawingXml).digest('hex').slice(0, 16) }
      : null;

    sheets.push({
      name,
      order,
      state: sheetNode.attrs.state || 'visible',
      sheetId: Number(sheetNode.attrs.sheetId || 0),
      part,
      dims: dimNode ? dimNode.attrs.ref || null : null,
      merges,
      cells,
      rowMeta: meta.rowMeta,
      rowBreaks: meta.rowBreaks,
      colBreaks: meta.colBreaks,
      drawing,
    });

    for (const chartPart of chartPartsOfDrawing(zip, drawingPart)) {
      if (chartsByPart.has(chartPart)) {
        // 同一图表被多个 sheet 引用时，记录首个 sheet
        continue;
      }
      const chartXml = zip.tryReadText(chartPart);
      if (!chartXml) continue;
      const chart = parseChartXml(chartXml, chartPart);
      chart.id = chartPart.split('/').pop().replace(/\.xml$/, '');
      chart.sheet = name;
      chart.drawingPart = drawingPart;
      chart.drawingHash = drawing ? drawing.sha256 : null;
      chartsByPart.set(chartPart, chart);
    }
  });

  // 兜底：drawing 之外直接挂 chart 的写法，或者没被任何 sheet 引用到的 chart
  for (const entry of zip.list()) {
    if (!/^xl\/charts\/[^/]+\.xml$/.test(entry) || chartsByPart.has(entry)) continue;
    const chartXml = zip.tryReadText(entry);
    if (!chartXml) continue;
    const chart = parseChartXml(chartXml, entry);
    chart.id = entry.split('/').pop().replace(/\.xml$/, '');
    chart.sheet = null;
    chartsByPart.set(entry, chart);
  }

  const media = [];
  for (const entry of zip.list()) {
    if (!/^xl\/media\//.test(entry)) continue;
    const buf = zip.read(entry);
    media.push({
      name: entry.split('/').pop(),
      part: entry,
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex').slice(0, 16),
    });
  }

  return {
    docType: 'xlsx',
    sheetCount: sheets.length,
    sheets,
    charts: [...chartsByPart.values()],
    media,
    sharedStringCount: sharedStrings.length,
    partCount: zip.list().length,
  };
}

/** 便捷：把快照压成 { sheetName: cellCount }，便于日志与断言。 */
export function cellCountsBySheet(snapshot) {
  const out = {};
  for (const sheet of snapshot.sheets || []) out[sheet.name] = Object.keys(sheet.cells || {}).length;
  return out;
}
