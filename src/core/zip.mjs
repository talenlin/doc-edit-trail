// src/core/zip.mjs
// 零依赖 ZIP 读取器：只读，支持 stored(0) / deflate(8)、data descriptor、ZIP64、
// UTF-8 文件名（flag bit 11）。不依赖任何 npm 包，只用 node:zlib。
//
// 设计要点（为什么不用第三方包）：
//   - OOXML 文件很小（<几 MB），整文件读进内存即可；
//   - 本地文件头里的名称/额外字段长度可能和中央目录不一致，尺寸必须取中央目录；
//   - WPS 写出的 zip 有时带 data descriptor（flag bit 3），此时本地头尺寸字段为 0，
//     所以一律以中央目录为准，并按本地头计算数据起点。

import { readFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // 中央目录结束
const SIG_EOCD64 = 0x06064b50; // ZIP64 中央目录结束
const SIG_EOCD64_LOC = 0x07064b50; // ZIP64 定位器
const SIG_CD = 0x02014b50; // 中央目录条目
const SIG_LFH = 0x04034b50; // 本地文件头

// ---------------------------------------------------------------- CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** 计算 CRC32（用于 ZIP 完整性校验 / 写测试 fixture）。 */
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---------------------------------------------------------------- 文件名解码
function decodeName(bytes, flags) {
  // flag bit 11 = 0x0800：明确 UTF-8。否则先按 UTF-8 试，失败退回 latin1。
  if (flags & 0x0800) return bytes.toString('utf8');
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return bytes.toString('latin1');
}

// ---------------------------------------------------------------- 读取
function findEocd(buf) {
  // EOCD 至少 22 字节，注释最长 65535。从尾部往前找第一条合法签名。
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) !== SIG_EOCD) continue;
    // 用注释长度做一次自洽校验，避免把数据区里的 0x06054b50 误当 EOCD
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error('zip: 找不到 EOCD（不是 zip 文件或已截断）');
}

function readZip64Eocd(buf, eocdOffset) {
  if (eocdOffset < 20) return null;
  const locatorOffset = eocdOffset - 20;
  if (buf.readUInt32LE(locatorOffset) !== SIG_EOCD64_LOC) return null;
  // ZIP64 EOCD 记录所在偏移是 8 字节小端；实际只用到低 32 位（本工具场景足够）
  const z64Offset = Number(buf.readBigUInt64LE(locatorOffset + 8));
  if (z64Offset + 56 > buf.length) return null;
  if (buf.readUInt32LE(z64Offset) !== SIG_EOCD64) return null;
  return {
    totalEntries: Number(buf.readBigUInt64LE(z64Offset + 32)),
    cdSize: Number(buf.readBigUInt64LE(z64Offset + 40)),
    cdOffset: Number(buf.readBigUInt64LE(z64Offset + 48)),
  };
}

function readZip64Extra(extra) {
  // extra 字段序列：headerId(2) size(2) data(size)
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) return extra.subarray(p + 4, p + 4 + size);
    p += 4 + size;
  }
  return null;
}

/**
 * 解析内存中的 zip 数据。
 * @param {Buffer} buf
 * @param {{verify?: boolean, encodingFallback?: boolean}} [opts]
 * @returns {ZipArchive}
 */
