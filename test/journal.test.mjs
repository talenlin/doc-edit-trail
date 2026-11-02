// journal.mjs 单测：追加、幂等、损坏行容忍、锁互斥与陈旧锁接管、跨版本首条记录。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeXlsx } from './helpers/fixtures.mjs';
import { initBaseline, recordVersion, readJournal, lastRecord, acquireLock, JournalLockError } from '../src/core/journal.mjs';
import { ensureInitialRecord, findPredecessor } from '../src/core/initial.mjs';
import { pathsOf } from './helpers/tmp.mjs';

const BASE_SPEC = {
  sheets: [
    {
      name: '总览',
      cells: { A1: { v: '示例文档 项目' }, A2: { v: '明细表' }, B2: { v: 12 }, C3: { v: '待删' } },
      merges: ['A1:A1'],
    },
    { name: '数据', cells: { A1: { v: 'x' } } },
  ],
};

const EDIT_SPEC = {
  sheets: [
    {
      name: '总览',
      cells: { A1: { v: '示例文档 项目' }, A2: { v: '明细表（10 项）' }, B2: { v: 10 } },
      merges: [],
    },
    { name: '数据', cells: { A1: { v: 'x' } } },
  ],
};

function writeXlsx(file, spec) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeXlsx(spec));
  return file;
}

test('initBaseline：建基线记录 seq=1、changeCount=0', () => {
  const { dir, file } = pathsOf('journal-baseline', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, BASE_SPEC);
  const res = initBaseline(file, { actor: 'wps-user', source: 'cli' });
  assert.equal(res.action, 'created');
  const rec = res.record;
  assert.equal(rec.seq, 1);
  assert.equal(rec.changeCount, 0);
  assert.equal(rec.actor, 'wps-user');
  assert.equal(rec.source, 'cli');
  assert.equal(rec.file, '示例文档报告_v1.0.xlsx'); // 契约规定存 basename
  assert.equal(rec.docType, 'xlsx');
  assert.match(rec.summary, /建立基线/);
  assert.match(rec.sha256, /^[0-9a-f]{64}$/);
  assert.equal(rec.prevSha256, null);
  const j = readJournal(file);
  assert.equal(j.records.length, 1);
  assert.equal(j.badLines, 0);
});

test('recordVersion：内容变化 → 追加 seq=2，prevSha256 指向上一条', () => {
  const { file } = pathsOf('journal-append', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, BASE_SPEC);
  const base = initBaseline(file, { actor: 'unknown', source: 'cli' });
  // 模拟用户另存回同一文件
  writeXlsx(file, EDIT_SPEC);
  const res = recordVersion(file, { actor: 'wps-user', source: 'watcher' });
  assert.equal(res.action, 'appended');
  const rec = res.record;
  assert.equal(rec.seq, 2);
  assert.ok(rec.changeCount > 0, '应有改动');
  assert.equal(rec.prevSha256, base.record.sha256);
  assert.equal(rec.seqInLineage, 2);
  assert.equal(rec.source, 'watcher');
  const kinds = rec.counts;
  assert.ok((kinds['cell.changed'] || 0) >= 1, JSON.stringify(kinds));
  // 锚点必须是 Sheet!A1 形式，且带 总览 前缀
  assert.ok(rec.changes.some((c) => c.anchor.startsWith('总览!')), JSON.stringify(rec.changes));
});

test('recordVersion 幂等：同 sha 重复调用不追加', () => {
  const { file } = pathsOf('journal-idem', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, BASE_SPEC);
  initBaseline(file, { source: 'cli' });
  writeXlsx(file, EDIT_SPEC);
  recordVersion(file, { source: 'cli' });
  const again = recordVersion(file, { source: 'cli' });
  assert.equal(again.action, 'unchanged');
  assert.equal(again.record, null);
  assert.equal(readJournal(file).records.length, 2);
});

