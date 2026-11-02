// test/revisions.test.mjs
// docx 原生修订读取：w:ins / w:del / *PrChange → 作者、时间、锚点、文本。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildZip } from '../src/core/zip.mjs';
import { extractRevisions, renderRevisions } from '../src/core/revisions.mjs';

const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';

function docxWith(body, extra = []) {
  return buildZip([
    {
      name: 'word/document.xml',
      data: `${HEAD}<w:document ${NS}><w:body>${body}</w:body></w:document>`,
    },
    ...extra,
  ]);
}

const BODY = [
  // 段落 1：整段文字是用户插入的
  '<w:p w14:paraId="2D375F6B"><w:ins w:id="1" w:author="张三" w:date="2026-01-14T14:12:00Z">' +
    '<w:r><w:t>新增的一句话</w:t></w:r></w:ins></w:p>',
  // 段落 2：保留句 + 用户删除一句
  '<w:p w14:paraId="2D375F6C"><w:r><w:t>保留的句子</w:t></w:r>' +
    '<w:del w:id="2" w:author="wps-user" w:date="2026-01-14T10:24:00Z">' +
    '<w:r><w:delText>被删掉的一句话</w:delText></w:r></w:del></w:p>',
  // 段落 3：格式修订（没有 w14:paraId，应回退 para:#3）
  '<w:p><w:r><w:rPr><w:rPrChange w:id="3" w:author="模型" w:date="2026-01-14T09:00:00Z"/></w:rPr>' +
    '<w:t>只改了格式</w:t></w:r></w:p>',
].join('');

test('extractRevisions：认出 ins/del/格式修订，带作者、时间、paraId 锚点', () => {
  const res = extractRevisions(docxWith(BODY));
  assert.equal(res.count, 3);
  assert.deepEqual(res.types, { insert: 1, delete: 1, format: 1 });
  assert.equal(res.authors['张三'], 1);
  assert.equal(res.authors['wps-user'], 1);
  assert.equal(res.authors['模型'], 1);

  const [ins, del, fmt] = res.revisions;
  assert.equal(ins.type, 'insert');
  assert.equal(ins.anchor, 'para:2D375F6B');
  assert.equal(ins.text, '新增的一句话');
  assert.equal(ins.date, '2026-01-14T14:12:00Z');

  assert.equal(del.type, 'delete');
  assert.equal(del.text, '被删掉的一句话');
  assert.equal(del.anchor, 'para:2D375F6C');
  assert.match(del.paragraph, /保留的句子/);

  assert.equal(fmt.type, 'format');
  assert.equal(fmt.anchor, 'para:#3');
  assert.equal(fmt.seq, 3);
});

test('extractRevisions：叶部件（页眉）里的修订也收', () => {
  const header = `${HEAD}<w:hdr ${NS}><w:p><w:ins w:id="9" w:author="李四" w:date="2026-01-14T10:00:00Z">` +
    '<w:r><w:t>页眉新增</w:t></w:r></w:ins></w:p></w:hdr>';
  const res = extractRevisions(docxWith(BODY, [{ name: 'word/header1.xml', data: header }]));
  assert.equal(res.count, 4);
  const h = res.revisions.find((r) => r.part === 'word/header1.xml');
  assert.ok(h, '应包含页眉修订');
  assert.equal(h.author, '李四');
  assert.equal(h.text, '页眉新增');
});

test('没有修订标记时：count=0 且给出回落提示', () => {
  const res = extractRevisions(docxWith('<w:p><w:r><w:t>干净文档</w:t></w:r></w:p>'));
  assert.equal(res.count, 0);
  const lines = renderRevisions(res).join('\n');
  assert.match(lines, /没有原生修订标记/);
  assert.match(lines, /edittrail diff/);
});

test('非 docx 直接报错（xlsx 没有原生修订通道）', () => {
  const zip = buildZip([{ name: 'xl/workbook.xml', data: `${HEAD}<workbook/>` }]);
  assert.throws(() => extractRevisions(zip), /不是 docx/);
});

test('renderRevisions：渲染行含作者/锚点/文本，超限给省略提示', () => {
  const res = extractRevisions(docxWith(BODY));
  const lines = renderRevisions(res, { limit: 2 });
  assert.match(lines[0], /原生修订 3 处/);
  assert.match(lines[0], /作者：/);
  assert.match(lines.join('\n'), /para:2D375F6B/);
  assert.match(lines.join('\n'), /另有 1 处未列出/);
});
