// src/core/journal.mjs
// 追加式变更日志（docs/CONTRACT.md 第 2 节）。
//
// 几个刻意的工程决定：
// 1) 原子性：契约要求「写临时文件 + rename 替换整个文件」。这里遵守，且保留
//    原有的坏行（不因为一次写而丢弃历史里的损毁内容）。
// 2) 并发：journal.lock 记录 pid + 起始时间；pid 不存活或锁过期即视为陈旧锁。
// 3) 快照：diff 需要上一版结构，所以 `revision history/<doc>.edittrail/snapshot.json` 始终保存
//    最近一次落盘的快照；journal 只存 changes（体积可控）。
// 4) 不吞错：解析失败/不支持类型直接抛，调用方（CLI/watch）决定降级策略。

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, loadSnapshot, saveSnapshot, writeJsonAtomic } from './snapshot.mjs';
import { diffSnapshots, summarizeDiff } from './diff.mjs';
import {
  journalPath, lockPath, edittrailDir, newEdittrailDir, legacyEdittrailDir,
  legacyRecordsEdittrailDirs, isoLocal,
} from './paths.mjs';

export const CHANGE_LIMIT = 500;
export const LOCK_STALE_MS = 30_000;
export const LOCK_WAIT_MS = 5_000;

export class JournalLockError extends Error {
  constructor(file, holder) {
    super(`journal.lock 被占用：${lockPath(file)}（holder=${JSON.stringify(holder)}）`);
    this.name = 'JournalLockError';
    this.code = 'ELOCKED';
    this.holder = holder;
  }
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 读 journal：坏行跳过并计数，按 seq 排序（写入顺序即 seq 顺序）。 */
export function readJournal(file) {
  const jp = journalPath(file);
  const out = { path: jp, exists: false, records: [], badLines: 0 };
  let text;
  try {
    text = fs.readFileSync(jp, 'utf8');
  } catch {
    return out;
  }
  out.exists = true;
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

export function lastRecord(file) {
  const j = readJournal(file);
  return { journal: j, last: j.records.length ? j.records[j.records.length - 1] : null };
}

// ---------------------------------------------------------------- 锁

function readLock(file) {
  try {
    const raw = fs.readFileSync(lockPath(file), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') return obj;
    return { pid: Number(raw.trim()), startedAt: 0 };
  } catch {
    return null;
  }
}

/** 拿锁；返回释放函数。陈旧锁（pid 已死或超时）会被强拆。 */
export function acquireLock(file, opts = {}) {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const lp = lockPath(file);
  fs.mkdirSync(path.dirname(lp), { recursive: true });
  const startedAt = Date.now();
  const token = `${process.pid}:${startedAt}`;
  for (;;) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt, iso: isoLocal() }));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const cur = readLock(file);
        // 只释放自己持有的锁，避免误删别人刚抢到的锁
        if (!cur || cur.token === token || cur.pid === process.pid) {
          try { fs.unlinkSync(lp); } catch { /* 已被别人清理 */ }
        }
      };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const holder = readLock(file);
      const age = holder && holder.startedAt ? Date.now() - holder.startedAt : Infinity;
      const stale = !holder || !pidAlive(holder.pid) || age > staleMs;
      if (stale) {
        try { fs.unlinkSync(lp); } catch { /* 竞争失败下一轮再试 */ }
        continue;
      }
      if (Date.now() - startedAt >= waitMs) throw new JournalLockError(file, holder);
      sleepSync(50);
    }
  }
}