test('readJournal：损坏行跳过并计入 badLines', () => {
  const { file } = pathsOf('journal-corrupt', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, BASE_SPEC);
  initBaseline(file, { source: 'cli' });
  const jp = path.join(path.dirname(file), '示例文档报告_v1.0.xlsx.edittrail', 'journal.jsonl');
  fs.appendFileSync(jp, '\n{ this is not json\n');
  const j = readJournal(file);
  assert.equal(j.records.length, 1);
  assert.ok(j.badLines >= 1, `badLines=${j.badLines}`);
  // 损坏行之后仍可继续追加
  writeXlsx(file, EDIT_SPEC);
  assert.equal(recordVersion(file, { source: 'cli' }).action, 'appended');
  assert.equal(readJournal(file).records.length, 2);
});

test('锁：并发持有时抛 ELOCKED，陈旧锁（进程已死）可接管', () => {
  const { file } = pathsOf('journal-lock', '示例文档报告_v1.0.xlsx');
  writeXlsx(file, BASE_SPEC);
  initBaseline(file, { source: 'cli' });
  const release = acquireLock(file, { waitMs: 0 });
  assert.throws(() => acquireLock(file, { waitMs: 0 }), (err) => err instanceof JournalLockError && err.code === 'ELOCKED');
  release();
  // 释放后可再次获取
  const r2 = acquireLock(file, { waitMs: 100 });
  r2();
  // 伪造一个死进程的锁 → 应被判定为陈旧并强拆
  const lockFile = path.join(path.dirname(file), '示例文档报告_v1.0.xlsx.edittrail', 'journal.lock');
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, token: 'dead', startedAt: Date.now() - 60000 }));
  const r3 = acquireLock(file, { waitMs: 200 });
  r3();
  assert.ok(!fs.existsSync(lockFile), '陈旧锁应被清理');
});

test('跨版本：同族前驱有快照时，新版本首条记录是跨版本 diff', () => {
  const { dir } = pathsOf('initial-lineage', 'x');
  const v23 = writeXlsx(path.join(dir, '示例文档报告_v2.3.xlsx'), BASE_SPEC);
  const v24 = writeXlsx(path.join(dir, '示例文档报告_v2.4.xlsx'), EDIT_SPEC);

  initBaseline(v23, { actor: 'wps-user', source: 'cli' });

  const prec = findPredecessor(v24);
  assert.ok(prec, '应找到前驱');
  assert.equal(prec.file, '示例文档报告_v2.3.xlsx');
  assert.equal(prec.version, '2.3');
  assert.ok(prec.snapshot, '前驱应带快照');

  const res = ensureInitialRecord(v24, { actor: 'wps-user', source: 'cli' });
  assert.equal(res.action, 'created');
  const rec = res.record;
  assert.ok(rec.changeCount > 0, `跨版本 diff 不应为 0：${JSON.stringify(rec.summary)}`);
  assert.deepEqual(rec.lineageFrom && rec.lineageFrom.file, '示例文档报告_v2.3.xlsx');
  assert.equal(rec.lineageFrom.version, '2.3');
  assert.match(rec.summary, /v2\.3 → v2\.4/);
  assert.match(rec.summary, /处/);
  assert.ok(rec.changes.some((c) => c.anchor.startsWith('总览!')), JSON.stringify(rec.changes.map((c) => c.anchor)));

  // 幂等：再次 ensureInitialRecord 不追加
  const again = ensureInitialRecord(v24, { actor: 'wps-user', source: 'cli' });
  assert.equal(again.action, 'unchanged');
  assert.equal(readJournal(v24).records.length, 1);
});

test('跨版本：前驱存在但无快照时，回落为基线并注明', () => {
  const { dir } = pathsOf('initial-nosnap', 'x');
  const v23 = writeXlsx(path.join(dir, '示例文档报告_v2.3.xlsx'), BASE_SPEC);
  const v24 = writeXlsx(path.join(dir, '示例文档报告_v2.4.xlsx'), EDIT_SPEC);
  initBaseline(v23, { source: 'cli' });
  // 删掉前驱快照，模拟「没跑过 init 的旧文件」
  fs.rmSync(path.join(dir, '示例文档报告_v2.3.xlsx.edittrail', 'snapshot.json'));
  const rec = ensureInitialRecord(v24, { source: 'cli' }).record;
  assert.equal(rec.changeCount, 0);
  assert.match(rec.summary, /前驱无快照/);
});
