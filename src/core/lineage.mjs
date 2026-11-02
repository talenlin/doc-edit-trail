// src/core/lineage.mjs
// 文档族（lineage）：用户改稿习惯是「另存为新版本文件」，而不是覆盖保存。
// 同一份文档的 v2.3 和 v2.4 常常是两个不同文件，没有族索引就永远 diff 不到一起。
//
// 归一化规则与 docs/CONTRACT.md 第 4 节一致（MCP 侧 store.mjs 有同规则的实现，
// 两边必须同时改；这里加注释说明是「同一规则的引擎侧副本」）。

import fs from 'node:fs';
import path from 'node:path';
import { sha256File, isSupportedDoc, docTypeOf } from './snapshot.mjs';
import { readJournal } from './journal.mjs';
import { lineagePath, isoLocal } from './paths.mjs';
import { writeJsonAtomic } from './snapshot.mjs';

/** 文件名 → 族 key：去扩展名、去打印/副本标记、去版本号、收尾分隔符。 */
export function lineageKey(filename) {
  let s = path.basename(String(filename)).replace(/\.[^.]+$/, '');
  s = s
    .replace(/[（(]\s*打印版\s*[）)]/g, '')
    .replace(/[-_ ]?打印版$/g, '')
    .replace(/[-_ ]?(副本|copy)$/gi, '');
  s = s.replace(/[-_ ]?v\d+(\.\d+)*(-\d{6})?/gi, '');
  s = s.replace(/[-_ ]+$/, '');
  return s.trim();
}

/** 从文件名抽版本号：`_v2.3-250101.xlsx` → `2.3-250101`；没有返回 null。 */
export function extractVersion(filename) {
  const base = path.basename(String(filename)).replace(/\.[^.]+$/, '');
  const m = base.match(/[-_ ]?v(\d+(?:\.\d+)*)(-\d{6})?/i);
  return m ? m[1] + (m[2] || '') : null;
}

/** 版本号比较：数字段逐段比，日期后缀（-250101）当次级比较键。 */
export function cmpVersion(a, b) {
  const split = (v) => {
    const [num, date] = String(v || '').split('-');
    return { parts: num.split('.').map((n) => Number(n) || 0), date: Number(date) || 0 };
  };
  const x = split(a);
  const y = split(b);
  const n = Math.max(x.parts.length, y.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (x.parts[i] || 0) - (y.parts[i] || 0);
    if (d) return d;
  }
  return x.date - y.date;
}

/**
 * 扫描同目录、同扩展名、同族 key 的文件。
 * @returns {{lineageId:string, members:Array<object>, skipped:number}}
 */
export function scanLineage(file, opts = {}) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const ext = path.extname(abs).toLowerCase();
  const key = lineageKey(abs);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    throw new Error(`无法读取目录 ${dir}：${e.message}`);
  }
  const members = [];
  let skipped = 0;
  for (const name of names) {
    if (path.extname(name).toLowerCase() !== ext) continue;
    if (!isSupportedDoc(name)) continue;
    if (lineageKey(name) !== key) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    let sha256 = null;
    try {
      sha256 = sha256File(full);
    } catch {
      skipped++;
      continue;
    }
    const journal = readJournal(full);
    const last = journal.records.length ? journal.records[journal.records.length - 1] : null;
    members.push({
      file: name,
      version: extractVersion(name),
      docType: docTypeOf(name),
      size: st.size,
      sha256,
      mtime: isoLocal(st.mtime),
      mtimeMs: st.mtimeMs,
      journalSeqMax: last ? last.seq ?? null : null,
      changeCount: journal.records.reduce((n, r) => n + (Number(r.changeCount) || 0), 0),
      tracked: journal.exists,
    });
  }
  members.sort((a, b) => {
    const va = a.version;
    const vb = b.version;
    if (va && vb) return cmpVersion(va, vb);
    if (va) return -1;
    if (vb) return 1;
    return a.mtimeMs - b.mtimeMs;
  });
  return { lineageId: key, members, skipped };
}

/**
 * 生成并落盘 `<doc>.edittrail/lineage.json`。
 * @returns {{lineageId:string, members:Array<object>, path:string}}
 */
export function buildLineage(file, opts = {}) {
  const abs = path.resolve(file);
  const scanned = scanLineage(abs, opts);
  const payload = {
    contractVersion: 1,
    lineageId: scanned.lineageId,
    generatedAt: isoLocal(),
    file: path.basename(abs),
    members: scanned.members,
  };
  if (scanned.skipped) payload.skipped = scanned.skipped;
  const target = opts.path || lineagePath(abs);
  writeJsonAtomic(target, payload);
  return { ...scanned, path: target, payload };
}

/** 找同族里「紧邻的前一版」：按版本号排序后在目标之前的那个。 */
export function previousMember(file, members) {
  const name = path.basename(path.resolve(file));
  const idx = members.findIndex((m) => m.file === name);
  return idx > 0 ? members[idx - 1] : null;
}

export function nextMember(file, members) {
  const name = path.basename(path.resolve(file));
  const idx = members.findIndex((m) => m.file === name);
  return idx >= 0 && idx < members.length - 1 ? members[idx + 1] : null;
}
