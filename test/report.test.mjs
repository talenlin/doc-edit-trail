// report.mjs 单测：markdown 简报结构、计数行、按 sheet 分组、>200 条折叠、--since 过滤。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeXlsx } from './helpers/fixtures.mjs';
import { initBaseline, recordVersion, readJournal } from '../src/core/journal.mjs';
import { renderReport, selectRecords, renderChangeLine, groupCounts, formatGroupCounts } from '../src/core/report.mjs';
import { pathsOf } from './helpers/tmp.mjs';

function writeXlsx(file, spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeXlsx(spec));
  return file;
}

// 造 240 处单元格改动，验证折叠
function bigChangeSpec() {
  const a = {};
  const b = {};
  for (let i = 1; i <= 240; i++) {
    a[`A${i}`] = { v: `第 ${i} 行旧值` };
    b[`A${i}`] = { v: `第 ${i} 行新值` };
  }
  return {
    a: { sheets: [{ name: '总览', cells: a }] },
    b: { sheets: [{ name: '总览', cells: b }] },
  };
}

test('renderReport：标题/计数行/版本节/sheet 分组/逐条锚点', () => {
  const { file } = pathsOf('report-basic', '示例文档报告_v2.3.xlsx');
  writeXlsx(file, {
    sheets: [{ name: '总览', cells: { A1: { v: '示例文档 项目' }, A2: { v: '12 项' } } }],
  });
  initBaseline(file, { actor: 'wps-user', source: 'cli' });
  writeXlsx(file, {
    sheets: [{ name: '总览', cells: { A1: { v: '示例文档 项目' }, A2: { v: '10 项' } } }],
  });
  recordVersion(file, { actor: 'wps-user', source: 'watcher' });

  const { markdown, counts, totalChanges } = renderReport(file);
  assert.ok(totalChanges >= 1);
  assert.match(markdown, /^# 变更简报 · 示例文档报告_v2\.3\.xlsx/m);
  assert.match(markdown, /> 本次共 \d+ 处实质改动：/);
  assert.match(markdown, /^## v2\.3 .* actor=wps-user/m);
  assert.match(markdown, /source=watcher/);
  assert.match(markdown, /^### 总览（\d+ 处）/m);
  assert.match(markdown, /- `总览!A2`：/);
  assert.match(markdown, /12 项/);
  assert.match(markdown, /10 项/);
  assert.ok(counts.text >= 1);
});

test('renderReport：>200 条时折叠，行数受控但仍给出总数', () => {
  const { a, b } = bigChangeSpec();
  const { file } = pathsOf('report-fold', '示例文档报告_v3.0.xlsx');
  writeXlsx(file, a);
  initBaseline(file, { source: 'cli' });
  writeXlsx(file, b);
  const rec = recordVersion(file, { source: 'watch' }).record;
  assert.equal(rec.changeCount, 240);

  const { markdown } = renderReport(file);
  const bulletLines = markdown.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bulletLines.length <= 201, `明细行应被折叠，实际 ${bulletLines.length}`);
  assert.match(markdown, /另有 \d+ 条同类改动/);
  assert.match(markdown, /本次共 240 处实质改动/);
});

test('selectRecords：按 seq 与 sha 前缀过滤', () => {
  const records = [
    { seq: 1, sha256: 'a'.repeat(64) },
    { seq: 2, sha256: 'b'.repeat(64) },
    { seq: 3, sha256: 'c'.repeat(64) },
  ];
  assert.deepEqual(selectRecords(records, 2).map((r) => r.seq), [3]);
  assert.deepEqual(selectRecords(records, 'bbb').map((r) => r.seq), [3]);
  assert.deepEqual(selectRecords(records, 'a'.repeat(64)).map((r) => r.seq), [2, 3]);
  assert.equal(selectRecords(records, undefined).length, 3);
});

test('renderChangeLine：四种句式（改写/新增/删除/样式）', () => {
  assert.match(renderChangeLine({ kind: 'cell.changed', anchor: 'S!A1', before: '甲', after: '乙' }), /- `S!A1`：`甲` → `乙`/);
  assert.match(renderChangeLine({ kind: 'cell.added', anchor: 'S!A2', after: '新增' }), /新增：`新增`/);
  assert.match(renderChangeLine({ kind: 'cell.removed', anchor: 'S!A3', before: '删了' }), /删除：`删了`/);
  const styled = renderChangeLine({ kind: 'style.changed', anchor: 'S!A4', before: 'x|b', after: 'x' });
  assert.match(styled, /样式：/);
  // 含样式变化的正文改动带标记，方便模型区分「内容变了还是只换格式」
  const withStyle = renderChangeLine({ kind: 'cell.changed', anchor: 'S!A5', before: 'a', after: 'b', styleChanged: true });
  assert.match(withStyle, /〔含样式〕/);
});

test('groupCounts/formatGroupCounts：分类计数与中文标签', () => {
  const counts = groupCounts([
    { kind: 'cell.changed' },
    { kind: 'cell.added' },
    { kind: 'merge.changed' },
    { kind: 'chart.changed' },
    { kind: 'media.changed' },
    { kind: 'sheet.removed' },
  ]);
  assert.equal(counts.text, 2);
  assert.equal(counts.structure, 2);
  assert.equal(counts.chart, 2);
  const s = formatGroupCounts(counts);
  assert.match(s, /结构 2/);
  assert.match(s, /文本 2/);
  assert.match(s, /图表 2/);
});

test('renderReport：since 只渲染指定版本之后', () => {
  const { file } = pathsOf('report-since', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, { sheets: [{ name: 'S', cells: { A1: { v: 'v1' } } }] });
  initBaseline(file, { source: 'cli' });
  writeXlsx(file, { sheets: [{ name: 'S', cells: { A1: { v: 'v2' } } }] });
  recordVersion(file, { source: 'cli' });
  writeXlsx(file, { sheets: [{ name: 'S', cells: { A1: { v: 'v3' } } }] });
  recordVersion(file, { source: 'cli' });
  assert.equal(readJournal(file).records.length, 3);

  const r2 = renderReport(file, { since: 1 });
  assert.equal(r2.selected.length, 2);
  assert.ok(!r2.markdown.includes('## 基线'));
});
