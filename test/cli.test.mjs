// CLI 端到端：snapshot / diff --json / diff --md / init 跨版本 / report。
// 用合成的两个“版本”文件（v1.0 与 v2.0）跑真实 CLI 子进程，不依赖任何外部素材。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers/tmp.mjs';
import { makeXlsx } from './helpers/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli', 'edittrail.mjs');

// v1.0：总览有两级标题 + 一块“条目清单”（A2:C4），带 4 个合并区
const V1 = {
  sheets: [
    {
      name: '总览',
      dims: 'A1:F12',
      merges: ['A1:B1', 'A2:B2', 'A3:B3', 'A4:B4'],
      cells: {
        A1: { v: '示例报告 总览', s: 1 },
        B1: { v: '合计' },
        A2: { v: '条目清单（按类别）' },
        B2: { v: 12 },
        C2: { v: '项' },
        A3: { v: '类别甲' },
        B3: { v: 5 },
        A4: { v: '类别乙' },
        B4: { v: 4 },
      },
    },
    { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
  ],
};

// v2.0：整块条目清单被删掉，合并区从 4 个变 1 个
const V2 = {
  sheets: [
    {
      name: '总览',
      dims: 'A1:F12',
      merges: ['A1:B1'],
      cells: {
        A1: { v: '示例报告 总览', s: 1 },
        B1: { v: '合计' },
      },
    },
    { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
  ],
};

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: path.join(HERE, '..'),
    ...opts,
  });
}

function parseJson(res) {
  try {
    return JSON.parse(res.stdout);
  } catch {
    throw new Error(`stdout 不是 JSON:\n${res.stdout}\n--- stderr ---\n${res.stderr}`);
  }
}

function makePair() {
  const dir = tmpDir('cli-pair');
  const a = path.join(dir, '示例报告_v1.0.xlsx');
  const b = path.join(dir, '示例报告_v2.0.xlsx');
  fs.writeFileSync(a, makeXlsx(V1));
  fs.writeFileSync(b, makeXlsx(V2));
  return { dir, a, b };
}

test('CLI snapshot：-o 写快照 JSON', () => {
  const { dir, a } = makePair();
  const out = path.join(dir, 'snap.json');
  const res = run(['snapshot', a, '-o', out]);
  assert.equal(res.status, 0, res.stderr);
  const payload = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(payload.contractVersion, 1);
  assert.equal(payload.docType, 'xlsx');
  assert.equal(payload.snapshot.sheetCount, 2);
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
});

test('CLI diff --json：a/b sha256、docType、changes、counts', () => {
  const { a, b } = makePair();
  const res = run(['diff', a, b, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const j = parseJson(res);
  assert.equal(j.docType, 'xlsx');
  assert.match(j.a.sha256, /^[0-9a-f]{64}$/);
  assert.match(j.b.sha256, /^[0-9a-f]{64}$/);
  assert.ok(j.b.size > 0);
  assert.ok(j.changes.length >= 6, `改动太少：${j.changes.length}`);
  assert.ok(j.counts['cell.removed'] >= 6, JSON.stringify(j.counts));
  assert.equal(j.totalChanges, j.changes.length);
});

test('CLI diff --md：写出 markdown 差异简报', () => {
  const { dir, a, b } = makePair();
  const out = path.join(dir, 'diff.md');
  const res = run(['diff', a, b, '--md', out]);
  assert.equal(res.status, 0, res.stderr);
  const md = fs.readFileSync(out, 'utf8');
  assert.match(md, /^# 差异简报 · /);
  assert.match(md, /总览!A2|总览!B2/);
  assert.match(md, /删除：/);
});

test('CLI init 跨版本：v1.0 先建基线，v2.0 首条记录是跨版本 diff；report 能定位被删的块', () => {
  const { dir } = makePair();
  const copyA = path.join(dir, '示例报告_v1.0.xlsx');
  const copyB = path.join(dir, '示例报告_v2.0.xlsx');

  const r1 = run(['init', copyA, '--actor', 'wps-user']);
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /建立基线/);

  const r2 = run(['init', copyB, '--actor', 'wps-user']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /同族前驱/);
  assert.match(r2.stdout, /v1\.0 → v2\.0/);
  assert.match(r2.stdout, /\d+ 处/);

  // 幂等：重复 init 不追加
  const r2b = run(['init', copyB, '--actor', 'wps-user']);
  assert.equal(r2b.status, 0, r2b.stderr);
  assert.match(r2b.stdout, /未变/);

  const r3 = run(['report', copyB, '--md']);
  assert.equal(r3.status, 0, r3.stderr);
  const md = r3.stdout;
  assert.match(md, /^# 变更简报 · 示例报告_v2\.0\.xlsx/m);
  assert.match(md, /前驱快照：示例报告_v1\.0\.xlsx/);
  assert.match(md, /A2/);
  assert.match(md, /删除：/);
  assert.match(md, /合并且|合并区|merges/);
});

test('CLI 错误：不支持的扩展名给出非零退出与提示', () => {
  const dir = tmpDir('cli-bad');
  const bad = path.join(dir, 'note.txt');
  fs.writeFileSync(bad, 'hello');
  const res = run(['snapshot', bad]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr + res.stdout, /不支持|unsupported|EUNSUPPORTED/i);
});
