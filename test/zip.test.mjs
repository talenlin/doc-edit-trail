// zip.mjs 单测：自造 store zip、自造 deflate zip、CRC 校验、UTF-8 文件名。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildZip, parseZip, crc32, shortHash } from '../src/core/zip.mjs';

test('buildZip → parseZip 往返：路径、内容、UTF-8 文件名', () => {
  const buf = buildZip([
    { name: 'a.txt', data: 'hello' },
    { name: '目录/中文名.xml', data: '<x>中文</x>' },
  ]);
  const zip = parseZip(buf);
  assert.deepEqual(zip.list().sort(), ['a.txt', '目录/中文名.xml'].sort());
  assert.equal(zip.readText('a.txt'), 'hello');
  assert.equal(zip.readText('目录/中文名.xml'), '<x>中文</x>');
  assert.equal(zip.has('目录/中文名.xml'), true);
  assert.equal(zip.has('不存在.txt'), false);
  assert.equal(zip.tryReadText('不存在.txt'), null);
  // 短哈希是 crc32 的 8 位十六进制
  assert.equal(shortHash(Buffer.from('hello')), crc32(Buffer.from('hello')).toString(16).padStart(8, '0'));
});

test('parseZip 校验 CRC：损坏的数据块读取时必须抛错', () => {
  const good = buildZip([{ name: 'x.bin', data: Buffer.from('0123456789') }]);
  const bad = Buffer.from(good);
  // 本地文件头 30 字节 + 文件名 5 字节之后是数据
  bad[30 + 5] = 0x99;
  // 校验发生在读数据时：构造应成功，读坏块必须报错
  const zip = parseZip(bad);
  assert.throws(() => zip.read('x.bin'), /CRC|损坏|校验/i);
  // 可以显式关闭校验
  const zipNoVerify = parseZip(bad, { verify: false });
  assert.equal(zipNoVerify.read('x.bin').length, 10);
});

/** 造一个单条目的 deflate zip（真实 OOXML 用的就是 method=8）。 */
function deflateZip(name, text) {
  const raw = Buffer.from(text, 'utf8');
  const packed = deflateRawSync(raw);
  const crc = crc32(raw);
  const nameBuf = Buffer.from(name, 'utf8');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0x0800, 6); // UTF-8 名
  lfh.writeUInt16LE(8, 8); // method = deflate
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(packed.length, 18);
  lfh.writeUInt32LE(raw.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(packed.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42); // 本地文件头在文件开头的偏移
  const cdBuf = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + packed.length, 16);
  return Buffer.concat([lfh, nameBuf, packed, cdBuf, eocd]);
}

test('deflate 条目：能解压、method/尺寸取自中央目录', () => {
  const payload = '<workbook>' + 'x'.repeat(500) + '</workbook>';
  const zip = parseZip(deflateZip('xl/workbook.xml', payload));
  assert.equal(zip.readText('xl/workbook.xml'), payload);
  const entry = zip.entries.find((e) => e.name === 'xl/workbook.xml');
  assert.equal(entry.method, 8);
  assert.ok(entry.uncompSize > 500, `原始尺寸异常：${entry.uncompSize}`);
  assert.ok(entry.compSize < entry.uncompSize, '重复字符应被压缩');
});

test('UTF-8 文件名与目录层级：中文路径可读', () => {
  const buf = buildZip([{ name: '目录/子目录/名称.xml', data: '<a/>' }]);
  const zip = parseZip(buf);
  assert.deepEqual(zip.list(), ['目录/子目录/名称.xml']);
  assert.equal(zip.readText('目录/子目录/名称.xml'), '<a/>');
  assert.equal(zip.get('目录/子目录/名称.xml').flags & 0x0800, 0x0800);
});

test('缺 EOCD 的字节流报错信息可定位', () => {
  assert.throws(() => parseZip(Buffer.from('not a zip at all')), /EOCD|zip/i);
});
