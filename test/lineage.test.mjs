// lineage.mjs 单测：文件名归一化四步、版本号提取、同族聚合与前后成员。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeXlsx } from './helpers/fixtures.mjs';
import { lineageKey, extractVersion, cmpVersion, scanLineage, buildLineage, previousMember, nextMember } from '../src/core/lineage.mjs';
import { pathsOf } from './helpers/tmp.mjs';

const PREFIX = '示例报告';

test('lineageKey：版本后缀/日期/副本标记都不影响家族键', () => {
  const key = lineageKey(`${PREFIX}_v2.3.xlsx`);
  for (const name of [
    `${PREFIX}_v2.4.xlsx`,
    `${PREFIX}_v3.0.xlsx`,
    `${PREFIX}_v2.9-250101.xlsx`,
    `${PREFIX}_v2.3（打印版）.xlsx`,
    `${PREFIX}_v2.3-副本.xlsx`,
    `${PREFIX} v2.3.xlsx`,
    `${PREFIX}_v2.3.xlsx`,
  ]) {
    assert.equal(lineageKey(name), key, `归一化失败：${name} → ${lineageKey(name)}`);
  }
  // 不同文档族必须分开
  assert.notEqual(lineageKey('示例报告_v2.2.docx'), lineageKey('另一个文档_v2.2.docx'));
  assert.equal(lineageKey(`${PREFIX}_10分钟报告_v2.2.docx`), lineageKey(`${PREFIX}_10分钟报告_v2.3.docx`));
  // 扩展名不参与归一化
  assert.equal(lineageKey(`${PREFIX}_v2.3.xlsx`), lineageKey(`${PREFIX}_v2.3.xlsm`));
});

test('extractVersion：_v2.3 / v3.0 / _v2.9-250101 / 无版本号', () => {
  assert.equal(extractVersion(`${PREFIX}_v2.3.xlsx`), '2.3');
  assert.equal(extractVersion(`${PREFIX} v3.0.xlsx`), '3.0');
  assert.equal(extractVersion(`${PREFIX}_v2.9-250101.xlsx`), '2.9-250101');
  assert.equal(extractVersion('没有版本号的文件.xlsx'), null);
  assert.ok(cmpVersion('2.3', '2.4') < 0);
  assert.ok(cmpVersion('2.10', '2.9') > 0);
  assert.equal(cmpVersion('2.3', '2.3'), 0);
  // 同版本不同日期：日期作为次级键
  assert.ok(cmpVersion('2.9', '2.9-250101') < 0);
});

test('scanLineage/buildLineage：同目录同族成员按版本排序，lineage.json 落盘', () => {
  const { dir } = pathsOf('lineage-scan', 'x');
  const names = [`${PREFIX}_v2.3.xlsx`, `${PREFIX}_v2.4.xlsx`, `${PREFIX}_v2.9-250101.xlsx`];
  names.forEach((name, i) => {
    fs.writeFileSync(path.join(dir, name), makeXlsx({ sheets: [{ name: 'S', cells: { A1: { v: `版本 ${i}` } } }] }));
    // 时间戳依次递增，保证排序稳定
    const t = new Date(Date.now() - 10000 + i * 1000);
    fs.utimesSync(path.join(dir, name), t, t);
  });
  // 干扰文件：不同族、不支持的类型
  fs.writeFileSync(path.join(dir, '另一个项目_v2.3.xlsx'), makeXlsx({ sheets: [{ name: 'S', cells: {} }] }));
  fs.writeFileSync(path.join(dir, '说明.txt'), 'x');

  const scanned = scanLineage(path.join(dir, names[0]));
  assert.deepEqual(scanned.members.map((m) => m.version), ['2.3', '2.4', '2.9-250101']);
  assert.deepEqual(scanned.members.map((m) => m.file), names);
  assert.ok(scanned.members.every((m) => m.tracked === false));

  const built = buildLineage(path.join(dir, names[1]));
  assert.equal(built.payload.lineageId, lineageKey(names[0]));
  assert.ok(fs.existsSync(built.path), 'lineage.json 应已写入');
  const saved = JSON.parse(fs.readFileSync(built.path, 'utf8'));
  assert.equal(saved.contractVersion, 1);
  assert.deepEqual(saved.members.map((m) => m.version), ['2.3', '2.4', '2.9-250101']);
});

test('previousMember/nextMember：按同族成员序取前后', () => {
  const { dir } = pathsOf('lineage-prev', 'x');
  const names = [`${PREFIX}_v2.2.xlsx`, `${PREFIX}_v2.3.xlsx`, `${PREFIX}_v2.4.xlsx`];
  const members = names.map((file) => ({ file }));
  assert.equal(previousMember(path.join(dir, names[1]), members).file, names[0]);
  assert.equal(previousMember(path.join(dir, names[0]), members), null);
  assert.equal(nextMember(path.join(dir, names[0]), members).file, names[1]);
  assert.equal(nextMember(path.join(dir, names[2]), members), null);
});
