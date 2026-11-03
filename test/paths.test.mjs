// paths.mjs / 布局迁移单测：
// 新布局 <dir>/revision history/<doc>.edittrail；
// 旧布局（文档旁边的 <doc>.edittrail 与中间版本的 revised record/）仍可读并自动搬迁。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeXlsx } from './helpers/fixtures.mjs';
import { pathsOf } from './helpers/tmp.mjs';
import {
  RECORDS_DIRNAME,
  LEGACY_RECORDS_DIRNAMES,
  newEdittrailDir,
  legacyEdittrailDir,
  edittrailDir,
} from '../src/core/paths.mjs';
import { initBaseline, recordVersion, readJournal, migrateDocDir } from '../src/core/journal.mjs';

const SPEC = { sheets: [{ name: 'Sheet1', cells: { A1: { v: 'x' }, B2: { v: 12 } } }] };

function write(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, makeXlsx(SPEC));
  return file;
}

test('新布局：记录落在 <目录>/revision history/<文档>.edittrail', () => {
  const { dir, file } = pathsOf('layout-new', '报告_v1.0.xlsx');
  write(file);
  initBaseline(file, { source: 'cli' });
  const next = newEdittrailDir(file);
  assert.equal(path.dirname(next), path.join(dir, RECORDS_DIRNAME));
  assert.ok(fs.existsSync(path.join(next, 'journal.jsonl')));
  assert.ok(!fs.existsSync(legacyEdittrailDir(file)), '不应再产生最旧布局目录');
});

test('最旧布局：文档旁的 .edittrail 可读，首次写入自动搬进 revision history/', () => {
  const { file } = pathsOf('layout-legacy', '报告_v2.0.xlsx');
  write(file);
  const legacy = legacyEdittrailDir(file);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'journal.jsonl'), '{"seq":1,"sha256":"x","summary":"旧记录"}\n');

  assert.equal(edittrailDir(file), legacy, '新位置不存在时应回退最旧位置');
  assert.equal(readJournal(file).records.length, 1, '旧记录必须仍可读');

  recordVersion(file, { source: 'cli', force: true });
  assert.ok(fs.existsSync(newEdittrailDir(file)), '写入后应落在新布局');
  assert.ok(!fs.existsSync(legacy), '旧目录应已搬走');
  const j = readJournal(file);
  assert.equal(j.records[0].summary, '旧记录');
  assert.equal(j.records.length, 2);
});

test('中间布局：revised record/ 也能读，并搬进 revision history/', () => {
  const { dir, file } = pathsOf('layout-mid', '报告_v2.5.xlsx');
  write(file);
  const oldName = LEGACY_RECORDS_DIRNAMES[0];
  const mid = path.join(dir, oldName, path.basename(file) + '.edittrail');
  fs.mkdirSync(mid, { recursive: true });
  fs.writeFileSync(path.join(mid, 'journal.jsonl'), '{"seq":1,"sha256":"y","summary":"中间布局记录"}\n');

  assert.equal(edittrailDir(file), mid, '应回退到中间布局目录');
  assert.equal(readJournal(file).records.length, 1);

  recordVersion(file, { source: 'cli', force: true });
  assert.ok(fs.existsSync(newEdittrailDir(file)));
  assert.ok(!fs.existsSync(mid), '中间布局目录应已搬走');
  assert.equal(readJournal(file).records.length, 2);
});

test('migrateDocDir：目标已存在时合并，不覆盖新文件', () => {
  const { file } = pathsOf('layout-merge', '报告_v3.0.xlsx');
  write(file);
  const legacy = legacyEdittrailDir(file);
  const next = newEdittrailDir(file);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'lineage.json'), '{"old":true}');
  fs.mkdirSync(next, { recursive: true });
  fs.writeFileSync(path.join(next, 'journal.jsonl'), '{"seq":1}\n');

  const res = migrateDocDir(file);
  assert.equal(res.moved, true);
  assert.ok(!fs.existsSync(legacy));
  assert.equal(fs.readFileSync(path.join(next, 'journal.jsonl'), 'utf8'), '{"seq":1}\n');
  assert.ok(fs.existsSync(path.join(next, 'lineage.json')), '旧文件应合并进来');
});

test('migrateDocDir：无旧目录是空操作', () => {
  const { file } = pathsOf('layout-none', '报告_v4.0.xlsx');
  write(file);
  const res = migrateDocDir(file);
  assert.equal(res.moved, false);
  assert.ok(!fs.existsSync(newEdittrailDir(file)));
});
