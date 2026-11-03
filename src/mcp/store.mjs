// edit-trail · MCP 侧数据读取层
// 只依赖 docs/CONTRACT.md 定义的落盘格式；路径解析复用引擎的 paths.mjs，
// 保证「revised record/」新布局与旧布局回退只有一处实现。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { edittrailDir, journalPath, recordsDir } from '../core/paths.mjs';

export const DOC_EXTS = new Set(['.xlsx', '.xlsm', '.docx', '.pptx']);
export { edittrailDir, journalPath, recordsDir };

/** 读 journal：损坏行不抛错，返回计数 */
export function readJournal(file) {
  const jp = journalPath(file);
  const out = { path: jp, exists: fs.existsSync(jp), records: [], badLines: 0 };
  if (!out.exists) return out;
  let text;
  try {
    text = fs.readFileSync(jp, 'utf8');
  } catch (e) {
    out.error = String(e && e.message || e);
    return out;
  }
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.records.push(JSON.parse(s));
    } catch {
      out.badLines++;
    }
  }
  out.records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return out;
}

export function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

export function readReaders(file) {
  const p = path.join(edittrailDir(file), 'readers.json');
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { readers: {} };
  }
}

export function writeReaders(file, data) {
  const p = path.join(edittrailDir(file), 'readers.json');
  try {
    writeJsonAtomic(p, data);
  } catch (e) {
    // 只读目录时不致命
    return { ok: false, error: String(e && e.message || e) };
  }
  return { ok: true };
}

/** 文档族归一化：去扩展名 → 去打印/副本标记 → 去 _v2.3-261101 / v2.3 → 收敛分隔符 */
export function lineageKey(filename) {
  let s = path.basename(filename).replace(/\.[^.]+$/, '');
  s = s.replace(/[（(]\s*打印版\s*[）)]/g, '')
       .replace(/[-_ ]?打印版$/g, '')
       .replace(/[-_ ]?(副本|copy)$/gi, '');
  s = s.replace(/[-_ ]?v\d+(\.\d+)*(-\d{6})?/gi, '');
  s = s.replace(/[-_ ]+$/, '');
  return s.trim();
}

export function extractVersion(filename) {
  const base = path.basename(filename).replace(/\.[^.]+$/, '');
  const m = base.match(/[-_ ]?v(\d+(?:\.\d+)*)(-\d{6})?/i);
  return m ? m[1] + (m[2] || '') : null;
}

function sha8(s) {
  return s ? crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8) : null;
}

/**
 * 找同族文件（含自己）。同目录、同扩展名、lineageKey 相同、且存在 journal 的优先。
 */
export function listLineage(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const ext = path.extname(abs).toLowerCase();
  const key = lineageKey(abs);
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [path.basename(abs)];
  }
  const members = [];
  for (const n of names) {
    if (path.extname(n).toLowerCase() !== ext) continue;
    if (lineageKey(n) !== key) continue;
    const full = path.join(dir, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const j = readJournal(full);
    const last = j.records.length ? j.records[j.records.length - 1] : null;
    members.push({
      file: full,
      name: n,
      version: extractVersion(n),
      mtime: st.mtime.toISOString(),
      size: st.size,
      tracked: j.exists,
      journalSeqMax: last ? last.seq ?? null : null,
      sha256: last ? last.sha256 ?? null : null,
      changeCount: j.records.reduce((a, r) => a + (r.changeCount || 0), 0),
    });
  }
  members.sort((a, b) => {
    const va = a.version || '', vb = b.version || '';
    if (va && vb) return cmpVersion(va, vb);
    return a.mtime < b.mtime ? -1 : a.mtime > b.mtime ? 1 : 0;
  });
  return { lineageId: key, members };
}

function cmpVersion(a, b) {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 解析 since：sha 前缀 / seq / 版本号 / ISO 时间 / 相对时间(30m,12h,1d)
 * 语义：sha 表示"已看过的那个状态"，故返回它之后的一条（index+1）；
 * seq 表示"已看过 seq 及以前"，同样返回 seq 之后。
 */
export function resolveSince(records, since) {
  if (!since) return null;
  const s = String(since).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    const seq = Number(s);
    return { kind: 'seq', index: records.findIndex(r => (r.seq ?? 0) > seq), label: `seq>${seq}` };
  }
  if (/^v?\d+\.\d+/.test(s)) {
    const v = s.replace(/^v/, '');
    const idx = records.findIndex(r => String(r.version ?? '').replace(/^v/, '') === v);
    return { kind: 'version', index: idx, label: `从 v${v} 起` };
  }
  // 相对时间：30m / 12h / 1d
  const rel = s.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[rel[2].toLowerCase()];
    const t = Date.now() - n * unit;
    return { kind: 'time', index: records.findIndex(r => (r.tsMs ?? Date.parse(r.ts)) > t), label: `近 ${s}` };
  }
  // sha 前缀 → 该状态的"下一次落盘"起
  const lastHit = records.reduce((acc, r, i) => ((r.sha256 || '').startsWith(s) ? i : acc), -1);
  if (lastHit >= 0) return { kind: 'sha', index: lastHit + 1, label: `since ${s.slice(0, 8)}` };
  // ISO 时间
  const t = Date.parse(s);
  if (!Number.isNaN(t)) {
    return { kind: 'time', index: records.findIndex(r => (r.tsMs ?? Date.parse(r.ts)) > t), label: `since ${s}` };
  }
  return { kind: 'unknown', index: -1, label: s };
}

export function readerKey(reader) {
  if (reader && String(reader).trim()) return String(reader).trim();
  const sess = process.env.EDITTRAIL_SESSION_ID || process.env.DSH_SESSION_ID;
  return sess ? `llm:${sess}` : 'human:default';
}

export function shortSha(s) {
  return sha8(s);
}

/** 把 document 的绝对路径归一为可展示的名字 */
export function displayName(file) {
  return path.basename(file);
}
