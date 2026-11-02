// src/core/watch.mjs
// 落盘观察：目录/文件 → 稳定落盘 → journal 记录。
//
// WPS 保存不是「原地改字节」：它写临时文件再替换，且同一秒内可能连续落盘两次。
// 所以这里不用 fs.watch（Windows 上事件语义差异大），而是轮询 stat，并要求
// 「连续两次观察到同一个 (size, mtimeMs)」才认为落盘稳定，再读 sha 决定是否记录。

import fs from 'node:fs';
import path from 'node:path';
import { isSupportedDoc } from './snapshot.mjs';
import { recordVersion, readJournal } from './journal.mjs';
import { ensureInitialRecord } from './initial.mjs';

export const DEFAULT_INTERVAL_MS = 1500;

/** 是否是应当忽略的临时/锁文件（WPS/Office 的 ~$ 锁文件、我们的临时文件）。 */
export function isTransientName(name) {
  const base = path.basename(name);
  if (base.startsWith('~$') || base.startsWith('.')) return true;
  if (base.endsWith('.tmp') || base.includes('.tmp-')) return true;
  if (base.endsWith('.edittrail')) return true;
  return false;
}

/**
 * 目标（文件或目录）→ 候选文档列表。
 * 目录默认只扫一层（实测文档的版本文件常常堆在同一个目录下）。
 */
export function collectDocs(target, opts = {}) {
  const abs = path.resolve(target);
  const out = [];
  let st;
  try {
    st = fs.statSync(abs);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (isSupportedDoc(abs)) out.push({ file: abs, name: path.basename(abs), size: st.size, mtimeMs: st.mtimeMs });
    return out;
  }
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    return out;
  }
  for (const name of names) {
    if (isTransientName(name)) continue;
    if (!isSupportedDoc(name)) continue;
    const full = path.join(abs, name);
    let s;
    try { s = fs.statSync(full); } catch { continue; }
    if (!s.isFile()) continue;
    out.push({ file: full, name, size: s.size, mtimeMs: s.mtimeMs });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function stSig(entry) {
  return `${entry.size}:${Math.round(entry.mtimeMs)}`;
}

/**
 * 一轮扫描。返回本轮发生的动作，便于 CLI 打印与测试断言。
 *
 * @param {string} target 目录或文件
 * @param {object} [opts]
 * @param {Map<string,string>} [opts.state] 跨轮状态（file → 上一轮的稳定签名），watch 循环必须传
 * @param {'wps-user'|'model'|'script'|'unknown'} [opts.actor]
 * @param {boolean} [opts.baseline=true] 无 journal 的文件先建基线
 * @param {boolean} [opts.requireStable] 要求连续两轮签名一致才记录（watch 循环开启）
 * @param {object} [opts.logger]
 * @returns {{docs:number, baselined:Array, recorded:Array, pending:Array, unchanged:number, errors:Array}}
 */
export function watchOnce(target, opts = {}) {
  const state = opts.state instanceof Map ? opts.state : new Map();
  const actor = opts.actor || 'unknown';
  const logger = opts.logger || null;
  const result = { docs: 0, baselined: [], recorded: [], pending: [], unchanged: 0, errors: [] };

  for (const entry of collectDocs(target, opts)) {
    result.docs++;
    const sig = stSig(entry);
    const prevSig = state.get(entry.file);
    const journal = readJournal(entry.file);
    const last = journal.records.length ? journal.records[journal.records.length - 1] : null;

    if (!last) {
      if (opts.baseline === false) { result.unchanged++; continue; }
      try {
        // 首扫：若同族有更早版本且带快照，第一条记录就是跨版本 diff（见 initial.mjs）
        const r = ensureInitialRecord(entry.file, { actor, source: 'watcher', logger });
        state.set(entry.file, sig);
        result.baselined.push({
          file: entry.file,
          seq: r.record ? r.record.seq : null,
          changeCount: r.record ? r.record.changeCount : 0,
          summary: r.record ? r.record.summary : null,
          lineageFrom: r.record?.lineageFrom || null,
        });
      } catch (e) {
        result.errors.push({ file: entry.file, error: String(e && e.message || e) });
      }
      continue;
    }

    if (prevSig === sig) { result.unchanged++; continue; }

    // 需要「连续两轮同一签名」才认为落盘稳定：本轮先记下，下轮再定
    if (opts.requireStable) {
      if (opts.pendingState && opts.pendingState.get(entry.file) !== sig) {
        opts.pendingState.set(entry.file, sig);
        result.pending.push({ file: entry.file, sig });
        continue;
      }
    }

    try {
      const r = recordVersion(entry.file, { actor, source: 'watcher', logger });
      state.set(entry.file, sig);
      if (opts.pendingState) opts.pendingState.delete(entry.file);
      if (r.action === 'unchanged') result.unchanged++;
      else result.recorded.push({ file: entry.file, seq: r.record.seq, changeCount: r.record.changeCount, summary: r.record.summary });
    } catch (e) {
      result.errors.push({ file: entry.file, error: String(e && e.message || e) });
    }
  }
  return result;
}

/**
 * 轮询循环。返回 `{stop()}`；测试/CLI 都可控。
 *
 * @param {string} target
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=1500]
 * @param {Function} [opts.onTick] 每轮回调（结果对象）
 */
export function startWatch(target, opts = {}) {
  const intervalMs = Math.max(200, Number(opts.intervalMs) || DEFAULT_INTERVAL_MS);
  const state = new Map();
  const pendingState = new Map();
  let stopped = false;
  let timer = null;
  let running = false;

  const tick = () => {
    if (stopped || running) return;
    running = true;
    try {
      const res = watchOnce(target, {
        ...opts,
        state,
        pendingState,
        requireStable: true,
      });
      if (opts.onTick) opts.onTick(res);
    } catch (e) {
      if (opts.onError) opts.onError(e);
    } finally {
      running = false;
    }
  };

  // 首轮：先建基线（不等稳定窗口）
  tick();
  timer = setInterval(tick, intervalMs);
  // 默认让这个 interval 撑住事件循环 —— 否则 CLI `watch` 跑完第一轮就静默退出
  // （没有任何其它 handle 时，unref 过的 timer 不会阻止进程结束）。
  // 单元测试里需要进程能自行退出时传 { unrefTimer: true }。
  if (opts.unrefTimer === true && timer.unref) timer.unref();

  return {
    intervalMs,
    get stopped() { return stopped; },
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
