// xlsx.mjs + diff.mjs（xlsx 分支）单测：cell 增删改、sheet 增删改名、长文本截断、结构信号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZip } from '../src/core/zip.mjs';
import { parseXlsx, cellCountsBySheet } from '../src/core/xlsx.mjs';
import { diffSnapshots, summarizeDiff, countKinds } from '../src/core/diff.mjs';
import { makeXlsx, longText } from './helpers/fixtures.mjs';

function snapOf(spec) {
  return parseXlsx(parseZip(makeXlsx(spec)));
}

const BASE = {
  sheets: [
    {
      name: '总览',
      cells: {
        A1: { v: '示例文档 项目', s: 1 },
        B1: { v: '合计' },
        A2: { v: '明细表' },
        B2: { v: 12 },
        C3: { v: '待删' },
      },
      merges: ['A1:B1'],
    },
    { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
  ],
};

test('parseXlsx：sheet 顺序、共享字符串、数值、纯样式空格被丢弃', () => {
  const snap = snapOf({
    sheets: [
      { name: '总览', cells: { A1: { v: '标题', s: 7 }, B1: { v: '合计' }, A2: { v: 10 }, C3: { s: 61 } } },
      { name: '数据', cells: {}, state: 'hidden' },
    ],
  });
  assert.equal(snap.docType, 'xlsx');
  assert.equal(snap.sheetCount, 2);
  assert.deepEqual(snap.sheets.map((s) => s.name), ['总览', '数据']);
  assert.equal(snap.sheets[1].state, 'hidden');
  assert.equal(snap.sheets[0].cells.A1.v, '标题');
  assert.equal(snap.sheets[0].cells.A1.t, 's');
  assert.equal(snap.sheets[0].cells.A1.s, 7);
  assert.equal(snap.sheets[0].cells.A2.v, '10');
  assert.equal(snap.sheets[0].cells.A2.t, 'n');
  // 只有样式没有值的占位 cell 不应进来（否则 diff 噪声爆炸）
  assert.equal(snap.sheets[0].cells.C3, undefined);
  assert.deepEqual(snap.sheets[0].merges, []);
  assert.deepEqual(cellCountsBySheet(snap), { 总览: 3, 数据: 0 });
});

test('diff：单元格改 / 增 / 删，anchor 是 Sheet!A1 形式', () => {
  const a = snapOf(BASE);
  const b = snapOf({
    sheets: [
      {
        name: '总览',
        cells: {
          A1: { v: '示例文档 项目', s: 1 },
          B1: { v: '合计' },
          A2: { v: '明细表（10 项）' }, // 改
          B2: { v: 10 }, // 改
          D4: { v: '新增说明' }, // 增
          // C3 被删
        },
        merges: ['A1:B1'],
      },
      { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
    ],
  });
  const r = diffSnapshots(a, b);
  const kinds = countKinds(r.changes);
  assert.equal(kinds['cell.changed'], 2, JSON.stringify(r.changes));
  assert.equal(kinds['cell.added'], 1, JSON.stringify(r.changes));
  assert.equal(kinds['cell.removed'], 1, JSON.stringify(r.changes));
  const byAnchor = new Map(r.changes.map((c) => [c.anchor, c]));
  assert.ok(byAnchor.has('总览!A2'), '缺少 A2 改动');
  assert.equal(byAnchor.get('总览!A2').after, '明细表（10 项）');
  assert.ok(byAnchor.has('总览!D4'), '缺少 D4 新增');
  assert.ok(byAnchor.has('总览!C3'), '缺少 C3 删除');
  assert.match(summarizeDiff(r), /处实质改动/);
  // 未变化的 sheet 不应出现改动
  assert.ok(!r.changes.some((c) => c.anchor.startsWith('数据!')));
});

test('diff：sheet 新增 / 删除 / 改名', () => {
  // 改名识别用「内容相似度」，所以 fixture 里要有足够长的字符串值
  const oldSheet = { name: '明细', cells: { A1: { v: '明细表表' }, A2: { v: '编号与级别' } } };
  const a = snapOf({ sheets: [oldSheet, { name: '数据', cells: { A1: { v: '数据表标题' } } }] });
  // 改名：把「明细」改成「明细（新）」，内容一致
  const renamed = snapOf({
    sheets: [{ name: '明细（新）', cells: oldSheet.cells }, { name: '数据', cells: { A1: { v: '数据表标题' } } }],
  });
  const r1 = diffSnapshots(a, renamed);
  assert.equal(countKinds(r1.changes)['sheet.renamed'], 1, JSON.stringify(r1.changes));
  assert.match(JSON.stringify(r1.changes), /明细（新）/);

  // 新增 sheet
  const added = snapOf({
    sheets: [...a.sheets, { name: '看板', cells: { A1: { v: '看板标题文字' } } }],
  });
  const r2 = diffSnapshots(a, added);
  assert.equal(countKinds(r2.changes)['sheet.added'], 1, JSON.stringify(r2.changes));

  // 删除 sheet
  const removed = snapOf({ sheets: [a.sheets[0]] });
  const r3 = diffSnapshots(a, removed);
  assert.equal(countKinds(r3.changes)['sheet.removed'], 1, JSON.stringify(r3.changes));
});

test('diff：长文本截断为「前缀…窗口…后缀」，并给 beforeLen/afterLen', () => {
  const before = longText(80, '甲', 80);
  const after = longText(80, '乙', 80);
  const a = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: before } } }] });
  const b = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: after } } }] });
  const r = diffSnapshots(a, b);
  const c = r.changes[0];
  assert.equal(c.kind, 'cell.changed');
  assert.ok(c.before.length <= 121, `before 没截断：${c.before.length}`);
  assert.ok(c.after.length <= 121, `after 没截断：${c.after.length}`);
  assert.ok(c.before.includes('…') && c.after.includes('…'));
  assert.equal(c.beforeLen, before.length);
  assert.equal(c.afterLen, after.length);
  assert.equal(c.charDelta, after.length - before.length);
  // 原文 ≤1000 字 → 附带全文
  assert.equal(c.beforeFull, before);
});

test('diff：超长文本（>1000 字）不带全文，只带长度', () => {
  const before = longText(1200, '甲', 1200);
  const after = longText(1200, '乙', 1200);
  const a = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: before } } }] });
  const b = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: after } } }] });
  const c = diffSnapshots(a, b).changes[0];
  assert.equal(c.beforeFull, undefined);
  assert.equal(c.afterFull, undefined);
  assert.equal(c.beforeLen, before.length);
});

test('diff：合并区变化与分页符/行高变化是结构类改动', () => {
  const a = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: 'x' } }, merges: ['A1:B1', 'A2:B2'] }] });
  const b = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: 'x' } }, merges: ['A1:B1'] }] });
  const r = diffSnapshots(a, b);
  const merge = r.changes.find((c) => c.kind === 'merge.changed');
  assert.ok(merge, JSON.stringify(r.changes));
  assert.match(merge.anchor, /^S!/);
});

test('diff：纯样式变化单独归为 style.changed，不算文本改动', () => {
  const a = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: '同文', s: 1 } } }] });
  const b = snapOf({ sheets: [{ name: 'S', cells: { A1: { v: '同文', s: 2 } } }] });
  const r = diffSnapshots(a, b);
  assert.equal(countKinds(r.changes)['style.changed'], 1, JSON.stringify(r.changes));
  assert.equal(countKinds(r.changes)['cell.changed'], undefined);
});
