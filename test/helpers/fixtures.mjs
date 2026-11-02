// 测试用最小 OOXML fixture 构造器：只用 zip.mjs 的 buildZip（store 模式），
// 让解析器测试不依赖真实 Office 文件，也不引入任何第三方依赖。
import { buildZip } from '../../src/core/zip.mjs';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function refParts(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(String(ref).trim().toUpperCase());
  if (!m) throw new Error(`fixtures: 非法单元格引用 ${ref}`);
  return { col: m[1], row: Number(m[2]) };
}

function colIndex(col) {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** 把 {A1: {v,t,s,f}} 渲染成 sheetData 行（行号升序、列号升序）。 */
function renderSheetData(cells, sst) {
  const rows = new Map();
  for (const [ref, cell] of Object.entries(cells || {})) {
    const { col, row } = refParts(ref);
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push({ ref: ref.toUpperCase(), col: colIndex(col), cell });
  }
  const lines = [];
  for (const row of [...rows.keys()].sort((a, b) => a - b)) {
    const list = rows.get(row).sort((x, y) => x.col - y.col);
    const parts = list.map(({ ref, cell }) => {
      const attrs = [`r="${ref}"`];
      const t = cell.t || (typeof cell.v === 'number' ? 'n' : 's');
      if (cell.s !== undefined) attrs.push(`s="${cell.s}"`);
      if (t === 'inlineStr') {
        return `<c ${attrs.join(' ')} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v ?? '')}</t></is></c>`;
      }
      attrs.push(`t="${t}"`);
      let v = cell.v;
      if (t === 's') {
        v = sst.indexOf(String(cell.v ?? ''));
        if (v < 0) {
          sst.push(String(cell.v ?? ''));
          v = sst.length - 1;
        }
      }
      const f = cell.f ? `<f>${esc(cell.f)}</f>` : '';
      const val = v === undefined || v === null || v === '' ? '' : `<v>${esc(v)}</v>`;
      return `<c ${attrs.join(' ')}>${f}${val}</c>`;
    });
    lines.push(`<row r="${row}">${parts.join('')}</row>`);
  }
  return lines.join('');
}

/**
 * 构造最小 xlsx。
 * @param {{sheets: Array<{name: string, cells?: object, merges?: string[], state?: string}>}} spec
 */
export function makeXlsx(spec) {
  const sheets = spec.sheets || [];
  const sst = [];
  const files = [];
  const sheetTags = [];
  const relTags = [];

  sheets.forEach((sheet, i) => {
    const n = i + 1;
    const stateAttr = sheet.state ? ` state="${sheet.state}"` : '';
    sheetTags.push(`<sheet name="${esc(sheet.name)}" sheetId="${n}"${stateAttr} r:id="rId${n}"/>`);
    relTags.push(
      `<Relationship Id="rId${n}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
    );
    const data = renderSheetData(sheet.cells, sst);
    const merges = sheet.merges && sheet.merges.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges
          .map((r) => `<mergeCell ref="${r}"/>`)
          .join('')}</mergeCells>`
      : '';
    files.push({
      name: `xl/worksheets/sheet${n}.xml`,
      data:
        XML_HEAD +
        `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
        `<dimension ref="${sheet.dims || 'A1:H40'}"/>` +
        `<sheetData>${data}</sheetData>${merges}</worksheet>`,
    });
  });

  const sstTotal = sst.length;
  files.push({
    name: 'xl/sharedStrings.xml',
    data:
      XML_HEAD +
      `<sst xmlns="${NS_MAIN}" count="${sstTotal}" uniqueCount="${sstTotal}">` +
      sst.map((t) => `<si><t xml:space="preserve">${esc(t)}</t></si>`).join('') +
      `</sst>`,
  });

  files.push({
    name: 'xl/workbook.xml',
    data:
      XML_HEAD +
      `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${sheetTags.join('')}</sheets></workbook>`,
  });

  const relsItems = [...relTags, `<Relationship Id="rId100" Type="${NS_REL}/sharedStrings" Target="sharedStrings.xml"/>`];
  files.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: XML_HEAD + `<Relationships xmlns="${NS_PKG_REL}">${relsItems.join('')}</Relationships>`,
  });

  files.push({
    name: '[Content_Types].xml',
    data:
      XML_HEAD +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>',
  });

  return buildZip(files);
}

function renderParagraph(p, opts = {}) {
  const attrs = [];
  if (p.paraId) attrs.push(`w14:paraId="${p.paraId}"`);
  if (p.textId) attrs.push(`w14:textId="${p.textId}"`);
  const pPr = [];
  if (p.style) pPr.push(`<w:pStyle w:val="${esc(p.style)}"/>`);
  if (p.align) pPr.push(`<w:jc w:val="${p.align}"/>`);
  if (p.headingLevel) pPr.push(`<w:outlineLvl w:val="${p.headingLevel - 1}"/>`);
  const rPr = [];
  if (p.bold) rPr.push('<w:b/>');
  if (p.italic) rPr.push('<w:i/>');
  if (p.size) rPr.push(`<w:sz w:val="${Math.round(p.size * 2)}"/>`);
  if (p.color) rPr.push(`<w:color w:val="${p.color}"/>`);
  const runs = (p.runs || [{ text: p.text ?? '' }])
    .map((r) => {
      const inner = [];
      if (p.bold || r.bold) inner.push('<w:b/>');
      if (p.italic || r.italic) inner.push('<w:i/>');
      if (p.size || r.size) inner.push(`<w:sz w:val="${Math.round((r.size ?? p.size) * 2)}"/>`);
      const rPrXml = inner.length ? `<w:rPr>${inner.join('')}</w:rPr>` : '';
      return `<w:r>${rPrXml}<w:t xml:space="preserve">${esc(r.text ?? '')}</w:t></w:r>`;
    })
    .join('');
  return `<w:p${attrs.length ? ' ' + attrs.join(' ') : ''}>${pPr.length ? `<w:pPr>${pPr.join('')}</w:pPr>` : ''}${runs}</w:p>`;
}

/**
 * 构造最小 docx。
 * @param {{paragraphs?: Array<object>, tables?: string[][][], headerText?: string}} spec
 */
export function makeDocx(spec) {
  const body = [];
  for (const p of spec.paragraphs || []) body.push(renderParagraph(p));
  for (const table of spec.tables || []) {
    const rows = table
      .map(
        (row) =>
          `<w:tr>${row
            .map((text) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`)
            .join('')}</w:tr>`,
      )
      .join('');
    body.push(`<w:tbl><w:tblPr/><w:tblGrid/>${rows}</w:tbl>`);
  }
  body.push('<w:sectPr/>');

  const files = [
    {
      name: 'word/document.xml',
      data:
        XML_HEAD +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">' +
        `<w:body>${body.join('')}</w:body></w:document>`,
    },
  ];
  if (spec.headerText !== undefined) {
    files.push({
      name: 'word/header1.xml',
      data:
        XML_HEAD +
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:p><w:r><w:t>${esc(spec.headerText)}</w:t></w:r></w:p></w:hdr>`,
    });
  }
  return buildZip(files);
}

/** 生成一段用于「长文本截断」测试的文本：prefix + 差异点 + suffix。 */
export function longText(prefixLen, diff, suffixLen) {
  return '前'.repeat(prefixLen) + diff + '后'.repeat(suffixLen);
}
