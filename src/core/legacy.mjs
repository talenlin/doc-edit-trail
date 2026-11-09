// src/core/legacy.mjs
// 旧版二进制格式（.doc / .xls / .ppt）的「先转换、再快照」通道。
//
// 为什么需要它：.doc/.xls/.ppt 是 OLE2 复合文档 + Office 97 二进制格式，
// 不是 ZIP+XML，没法像 .docx 那样解包比结构。最省事、精度也最高的办法是
// 用装了 WPS/Office 的机器把它们另存成 OOXML，再交给现有引擎。
//
// 关键约束：
// - 转换必须走独立的应用实例；如果 COM 连到了用户正在用的实例（能数出文档），
//   只做 Open/SaveAs/Close，绝不 Quit，也绝不改 Visible。
// - 转换产物按「源文件 sha256」缓存在记录目录里，同一个字节版本只转一次。
// - 转换失败不吞：抛错交给 journal/watch 记录，界面仍能看到「这份文件没记上」。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { recordsDir } from './paths.mjs';

/** 旧格式 → 目标 OOXML 类型。 */
export const LEGACY_EXT = new Map([
  ['.doc', 'docx'],
  ['.docm', 'docx'],
  ['.xls', 'xlsx'],
  ['.xlt', 'xlsx'],
  ['.ppt', 'pptx'],
  ['.pps', 'pptx'],
]);

const TARGET_EXT = { docx: '.docx', xlsx: '.xlsx', pptx: '.pptx' };

const here = path.dirname(fileURLToPath(import.meta.url));
const CONVERT_SCRIPT = path.resolve(here, '..', '..', 'tools', 'convert-legacy.ps1');

export function legacyTypeOf(file) {
  return LEGACY_EXT.get(path.extname(String(file)).toLowerCase()) || null;
}

export function isLegacyDoc(file) {
  return legacyTypeOf(file) !== null;
}

export function sourceFormatOf(file) {
  return path.extname(String(file)).slice(1).toLowerCase();
}

/** 转换产物缓存目录：`<记录目录>/<文档名>.edittrail/converted/`。 */
export function convertedDir(file) {
  return path.join(recordsDir(file), `${path.basename(file)}.edittrail`, 'converted');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 默认转换器：调 tools/convert-legacy.ps1（WPS COM，独立实例）。 */
export function comConverter({ kind, src, dst, timeoutMs = 180000 }) {
  execFileSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', CONVERT_SCRIPT, '-Kind', kind, '-Src', src, '-Dst', dst],
    { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (!fs.existsSync(dst)) throw new Error(`转换器没有产出文件：${path.basename(dst)}`);
  return dst;
}

/**
 * 把一份旧格式文件转成 OOXML 字节（带缓存）。
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {Function} [opts.converter] 注入转换器（测试用）；签名 ({kind, src, dst}) => void
 * @param {string} [opts.cacheDir] 覆盖缓存目录
 * @param {boolean} [opts.force] 忽略缓存重新转换
 * @returns {{buffer:Buffer, sha256:string, cached:boolean, convertedPath:string, kind:string}}
 */
export function convertLegacy(file, opts = {}) {
  const abs = path.resolve(file);
  const kind = legacyTypeOf(abs);
  if (!kind) throw new Error(`不是旧格式文档：${path.basename(abs)}`);
  const sourceSha = sha256(fs.readFileSync(abs));
  const dir = opts.cacheDir || convertedDir(abs);
  const target = path.join(dir, `${sourceSha}${TARGET_EXT[kind]}`);
  const converter = opts.converter || comConverter;

  if (!opts.force && fs.existsSync(target)) {
    return { buffer: fs.readFileSync(target), sha256: sourceSha, cached: true, convertedPath: target, kind };
  }

  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.convert-${process.pid}-${Date.now()}${TARGET_EXT[kind]}`);
  try {
    converter({ kind, src: abs, dst: tmp });
    const buf = fs.readFileSync(tmp);
    if (!buf.length) throw new Error('转换结果为空');
    fs.renameSync(tmp, target);
    return { buffer: buf, sha256: sourceSha, cached: false, convertedPath: target, kind };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* 清理失败不掩盖原错误 */ }
    throw new Error(`旧格式转换失败（${path.basename(abs)}）：${e && e.message ? e.message : e}`);
  }
}

/** 批量转换的落点：`<dir>/<name>.docx`（与源文件同目录）。 */
export function siblingTarget(file) {
  const kind = legacyTypeOf(file);
  if (!kind) return null;
  const abs = path.resolve(file);
  const base = path.basename(abs, path.extname(abs));
  return path.join(path.dirname(abs), base + TARGET_EXT[kind]);
}
