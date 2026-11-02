// 一键 demo：生成两个合成版本 → snapshot → 跨版本 diff → journal → 简报。
// 不依赖任何外部素材，跑完把示例产物写到 examples/。
// 用法: node demo.mjs [输出目录]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeXlsx } from './test/helpers/fixtures.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'src', 'cli', 'edittrail.mjs');
const OUT = path.resolve(process.argv[2] || path.join(HERE, 'examples'));

const V1 = {
  sheets: [
    {
      name: '总览',
      dims: 'A1:F12',
      merges: ['A1:B1', 'A2:B2', 'A3:B3', 'A4:B4'],
      cells: {
        A1: { v: '示例报告 总览', s: 1 },
        B1: { v: '合计' },
        A2: { v: '条目清单（按类别）' },
        B2: { v: 12 },
        C2: { v: '项' },
        A3: { v: '类别甲' },
        B3: { v: 5 },
        A4: { v: '类别乙' },
        B4: { v: 4 },
      },
    },
    { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
  ],
};

const V2 = {
  sheets: [
    {
      name: '总览',
      dims: 'A1:F12',
      merges: ['A1:B1'],
      cells: {
        A1: { v: '示例报告 总览', s: 1 },
        B1: { v: '合计' },
      },
    },
    { name: '数据', cells: { A1: { v: 'x' }, B1: { v: 1 } } },
  ],
};

function run(args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: HERE });
  if (res.status !== 0) {
    console.error(`[demo] 失败: edittrail ${args.join(' ')}\n${res.stdout}\n${res.stderr}`);
    process.exit(res.status || 1);
  }
  return res.stdout;
}

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) {
  if (f === '.gitkeep') continue;
  fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
}

const a = path.join(OUT, '示例报告_v1.0.xlsx');
const b = path.join(OUT, '示例报告_v2.0.xlsx');
fs.writeFileSync(a, makeXlsx(V1));
fs.writeFileSync(b, makeXlsx(V2));
console.log(`[demo] 生成: ${path.relative(HERE, a)} / ${path.relative(HERE, b)}`);

const diffMd = path.join(OUT, 'sample-diff.md');
const out = run(['diff', a, b, '--md', diffMd]);
console.log(out.trim().split('\n').slice(0, 3).join('\n'));

run(['init', a, '--actor', 'wps-user']);
const initOut = run(['init', b, '--actor', 'wps-user']);
console.log(initOut.trim());

const report = run(['report', b, '--md']);
fs.writeFileSync(path.join(OUT, 'sample-report.md'), report, 'utf8');

// 清理 journal 目录与二进制样本（示例产物只留 markdown，保持仓库干净）
fs.rmSync(`${a}.edittrail`, { recursive: true, force: true });
fs.rmSync(`${b}.edittrail`, { recursive: true, force: true });
fs.rmSync(a, { force: true });
fs.rmSync(b, { force: true });

console.log(`[demo] 产物: ${path.join(path.relative(HERE, OUT), 'sample-diff.md')} / sample-report.md`);
