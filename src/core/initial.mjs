// src/core/initial.mjs
// 首条记录决策：用户习惯「另存为新版本文件」，所以一个文件第一次被引擎看见时，
// 真正的上一版往往不是「它自己上一次落盘」，而是同目录下同族的 v(N-1) 文件。
//
// 决策顺序：
//   1) 本文件已有 journal → 交给 recordVersion（幂等，sha 相同则 unchanged）；
//   2) 同族存在更早版本、且它有可用的 snapshot.json → 用它的快照做跨版本 diff，
//      第一条记录就带上 lineageFrom；
//   3) 同族存在更早版本但没有快照 → 记一条「前驱无快照」的基线说明（changeCount=0）；
//   4) 找不到前驱 → 普通「建立基线」。
//
// 这一层不读写 process.argv、不打印：CLI 与 watcher 都调用同一个函数。

import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, loadSnapshot, sha256File, isSupportedDoc, docTypeOf } from './snapshot.mjs';
import { readJournal, recordVersion, initBaseline } from './journal.mjs';
import { lineageKey, extractVersion, cmpVersion } from './lineage.mjs';
import { countKinds, classifyChange } from './diff.mjs';
import { humanTime } from './paths.mjs';

/**
 * 找同族前驱：版本号小于当前的最大者；版本号相同则取 mtime 更早者。
 * @param {string} file
 * @returns {{file:string, version:string|null, sha256:string, mtimeMs:number, snapshot:object|null}|null}
 */
export function findPredecessor(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const self = path.basename(abs);
  const key = lineageKey(abs);
  const selfVersion = extractVersion(self);
  let selfMtime = 0;
  try {
    selfMtime = fs.statSync(abs).mtimeMs;
  } catch {
    selfMtime = 0;
  }

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const candidates = [];
  for (const name of names) {
    if (name === self) continue;
    if (!isSupportedDoc(name)) continue;
    if (lineageKey(name) !== key) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const version = extractVersion(name);
    if (selfVersion && version) {
      if (cmpVersion(version, selfVersion) >= 0) continue; // 只往更早的版本找
    } else if (st.mtimeMs >= selfMtime) {
      continue; // 没有版本号时按 mtime
    }
    candidates.push({
      file: name,
      path: full,
      version,
      mtimeMs: st.mtimeMs,
      docType: docTypeOf(name),
    });
  }
  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.version && b.version) return cmpVersion(b.version, a.version); // 版本大的在前
    return b.mtimeMs - a.mtimeMs;
  });
  const picked = candidates[0];
  let payload = null;
  try {
    payload = loadSnapshot(picked.path);
  } catch {
    payload = null;
  }
  let sha256 = null;
  try {
    sha256 = payload?.sha256 || sha256File(picked.path);
  } catch {
    sha256 = null;
  }
  return {
    file: picked.file,
    version: picked.version,
    sha256,
    mtimeMs: picked.mtimeMs,
    snapshot: payload && payload.snapshot ? payload.snapshot : null,
    docType: picked.docType,
  };
}

function lineageSummary(fromVersion, toVersion, diff) {
  const label = `${fromVersion ? `v${fromVersion}` : '前驱'} → ${toVersion ? `v${toVersion}` : '当前版本'}`;
  if (!diff) return `${label}：前驱无快照，无法计算跨版本差异`;
  const counts = countKinds(diff.changes);
  const structure = diff.changes.filter((c) => classifyChange(c.kind) === 'structure').length;
  const text = diff.changes.filter((c) => classifyChange(c.kind) === 'text').length;
  const chart = diff.changes.filter((c) => classifyChange(c.kind) === 'chart').length;
  const style = counts['style.changed'] || 0;
  const parts = [];
  if (structure) parts.push(`结构 ${structure}`);
  if (text) parts.push(`文本 ${text}`);
  if (chart) parts.push(`图表 ${chart}`);
  if (style) parts.push(`样式 ${style}`);
  const other = diff.totalChanges - structure - text - chart - style;
  if (other > 0) parts.push(`其他 ${other}`);
  return `${label}：用户手改，${diff.totalChanges} 处（${parts.join(' / ') || '无实质改动'}）`;
}

/** 让 CLI/watch 复用的统一信息：前驱是谁、有没有快照。 */
export function describePredecessor(file) {
  const pred = findPredecessor(file);
  if (!pred) return null;
  return {
    file: pred.file,
    version: pred.version,
    sha256: pred.sha256,
    hasSnapshot: !!pred.snapshot,
    mtime: pred.mtimeMs ? humanTime(new Date(pred.mtimeMs)) : null,
  };
}

/**
 * 保证该文件有第一条记录（init / watch 首扫共用）。
 * @param {string} file
 * @param {{actor?:string, source?:string, noContent?:boolean, force?:boolean, now?:Date|number, logger?:object}} [opts]
 * @returns {{action:'created'|'appended'|'unchanged'|'baseline'|'exists', record:object|null, diff:object|null, predecessor:object|null}}
 */
export function ensureInitialRecord(file, opts = {}) {
  const abs = path.resolve(file);
  const journal = readJournal(abs);
  const last = journal.records.length ? journal.records[journal.records.length - 1] : null;

  // 已有记录：交给 recordVersion 处理（可能是新版本落盘，也可能 sha 未变）
  if (last) {
    const r = recordVersion(abs, {
      actor: opts.actor,
      source: opts.source || 'cli',
      noContent: opts.noContent,
      force: opts.force,
      now: opts.now,
      logger: opts.logger,
    });
    return { ...r, predecessor: null };
  }

  const selfVersion = extractVersion(path.basename(abs));
  const pred = findPredecessor(abs);
  if (!pred) {
    const r = initBaseline(abs, {
      actor: opts.actor || 'unknown',
      source: opts.source || 'cli',
      logger: opts.logger,
    });
    return { ...r, predecessor: null };
  }

  const fromVersion = pred.version;
  if (!pred.snapshot) {
    // 前驱存在但没建过快照：至少留下「为什么没有差异」的解释
    const built = buildSnapshot(abs);
    const r = recordVersion(abs, {
      actor: opts.actor,
      source: opts.source || 'cli',
      noContent: opts.noContent,
      now: opts.now,
      logger: opts.logger,
      summary: `${fromVersion ? `v${fromVersion}` : '前驱'} → ${selfVersion ? `v${selfVersion}` : '当前版本'}：前驱无快照，无法计算跨版本差异（已建立基线：${built.docType}）`,
    });
    return { ...r, predecessor: describePredecessor(abs) };
  }

  const r = recordVersion(abs, {
    actor: opts.actor,
    source: opts.source || 'cli',
    noContent: opts.noContent,
    now: opts.now,
    logger: opts.logger,
    base: {
      snapshot: pred.snapshot,
      sha256: pred.sha256,
      lineageFrom: {
        file: pred.file,
        version: pred.version,
        sha256: pred.sha256,
      },
    },
    summary: (diff) => lineageSummary(fromVersion, selfVersion, diff),
  });
  return { ...r, predecessor: describePredecessor(abs) };
}
