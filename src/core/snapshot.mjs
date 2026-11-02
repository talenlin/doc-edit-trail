// src/core/snapshot.mjs
// 文档 → 结构化快照。只做「读文件 + 按类型分派 + 快照落盘」，不涉及 diff。
//
// 快照是 diff 的唯一输入：同一份文件在两次落盘之间，先各自转成 JSON 结构，
// 再比结构，而不是比 OOXML 字节 —— 后者会被 WPS 的重新排版/样式重排淹没。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseZip, readZipFile } from './zip.mjs';
import { parseXlsx } from './xlsx.mjs';
import { parseDocx } from './docx.mjs';
import { parsePptx } from './pptx.mjs';
import { snapshotPath, isoLocal } from './paths.mjs';

/** 扩展名 → 文档类型。xlsm 和 xlsx 共用解析器。 */
export const DOC_EXT = new Map([
  ['.xlsx', 'xlsx'],
  ['.xlsm', 'xlsx'],
  ['.docx', 'docx'],
  ['.pptx', 'pptx'],
]);

export const DOC_TYPES = new Set(['xlsx', 'docx', 'pptx']);

export class UnsupportedDocError extends Error {
  constructor(file) {
    super(`不支持的文件类型：${path.basename(file)}（只认 .xlsx/.xlsm/.docx/.pptx）`);
    this.name = 'UnsupportedDocError';
    this.code = 'EUNSUPPORTED';
  }
}

/** 按扩展名判断文档类型；不认识的抛 UnsupportedDocError。 */
export function docTypeOf(file) {
  const ext = path.extname(String(file)).toLowerCase();
  const type = DOC_EXT.get(ext);
  if (!type) throw new UnsupportedDocError(file);
  return type;
}

export function isSupportedDoc(file) {
  return DOC_EXT.has(path.extname(String(file)).toLowerCase());
}

export function sha256Node(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 计算文件 sha256（文件都不大，实测文档一般小于 1MB，直接整读更简单）。 */
export function sha256File(file) {
  return sha256Node(fs.readFileSync(file));
}

/**
 * 读一份文档：字节、sha256、大小、mtime 一次拿全。
 * 同一个 buffer 同时用于 hash 与解析，避免「读完又被改动」导致 hash 和快照不一致。
 */
export function readDocument(file) {
  const abs = path.resolve(file);
  const buf = fs.readFileSync(abs);
  const st = fs.statSync(abs);
  return {
    file: abs,
    name: path.basename(abs),
    docType: docTypeOf(abs),
    buffer: buf,
    size: buf.length,
    mtimeMs: st.mtimeMs,
    mtime: st.mtime.toISOString(),
    sha256: sha256Node(buf),
  };
}

function isZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
}

/** 字节 → 快照（不落盘）。docType 不传则按内容/扩展名推断。 */
export function snapshotBuffer(buffer, docType, meta = {}) {
  const type = docType || meta.docType;
  if (!DOC_TYPES.has(type)) throw new UnsupportedDocError(meta.file || 'buffer');
  if (!isZip(buffer)) {
    throw new Error(`不是 ZIP/OOXML 容器（缺少 PK 魔数）：${meta.file || '<buffer>'}`);
  }
  const zip = parseZip(buffer, { verify: meta.verify !== false });
  if (type === 'xlsx') return parseXlsx(zip);
  if (type === 'docx') return parseDocx(zip);
  return parsePptx(zip);
}

/**
 * 读文件并建快照。
 * @returns {{file:string,name:string,docType:string,size:number,mtime:string,mtimeMs:number,sha256:string,snapshot:object}}
 */
export function buildSnapshot(file, opts = {}) {
  const doc = readDocument(file);
  const snapshot = snapshotBuffer(doc.buffer, doc.docType, { file: doc.file, verify: opts.verify });
  return {
    file: doc.file,
    name: doc.name,
    docType: doc.docType,
    size: doc.size,
    mtime: doc.mtime,
    mtimeMs: doc.mtimeMs,
    sha256: doc.sha256,
    snapshot,
  };
}

/** 原子写 JSON：临时文件 + rename，避免半截文件被消费者读到。 */
export function writeJsonAtomic(target, obj) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(target)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错误 */ }
    throw e;
  }
}

/** 把快照写到 `<doc>.edittrail/snapshot.json`。 */
export function saveSnapshot(built, opts = {}) {
  const payload = {
    contractVersion: 1,
    file: built.name,
    docType: built.docType,
    size: built.size,
    mtime: built.mtime,
    sha256: built.sha256,
    savedAt: isoLocal(),
    snapshot: built.snapshot,
  };
  const target = opts.path || snapshotPath(built.file);
  writeJsonAtomic(target, payload);
  return { path: target, payload };
}

/** 读 snapshot.json；不存在/损坏返回 null（调用方决定是否重建基线）。 */
export function loadSnapshot(file, opts = {}) {
  const target = opts.path || snapshotPath(file);
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(text);
    if (!payload || !payload.snapshot || !payload.docType) return null;
    return payload;
  } catch {
    return null;
  }
}

/** 快照体积（字节），用于给 journal 记录与日志一个体感指标。 */
export function snapshotBytes(snapshot) {
  return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
}

export { readZipFile };
