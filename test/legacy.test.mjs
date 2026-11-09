import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { convertLegacy, isLegacyDoc, legacyTypeOf, siblingTarget } from '../src/core/legacy.mjs';
import { buildSnapshot, docTypeOf, isSupportedDoc } from '../src/core/snapshot.mjs';
import { makeDocx } from './helpers/fixtures.mjs';

const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `edittrail-legacy-${tag}-`));
}

/** 造一个「看起来像 .doc」的文件；内容不必是合法 OLE2，我们只测转换通道。 */
function writeFakeDoc(root, name = '旧稿.doc') {
  const file = path.join(root, name);
  fs.writeFileSync(file, Buffer.concat([OLE_MAGIC, Buffer.from('legacy-bytes')]));
  return file;
}

/** 假转换器：把源文件「转成」一份最小 docx，并记录调用。 */
function fakeConverter(calls) {
  return ({ kind, src, dst }) => {
    calls.push({ kind, src, dst });
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, makeDocx({ paragraphs: [{ text: '第一段', paraId: 'AA000001' }] }));
  };
}

test('旧格式扩展名识别与同目录落点', () => {
  assert.equal(legacyTypeOf('a.DOC'), 'docx');
  assert.equal(legacyTypeOf('a.xls'), 'xlsx');
  assert.equal(legacyTypeOf('a.ppt'), 'pptx');
  assert.equal(legacyTypeOf('a.docx'), null);
  assert.equal(isLegacyDoc('a.doc'), true);
  assert.equal(isSupportedDoc('a.doc'), true);
  assert.equal(isSupportedDoc('a.txt'), false);
  assert.equal(docTypeOf('a.doc'), 'docx');
  assert.equal(siblingTarget('D:/x/旧稿.doc'), path.join('D:/x', '旧稿.docx'));
});

test('convertLegacy 按源文件 sha 缓存，同一版本只转换一次', () => {
  const root = tmpdir('cache');
  try {
    const src = writeFakeDoc(root);
    const cacheDir = path.join(root, 'cache');
    const calls = [];
    const converter = fakeConverter(calls);

    const first = convertLegacy(src, { cacheDir, converter });
    assert.equal(first.cached, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, 'docx');
    assert.ok(first.buffer.length > 0);
    assert.ok(fs.existsSync(first.convertedPath));

    const second = convertLegacy(src, { cacheDir, converter });
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('convertLegacy 内容变了会重新转换，失败时抛错且不留半成品', () => {
  const root = tmpdir('fail');
  try {
    const src = writeFakeDoc(root);
    const cacheDir = path.join(root, 'cache');
    const calls = [];
    const converter = fakeConverter(calls);
    convertLegacy(src, { cacheDir, converter });
    fs.appendFileSync(src, Buffer.from('more'));
    convertLegacy(src, { cacheDir, converter });
    assert.equal(calls.length, 2);

    const broken = path.join(root, '坏.doc');
    fs.writeFileSync(broken, OLE_MAGIC);
    assert.throws(
      () => convertLegacy(broken, { cacheDir, converter: () => { throw new Error('COM 失败'); } }),
      /旧格式转换失败（坏\.doc）：COM 失败/,
    );
    const leftovers = fs.existsSync(cacheDir)
      ? fs.readdirSync(cacheDir).filter((f) => f.startsWith('.convert-'))
      : [];
    assert.deepEqual(leftovers, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('buildSnapshot 对 .doc 用转换结果建快照，sha256 仍是源文件字节', () => {
  const root = tmpdir('snap');
  try {
    const src = writeFakeDoc(root);
    const built = buildSnapshot(src, { cacheDir: path.join(root, 'cache'), converter: fakeConverter([]) });
    assert.equal(built.docType, 'docx');
    assert.equal(built.name, '旧稿.doc');
    assert.equal(built.sourceFormat, 'doc');
    assert.ok(built.convertedBytes > 0);
    assert.ok(built.convertedFrom);
    const paragraphs = built.snapshot.paragraphs || [];
    assert.equal(paragraphs.length, 1);
    assert.equal(paragraphs[0].text, '第一段');
    // sha256 必须取原 .doc，而不是转换后的 docx，否则「另存 docx」会被误判成变化
    assert.match(built.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(built.sha256, built.snapshot.sha256 || '');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
