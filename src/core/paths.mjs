// src/core/paths.mjs
// 落盘位置约定（docs/CONTRACT.md 第 1 节）：
//   <dir>/<name>.xlsx.edittrail/journal.jsonl
// 目录名必须带扩展名，避免和用户自己建的「同名文件夹」混淆。

import path from 'node:path';

/** `<dir>/<name>.xlsx` → `<dir>/<name>.xlsx.edittrail` */
export function edittrailDir(file) {
  const abs = path.resolve(file);
  return path.join(path.dirname(abs), path.basename(abs) + '.edittrail');
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

/** 本地时区 ISO 字符串（契约里的 ts 是 `2026-01-14T10:24:22+08:00` 形态）。 */
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

/** 简报里用的本地时间 `2026/01/14 10:24`。 */
export function humanTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