/** 在锁内执行 fn；异常时也保证释放。 */
export function withLock(file, fn, opts = {}) {
  const release = acquireLock(file, opts);
  try {
    return fn();
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- 写

/** 只追加一行；整个文件用 tmp+rename 原子替换，坏行原样保留。 */
export function appendLine(file, record) {
  const jp = journalPath(file);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(jp, 'utf8'); } catch { text = ''; }
  if (text && !text.endsWith('\n')) text += '\n';
  const line = JSON.stringify(record);
  const next = text + line + '\n';
  const tmp = path.join(path.dirname(jp), `.journal.jsonl.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, next, 'utf8');
  try {
    fs.renameSync(tmp, jp);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return { line, path: jp };
}

/** 去掉 changes 里的正文（`--no-content`）：保留 kind/anchor/长度/头尾上下文。 */
export function stripChangeContent(changes) {
  return changes.map((c) => {
    const { before, after, beforeFull, afterFull, ...rest } = c;
    return rest;
  });
}

/** 组装一条 journal 记录；changes 超限时截断并标记。 */
export function buildRecord(file, opts = {}) {
  const {
    seq, tsDate = new Date(), docType, size, sha256, prevSha256, seqInLineage,
    actor = 'unknown', actorConfidence, source = 'cli', summary = '', changes = [],
    totalChanges, counts = {}, extra = {},
  } = opts;
  const total = totalChanges ?? changes.length;
  const kept = changes.slice(0, CHANGE_LIMIT);
  const record = {
    seq,
    ts: isoLocal(tsDate),
    tsMs: (tsDate instanceof Date ? tsDate : new Date(tsDate)).getTime(),
    file: path.basename(file),
    docType,
    actor,
    actorConfidence: actorConfidence || (actor === 'unknown' ? 'low' : 'high'),
    source,
    size,
    sha256,
    prevSha256: prevSha256 ?? null,
    seqInLineage: seqInLineage ?? seq,
    changeCount: total,
    counts,
    summary,
  };
  if (opts.noContent) record.changes = stripChangeContent(kept);
  else record.changes = kept;
  if (total > kept.length) {
    record.truncated = true;
    record.totalChanges = total;
  }
  Object.assign(record, extra);
  return record;
}

// ---------------------------------------------------------------- 主干：记录一次版本

/**
 * 对文件做一次「落盘版本」记录。
 *
 * @param {string} file
 * @param {object} [opts]
 * @param {'wps-user'|'model'|'script'|'unknown'} [opts.actor='unknown']
 * @param {'watcher'|'addin'|'cli'|'manual'} [opts.source='cli']
 * @param {boolean} [opts.noContent] 不记录正文
 * @param {boolean} [opts.force] sha 相同也强制记一条
 * @param {object} [opts.logger] 可注入 logger（{info,warn,error}）
 * @returns {{action:'created'|'appended'|'unchanged', record:object|null, diff:object|null}}
 */
export function recordVersion(file, opts = {}) {
  const abs = path.resolve(file);
  const logger = opts.logger || null;
  ensureDocDir(abs); // 旧布局 <doc>.edittrail 会自动搬进 revision history/
  const built = buildSnapshot(abs, { verify: opts.verify, converter: opts.converter });
  const journal = readJournal(abs);
  const last = journal.records.length ? journal.records[journal.records.length - 1] : null;

  if (last && last.sha256 === built.sha256 && !opts.force) {
    return { action: 'unchanged', record: null, diff: null };
  }

  let diff = null;
  let prevSnap = null;
  let summary;
  let lineageFrom = null;
  // opts.base：本文件还没有 journal 时，用「同族前驱版本」的快照做基线，
  // 这样用户「另存为新版本文件」后，第一条记录就是跨版本 diff 而不是「建立基线 0 处改动」。
  const externalBase = !last && opts.base && opts.base.snapshot ? opts.base : null;
  if (!last && !externalBase) {
    summary = opts.summary || `建立基线：${built.docType}，${describeShape(built.snapshot)}`;
  } else {
    const saved = last ? loadSnapshot(abs) : null;
    // 只有快照确实对应上一版 sha 时才拿来 diff，否则会产出假差异
    if (externalBase) {
      prevSnap = externalBase.snapshot;
      lineageFrom = externalBase.lineageFrom || null;
    } else if (saved && saved.sha256 === last.sha256 && saved.docType === built.docType) {
      prevSnap = saved.snapshot;
    }
    if (prevSnap) {
      diff = diffSnapshots(prevSnap, built.snapshot, {
        noContent: !!opts.noContent,
        maxChanges: opts.maxChanges,
      });
      summary =
        typeof opts.summary === 'function'
          ? opts.summary(diff)
          : opts.summary || summarizeDiff(diff);
    } else {
      summary = opts.summary || '无法比对：缺少上一版快照（已记录本次版本）';
    }
  }

  const seq = (last ? Number(last.seq) || 0 : 0) + 1;
  const record = buildRecord(abs, {
    seq,
    tsDate: opts.now ? new Date(opts.now) : new Date(),
    docType: built.docType,
    size: built.size,
    sha256: built.sha256,
    prevSha256: last ? last.sha256 : externalBase ? externalBase.sha256 : null,
    seqInLineage: (last ? Number(last.seqInLineage) || seq - 1 : 0) + 1,
    actor: opts.actor || 'unknown',
    actorConfidence: opts.actorConfidence,
    source: opts.source || 'cli',
    summary,
    changes: diff ? diff.changes : [],
    totalChanges: diff ? diff.totalChanges : 0,
    counts: diff ? diff.counts : {},
    noContent: opts.noContent,
    extra: {
      ...(lineageFrom ? { lineageFrom } : {}),
      ...(built.sourceFormat
        ? { sourceFormat: built.sourceFormat, convertedBytes: built.convertedBytes }
        : {}),
      ...(opts.extra || {}),
    },
  });

  withLock(abs, () => {
    // 双重检查：等锁期间别人可能已经写过同一个 sha
    const again = readJournal(abs);
    const lastAgain = again.records.length ? again.records[again.records.length - 1] : null;
    if (lastAgain && lastAgain.sha256 === built.sha256 && !opts.force) return;
    if (lastAgain && Number(lastAgain.seq) >= record.seq && !opts.force) {
      record.seq = Number(lastAgain.seq) + 1;
    }
    appendLine(abs, record);
    saveSnapshot(built);
  });

  if (logger) logger.info?.(`journal seq=${record.seq} ${record.summary}`);
  return { action: last ? 'appended' : 'created', record, diff };
}

/** `edittrail init`：建立基线；已存在 journal 则只确保 snapshot 存在。 */
export function initBaseline(file, opts = {}) {
  const abs = path.resolve(file);
  const journal = readJournal(abs);
  const hasSnap = !!loadSnapshot(abs);
  if (journal.records.length && hasSnap && !opts.force) {
    return { action: 'exists', record: journal.records[journal.records.length - 1], diff: null };
  }
  return recordVersion(abs, { source: opts.source || 'cli', actor: opts.actor || 'unknown', force: opts.force, logger: opts.logger });
}

/** 给基线摘要用的一句话形态描述。 */
function describeShape(snapshot) {
  if (!snapshot) return '空快照';
  if (snapshot.docType === 'xlsx') {
    const cells = (snapshot.sheets || []).reduce((n, s) => n + Object.keys(s.cells || {}).length, 0);
    return `${snapshot.sheetCount} 个 sheet / ${cells} 个非空单元格 / ${snapshot.charts?.length || 0} 个图表`;
  }
  if (snapshot.docType === 'docx') {
    return `${snapshot.paragraphCount} 段 / ${snapshot.tables?.length || 0} 个表格`;
  }
  return `${snapshot.slideCount} 页幻灯片`;
}

/**
 * 把所有历史布局的 `<doc>.edittrail/` 搬进 `<dir>/revision history/<doc>.edittrail/`。
 * 兼容两类旧位置：文档旁边的 `<doc>.edittrail/`（v0.0.1 及更早），
 * 以及中间版本用过的 `revised record/`。
 * 返回 { moved, from, to }；无旧目录时返回 { moved:false }。
 * 只做同盘 rename；目标已存在时合并（不覆盖已有文件）。
 */
export function migrateDocDir(file) {
  const sources = [...legacyRecordsEdittrailDirs(file), legacyEdittrailDir(file)];
  const existing = sources.filter((dir) => fs.existsSync(dir));
  const next = newEdittrailDir(file);
  if (!existing.length) return { moved: false, from: sources[0], to: next };

  fs.mkdirSync(path.dirname(next), { recursive: true });
  if (existing.length === 1 && !fs.existsSync(next)) {
    fs.renameSync(existing[0], next);
    return { moved: true, from: existing[0], to: next };
  }
  // 目标已存在，或有多个来源：逐个合并，已存在的同名文件保留目标里的新版本
  for (const dir of existing) {
    for (const name of fs.readdirSync(dir)) {
      const src = path.join(dir, name);
      const dst = path.join(next, name);
      if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  return { moved: true, from: existing[0], to: next };
}

/** 确保 `<dir>/revision history/<doc>.edittrail/` 存在（watch/report 前调用）。 */
export function ensureDocDir(file) {
  migrateDocDir(file);
  const dir = newEdittrailDir(file);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export { writeJsonAtomic };