export function parseZip(buf, opts = {}) {
  if (!Buffer.isBuffer(buf)) throw new TypeError('parseZip: 需要 Buffer');
  if (buf.length < 22) throw new Error('zip: 文件太小，不是有效 zip');
  const eocd = findEocd(buf);

  let totalEntries = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const z64 = readZip64Eocd(buf, eocd);
    if (z64) {
      totalEntries = z64.totalEntries;
      cdSize = z64.cdSize;
      cdOffset = z64.cdOffset;
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CD) {
      throw new Error(`zip: 中央目录第 ${i} 条损坏（offset=${p}）`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let lfhOffset = buf.readUInt32LE(p + 42);

    const nameBuf = buf.subarray(p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    const name = decodeName(nameBuf, flags);

    if (compSize === 0xffffffff || uncompSize === 0xffffffff || lfhOffset === 0xffffffff) {
      const z64 = readZip64Extra(extra);
      if (z64) {
        let q = 0;
        if (uncompSize === 0xffffffff) { uncompSize = Number(z64.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(z64.readBigUInt64LE(q)); q += 8; }
        if (lfhOffset === 0xffffffff) { lfhOffset = Number(z64.readBigUInt64LE(q)); q += 8; }
      }
    }

    entries.push({
      name, flags, method, crc32: crc, compSize, uncompSize, lfhOffset,
      isDirectory: name.endsWith('/'),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return new ZipArchive(buf, entries, { verify: opts.verify !== false });
}

/** 从文件路径读取 zip。 */
export function readZipFile(path, opts = {}) {
  return parseZip(readFileSync(path), opts);
}

export class ZipArchive {
  constructor(buf, entries, opts = {}) {
    this._buf = buf;
    this.entries = entries;
    this._opts = opts;
    this._byName = new Map();
    for (const e of entries) if (!e.isDirectory) this._byName.set(e.name, e);
    this._cache = new Map();
  }

  get byteLength() { return this._buf.length; }

  /** @returns {string[]} 全部文件条目名（不含目录） */
  list() {
    return [...this._byName.keys()];
  }

  has(name) { return this._byName.has(name); }

  get(name) { return this._byName.get(name) || null; }

  /** 按文件名读取并解压，返回 Buffer。 */
  read(name) {
    if (this._cache.has(name)) return this._cache.get(name);
    const e = this._byName.get(name);
    if (!e) throw new Error(`zip: 条目不存在: ${name}`);
    const buf = this._extract(e);
    this._cache.set(name, buf);
    return buf;
  }

  /** 按文件名读取为 UTF-8 文本（去掉 BOM）。 */
  readText(name) {
    let s = this.read(name).toString('utf8');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    return s;
  }

  /** 尝试读取，不存在返回 null（用于可选部件，如 headers）。 */
  tryRead(name) {
    return this._byName.has(name) ? this.read(name) : null;
  }

  tryReadText(name) {
    return this._byName.has(name) ? this.readText(name) : null;
  }

  _extract(e) {
    const L = e.lfhOffset;
    if (L + 30 > this._buf.length || this._buf.readUInt32LE(L) !== SIG_LFH) {
      throw new Error(`zip: 本地文件头损坏: ${e.name}`);
    }
    const nameLen = this._buf.readUInt16LE(L + 26);
    const extraLen = this._buf.readUInt16LE(L + 28);
    const dataStart = L + 30 + nameLen + extraLen;
    const dataEnd = dataStart + e.compSize;
    if (dataEnd > this._buf.length) throw new Error(`zip: 数据越界: ${e.name}`);
    const raw = this._buf.subarray(dataStart, dataEnd);

    let out;
    if (e.method === 0) out = Buffer.from(raw); // stored
    else if (e.method === 8) {
      try {
        out = inflateRawSync(raw);
      } catch (err) {
        throw new Error(`zip: 解压失败 ${e.name}: ${err.message}`);
      }
    } else {
      throw new Error(`zip: 不支持的压缩方法 ${e.method}: ${e.name}`);
    }
    if (out.length !== e.uncompSize) {
      throw new Error(`zip: 解压后长度不符 ${e.name}: ${out.length} != ${e.uncompSize}`);
    }
    if (this._opts.verify) {
      const actual = crc32(out);
      if (actual !== e.crc32) {
        throw new Error(`zip: CRC32 校验失败 ${e.name}: ${actual.toString(16)} != ${e.crc32.toString(16)}`);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- 写入（仅测试 fixture 用）
/**
 * 生成一个 store 模式的 zip（不压缩，足够构造测试 fixture / 最小化样本）。
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @returns {Buffer}
 */
export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const DOS_TIME = 0;
  const DOS_DATE = 0x21; // 1980-01-01

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const flags = nameBuf.toString('utf8') === f.name && /^[\x20-\x7e]+$/.test(f.name) ? 0 : 0x0800;

    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(SIG_LFH, 0);
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(flags, 6);
    lfh.writeUInt16LE(0, 8); // method
    lfh.writeUInt16LE(DOS_TIME, 10);
    lfh.writeUInt16LE(DOS_DATE, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(data.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    chunks.push(lfh, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CD, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

/** 把文件列表写成 store 模式 zip 文件（测试 fixture 用）。 */
export function writeZipFile(path, files) {
  writeFileSync(path, buildZip(files));
}

/** xxhash-ish 稳定短 hash，用于给二进制部件（图片）做指纹，不引入 crypto 依赖。 */
export function shortHash(buf) {
  return crc32(buf).toString(16).padStart(8, '0');
}
