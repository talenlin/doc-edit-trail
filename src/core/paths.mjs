// src/core/paths.mjs
// 落盘位置约定（docs/CONTRACT.md 第 1 节）：
//   <dir>/revision history/<name>.xlsx.edittrail/journal.jsonl
// 同目录下所有文档的记录集中放在 `revision history/` 里，每个文档一个子目录；
// 子目录名带扩展名，避免和用户自己建的「同名文件夹」混淆。
//
// 兼容旧布局：
//   1) v0.0.1 及更早：`<name>.xlsx.edittrail/` 直接放在文档同目录；
//   2) 中间版本曾用过 `revised record/`。
// 读取时优先新位置、依次回退；写入一律用新位置，`edittrail migrate` 负责搬家。

import fs from 'node:fs';
import path from 'node:path';

/** 同目录下集中存放记录的文件夹名。 */
export const RECORDS_DIRNAME = 'revision history';

/** 历史上用过的同类目录名（读取时依次回退，写入/迁移时并入 RECORDS_DIRNAME）。 */
export const LEGACY_RECORDS_DIRNAMES = ['revised record'];

/** `<dir>/<name>.xlsx` → `<dir>/revision history` */
export function recordsDir(file) {
  return path.join(path.dirname(path.resolve(file)), RECORDS_DIRNAME);
}

/** 新布局：`<dir>/revision history/<name>.xlsx.edittrail` */
export function newEdittrailDir(file) {
  const abs = path.resolve(file);
  return path.join(path.dirname(abs), RECORDS_DIRNAME, path.basename(abs) + '.edittrail');
}

/** 中间布局：`<dir>/<legacyDirName>/<name>.xlsx.edittrail`（返回全部候选） */
export function legacyRecordsEdittrailDirs(file) {
  const abs = path.resolve(file);
  return LEGACY_RECORDS_DIRNAMES.map((name) =>
    path.join(path.dirname(abs), name, path.basename(abs) + '.edittrail'));
}

/** 最旧布局：`<dir>/<name>.xlsx.edittrail`（v0.0.1 及更早） */
export function legacyEdittrailDir(file) {
  const abs = path.resolve(file);
  return path.join(path.dirname(abs), path.basename(abs) + '.edittrail');
}

/**
 * 读路径：新位置存在就用新位置，否则依次回退中间布局、最旧布局；
 * 都没有时返回新位置（待创建）。
 */
export function edittrailDir(file) {
  const next = newEdittrailDir(file);
  if (fs.existsSync(next)) return next;
  for (const dir of legacyRecordsEdittrailDirs(file)) {
    if (fs.existsSync(dir)) return dir;
  }
  const legacy = legacyEdittrailDir(file);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}

export function journalPath(file) {
  return path.join(edittrailDir(file), 'journal.jsonl');
}

export function snapshotPath(file) {
  return path.join(edittrailDir(file), 'snapshot.json');
}

export function lineagePath(file) {
  return path.join(edittrailDir(file), 'lineage.json');
}

export function lockPath(file) {
  return path.join(edittrailDir(file), 'journal.lock');
}

/** 本地时区 ISO 字符串（契约里的 ts 是 `2026-10-30T18:05:22+08:00` 形态）。 */
export function isoLocal(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** 简报里用的本地时间 `2026/10/30 18:05`。 */
export function humanTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
