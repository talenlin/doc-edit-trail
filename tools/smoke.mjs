# Live smoke test: prove the watch loop records an xlsx edit end to end.
# It writes a small synthetic workbook into a watched directory, waits for the
# baseline record, rewrites the file with one row removed, waits for the next
# record, prints it, then cleans up (file + its .edittrail directory).
# Usage: node tools/smoke.mjs <watched-dir> [--keep]
import fs from 'node:fs';
import path from 'node:path';
import { readJournal } from '../src/core/journal.mjs';
import { makeXlsx } from '../test/helpers/fixtures.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dir = args.find((a) => !a.startsWith('--'));
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node tools/smoke.mjs <watched-dir> [--keep]');
  process.exit(2);
}

const V1 = {
  sheets: [
    {
      name: '总览',
      merges: ['A1:B1', 'A2:B2'],
      cells: { A1: { v: '冒烟测试' }, B1: { v: '合计' }, A2: { v: '将被删掉的一行' }, B2: { v: 1 } },
    },
    { name: '数据', cells: { A1: { v: 'x' } } },
  ],
};

const V2 = {
  sheets: [
    {
      name: '总览',
      merges: ['A1:B1'],
      cells: { A1: { v: '冒烟测试' }, B1: { v: '合计' } },
    },
    { name: '数据', cells: { A1: { v: 'x' } } },
  ],
};

const target = path.join(dir, `_trailtest_${process.pid}.xlsx`);
const journalDir = path.join(dir, 'revised record', `_trailtest_${process.pid}.xlsx.edittrail`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastRecord = () => {
  const j = readJournal(target);
  return j.records.length ? j.records[j.records.length - 1] : null;
};

console.log(`[smoke] dir=${dir}`);
console.log(`[smoke] write fixture -> ${path.basename(target)}`);
fs.writeFileSync(target, makeXlsx(V1));

let base = null;
for (let i = 0; i < 20; i++) {
  await sleep(800);
  base = lastRecord();
  if (base) break;
}
if (!base) {
  console.error('[smoke] FAIL: watcher did not baseline the new file within 16s');
  process.exit(1);
}
console.log(`[smoke] baseline: seq ${base.seq} changeCount=${base.changeCount} ${base.summary}`);

await sleep(2500); // let the watcher settle on the first write
fs.writeFileSync(target, makeXlsx(V2));
console.log('[smoke] rewrote file with one row + one merge removed');

let rec = null;
for (let i = 0; i < 25; i++) {
  await sleep(800);
  const last = lastRecord();
  if (last && last.seq > base.seq) {
    rec = last;
    break;
  }
}
if (!rec) {
  console.error('[smoke] FAIL: no new journal record within 20s after the edit');
  process.exit(1);
}

console.log(`[smoke] OK: seq ${rec.seq} changeCount=${rec.changeCount} actor=${rec.actor}`);
console.log(`[smoke] summary: ${rec.summary}`);
for (const c of (rec.changes || []).slice(0, 5)) {
  console.log(`  - ${c.kind} ${c.anchor || c.cell || ''} ${c.before ?? ''} -> ${c.after ?? ''}`);
}

if (!keep) {
  fs.rmSync(target, { force: true });
  fs.rmSync(journalDir, { recursive: true, force: true });
  console.log('[smoke] cleaned up');
} else {
  console.log(`[smoke] kept ${target}`);
}
