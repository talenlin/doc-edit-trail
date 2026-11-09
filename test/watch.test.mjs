import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectDocs, watchOnce } from '../src/core/watch.mjs';
import { makeXlsx } from './helpers/fixtures.mjs';

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `edittrail-watch-${tag}-`));
}

function writeNestedXlsx(root) {
  const deep = path.join(root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  const file = path.join(deep, 'nested.xlsx');
  fs.writeFileSync(file, makeXlsx({ sheets: [{ name: 'S1', cells: { A1: 'x' } }] }));
  return file;
}

test('collectDocs 默认只看一层，recursive 才能找到嵌套文档', () => {
  const root = tmpdir('collect');
  try {
    writeNestedXlsx(root);
    assert.equal(collectDocs(root).length, 0);
    const rec = collectDocs(root, { recursive: true });
    assert.equal(rec.length, 1);
    assert.equal(path.basename(rec[0].file), 'nested.xlsx');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('recursive watch 给嵌套文档建基线，第二轮不变', () => {
  const root = tmpdir('baseline');
  try {
    writeNestedXlsx(root);
    const opts = { actor: 'wps-user', baseline: true, recursive: true, requireStable: false };
    const first = watchOnce(root, opts);
    assert.equal(first.docs, 1);
    assert.equal(first.baselined.length, 1);
    assert.equal(first.errors.length, 0);

    const second = watchOnce(root, { ...opts, state: new Map([[first.baselined[0].file, stableSig(root)]]) });
    // state 未命中签名时应视为变化后重算，但内容没变 → 不新增记录
    assert.equal(second.recorded.length, 0);
    assert.equal(second.errors.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function stableSig(root) {
  const file = path.join(root, 'a', 'b', 'nested.xlsx');
  const st = fs.statSync(file);
  return `${st.size}:${Math.round(st.mtimeMs)}`;
}
