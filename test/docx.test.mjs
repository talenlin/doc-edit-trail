// docx.mjs + diff.mjs（docx 分支）单测：段落增删改、样式、标题级别、表格行级对齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZip } from '../src/core/zip.mjs';
import { parseDocx } from '../src/core/docx.mjs';
import { diffSnapshots, countKinds } from '../src/core/diff.mjs';
import { makeDocx, longText } from './helpers/fixtures.mjs';

function snapOf(spec) {
  return parseDocx(parseZip(makeDocx(spec)));
}

test('parseDocx：段落文本、paraId、粗体/字号/标题级别、表格', () => {
  const snap = snapOf({
    paragraphs: [
      { paraId: '1A2B3C4D', text: '示例文档 第一段落标题', bold: true, size: 20, headingLevel: 1 },
      { paraId: '2A2B3C4D', text: '普通段落', italic: true, size: 11 },
      { text: '没有 paraId 的段落' },
    ],
    tables: [[['项目', '说明'], ['第一项', '一段说明']]],
  });
  assert.equal(snap.docType, 'docx');
  assert.equal(snap.paragraphCount, 3);
  const [p0, p1, p2] = snap.paragraphs;
  assert.equal(p0.paraId, '1A2B3C4D');
  assert.equal(p0.text, '示例文档 第一段落标题');
  assert.equal(p0.bold, true);
  assert.equal(p0.size, 20);
  assert.equal(p0.headingLevel, 1);
  assert.equal(p1.italic, true);
  assert.equal(p2.paraId, null);
  // 表格：单元格文本与尺寸
  assert.equal(snap.tables.length, 1);
  assert.deepEqual(snap.tables[0].rows, [['项目', '说明'], ['第一项', '一段说明']]);
  assert.equal(snap.tables[0].rowCount, 2);
  assert.equal(snap.tables[0].colCount, 2);
});

test('diff docx：有 paraId 时按 paraId 锚定改动', () => {
  const a = snapOf({
    paragraphs: [
      { paraId: 'AAAA1111', text: '开场' },
      { paraId: 'BBBB2222', text: '自上而下 7 段' },
      { paraId: 'CCCC3333', text: '结尾' },
    ],
  });
  const b = snapOf({
    paragraphs: [
      { paraId: 'AAAA1111', text: '开场' },
      { paraId: 'BBBB2222', text: '自上而下 8 段' },
      { paraId: 'CCCC3333', text: '结尾' },
    ],
  });
  const r = diffSnapshots(a, b);
  assert.equal(r.totalChanges, 1, JSON.stringify(r.changes));
  const c = r.changes[0];
  assert.equal(c.kind, 'para.changed');
  assert.equal(c.anchor, 'para:BBBB2222');
  assert.equal(c.before, '自上而下 7 段');
  assert.equal(c.after, '自上而下 8 段');
});

test('diff docx：无 paraId 时回退到 para:#<index> 锚点', () => {
  const a = snapOf({ paragraphs: [{ text: '第一段' }, { text: '第二段' }] });
  const b = snapOf({ paragraphs: [{ text: '第一段（改）' }, { text: '第二段' }] });
  const r = diffSnapshots(a, b);
  const c = r.changes.find((x) => x.kind === 'para.changed');
  assert.ok(c, JSON.stringify(r.changes));
  assert.equal(c.anchor, 'para:#0');
});

test('diff docx：段落新增 / 删除', () => {
  const a = snapOf({ paragraphs: [{ paraId: 'A0000001', text: '一' }, { paraId: 'A0000002', text: '三' }] });
  const b = snapOf({
    paragraphs: [
      { paraId: 'A0000001', text: '一' },
      { paraId: 'A0000009', text: '二（插入）' },
      { paraId: 'A0000002', text: '三' },
    ],
  });
  const r = diffSnapshots(a, b);
  const kinds = countKinds(r.changes);
  assert.equal(kinds['para.added'], 1, JSON.stringify(r.changes));
  assert.equal(kinds['para.removed'] || 0, 0);
  const added = r.changes.find((c) => c.kind === 'para.added');
  assert.equal(added.after, '二（插入）');
});

test('diff docx：标题级别变化额外发 heading.level', () => {
  const a = snapOf({ paragraphs: [{ paraId: 'H0000001', text: '章节标题', headingLevel: 2 }] });
  const b = snapOf({ paragraphs: [{ paraId: 'H0000001', text: '章节标题', headingLevel: 1 }] });
  const r = diffSnapshots(a, b);
  const kinds = countKinds(r.changes);
  assert.equal(kinds['heading.level'], 1, JSON.stringify(r.changes));
});

test('diff docx：表格插一行 → 后续行是「改写」而不是全部新增，锚点不重复', () => {
  const a = snapOf({
    paragraphs: [{ text: '前言' }],
    tables: [[['列一', '列二'], ['行甲', '值甲'], ['行乙', '值乙']]],
  });
  const b = snapOf({
    paragraphs: [{ text: '前言' }],
    tables: [
      [
        ['列一', '列二'],
        ['行甲', '值甲'],
        ['行乙', '值乙改'],
        ['行丙', '值丙'],
      ],
    ],
  });
  const r = diffSnapshots(a, b);
  const tableChanges = r.changes.filter((c) => c.kind === 'table.changed');
  assert.ok(tableChanges.length >= 3, JSON.stringify(r.changes));
  const anchors = tableChanges.map((c) => c.anchor);
  assert.equal(anchors.length, new Set(anchors).size, `表格锚点重复：${anchors.join(',')}`);
  // 新增行用 +rNcM 形式
  assert.ok(anchors.some((a) => /\+r\d+c\d+/.test(a)), anchors.join(','));
});

test('diff docx：长段落截断且带 firstDiffAt/charDelta', () => {
  const before = longText(100, '甲', 100);
  const after = longText(100, '乙', 100);
  const a = snapOf({ paragraphs: [{ paraId: 'L0000001', text: before }] });
  const b = snapOf({ paragraphs: [{ paraId: 'L0000001', text: after }] });
  const c = diffSnapshots(a, b).changes[0];
  assert.ok(c.before.length <= 121, `before 长度 ${c.before.length}`);
  assert.ok(c.before.includes('…'));
  assert.equal(c.firstDiffAt, 100);
  assert.equal(c.charDelta, 0);
});
