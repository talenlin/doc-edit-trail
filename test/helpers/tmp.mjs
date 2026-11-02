// 测试用临时目录：每个用例独立目录，避免互相污染。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = [];

export function tmpDir(tag = 'et') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `edittrail-${tag}-`));
  roots.push(dir);
  return dir;
}

export function pathsOf(tag, fileName) {
  const dir = tmpDir(tag);
  return { dir, file: path.join(dir, fileName) };
}

process.on('exit', () => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ }
  }
});
