#!/usr/bin/env node
// edit-trail · MCP server 自检（不需要 WPS、不需要引擎，用合成 journal 验证协议与渲染）
// 用法: node src/mcp/selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildZip } from '../core/zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'server.mjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edittrail-mcp-'));
const dir = path.join(tmp, 'out');
fs.mkdirSync(dir, { recursive: true });
const xlsx = path.join(dir, '示例报告_v2.4.xlsx');
fs.writeFileSync(xlsx, 'not-a-real-xlsx'); // MCP 侧不解析文件内容，只看 journal

// docx 原生修订 fixture：一个带 w:ins 的段落（用于 doc_revisions 工具）
const docx = path.join(dir, '示例报告_v2.3.docx');
const DOCX_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
fs.writeFileSync(docx, buildZip([{
  name: 'word/document.xml',
  data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:document ${DOCX_NS}><w:body><w:p w14:paraId="2D375F6B">` +
    '<w:ins w:id="1" w:author="张三" w:date="2026-01-14T14:12:00Z">' +
    '<w:r><w:t>新增的一句话</w:t></w:r></w:ins></w:p></w:body></w:document>',
}]));

const et = path.join(dir, 'revised record', '示例报告_v2.4.xlsx.edittrail');
fs.mkdirSync(et, { recursive: true });
const recs = [
  {
    seq: 1, ts: '2026-01-14T09:00:00+08:00', tsMs: Date.parse('2026-01-14T09:00:00+08:00'),
    file: '示例报告_v2.4.xlsx', docType: 'xlsx', actor: 'model', actorConfidence: 'high',
    source: 'cli', size: 12345, sha256: 'aaaa1111', prevSha256: null, version: '2.4',
    changeCount: 3, counts: { 'cell.changed': 2, 'sheet.added': 1 },
    summary: '模型生成 v2.4：新增「明细表」sheet',
    changes: [
      { kind: 'sheet.added', anchor: '明细表', before: null, after: '明细表', styleChanged: false, charDelta: 0, firstDiffAt: 0 },
      { kind: 'cell.changed', anchor: '总览!B3', sheet: '总览', cell: 'B3', before: '草稿', after: '定稿', styleChanged: false, charDelta: 0, firstDiffAt: 0 },
      { kind: 'cell.changed', anchor: '总览!B9', sheet: '总览', cell: 'B9', before: '5 项', after: '6 项', styleChanged: false, charDelta: 0, firstDiffAt: 0 },
    ],
  },
  {
    seq: 2, ts: '2026-01-14T10:24:22+08:00', tsMs: Date.parse('2026-01-14T10:24:22+08:00'),
    file: '示例报告_v2.4.xlsx', docType: 'xlsx', actor: 'wps-user', actorConfidence: 'high',
    source: 'watcher', size: 12678, sha256: 'bbbb2222', prevSha256: 'aaaa1111', version: '2.4',
    changeCount: 2, counts: { 'cell.changed': 2 },
    summary: '用户手改 2 处：明细表计数调整，措辞微调',
    changes: [
      { kind: 'cell.changed', anchor: '明细表!C7', sheet: '明细表', cell: 'C7', before: '12 项', after: '10 项', styleChanged: false, charDelta: -1, firstDiffAt: 0 },
      { kind: 'cell.changed', anchor: '总览!B12', sheet: '总览', cell: 'B12', before: '初稿表述', after: '终稿表述', styleChanged: false, charDelta: 0, firstDiffAt: 4 },
    ],
  },
];
fs.writeFileSync(path.join(et, 'journal.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');

const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
let outbuf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  outbuf += d.toString('utf8');
  let i;
  while ((i = outbuf.indexOf('\n')) >= 0) {
    const line = outbuf.slice(0, i).trim();
    outbuf = outbuf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { console.error('非 JSON 输出:', line); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
let stderr = '';
child.stderr.on('data', d => (stderr += d.toString()));

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 8000);
  });
}

function text(resp) {
  return resp?.result?.content?.[0]?.text || '';
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' :: ' + String(detail || '').slice(0, 400)}`);
}

try {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest' } });
  check('initialize 返回 serverInfo', init.result?.serverInfo?.name === 'edit-trail', JSON.stringify(init.result));

  const tl = await rpc('tools/list', {});
  const names = (tl.result?.tools || []).map(t => t.name);
  check('tools/list 含 5 个工具', ['doc_changes', 'doc_trail', 'doc_versions', 'doc_scan', 'doc_revisions'].every(n => names.includes(n)), names.join(','));

  // 第一次读：无游标 → 全部
  const c1 = await rpc('tools/call', { name: 'doc_changes', arguments: { file: xlsx, reader: 'selftest' } });
  const t1 = text(c1);
  check('首次读取包含两版内容', t1.includes('v2.4') && t1.includes('明细表!C7'), t1);
  check('简报标注 actor', t1.includes('用户手改（WPS）'), t1);
  check('简报含 before→after', t1.includes('12 项') && t1.includes('10 项'), t1);
  check('structuredContent 有 records', (c1.result?.structuredContent?.records || []).length === 2, JSON.stringify(c1.result?.structuredContent));

  // 第二次读：游标已推进 → 应为 0 次落盘
  const c2 = await rpc('tools/call', { name: 'doc_changes', arguments: { file: xlsx, reader: 'selftest' } });
  const t2 = text(c2);
  check('二次读取显示无新改动', t2.includes('没有新的落盘改动'), t2);

  // since 显式指定
  const c3 = await rpc('tools/call', { name: 'doc_changes', arguments: { file: xlsx, reader: 'other', since: 'aaaa1111' } });
  const t3 = text(c3);
  check('since=sha 只返回后一版', t3.includes('明细表!C7') && !t3.includes('总览!B3'), t3);

  const trail = await rpc('tools/call', { name: 'doc_trail', arguments: { file: xlsx } });
  const tt = text(trail);
  check('doc_trail 列两行含时间与 actor', tt.includes('2026-01-14 09:00') && tt.includes('2026-01-14 10:24') && tt.includes('用户手改（WPS）'), tt);

  const vers = await rpc('tools/call', { name: 'doc_versions', arguments: { file: xlsx } });
  check('doc_versions 识别文档族与版本号', text(vers).includes('v2.4'), text(vers));

  // 未追踪文件 → 借用同族
  const other = path.join(dir, '示例报告_v2.5.xlsx');
  fs.writeFileSync(other, 'x');
  const c4 = await rpc('tools/call', { name: 'doc_changes', arguments: { file: other, reader: 'selftest2' } });
  check('未追踪文件提示借用同族最新版', text(c4).includes('尚未被追踪'), text(c4));

  const bad = await rpc('tools/call', { name: 'nope', arguments: {} });
  check('未知工具返回 error', bad.error?.code === -32602, JSON.stringify(bad));

  // docx 原生修订：谁改的（author/date/paraId），走 MCP 工具
  const rev = await rpc('tools/call', { name: 'doc_revisions', arguments: { file: docx } });
  const rt = text(rev);
  check('doc_revisions 读出作者与锚点', rt.includes('张三') && rt.includes('para:2D375F6B'), rt);
  check('doc_revisions structuredContent 计数正确', rev.result?.structuredContent?.count === 1, JSON.stringify(rev.result?.structuredContent));
  const revXlsx = await rpc('tools/call', { name: 'doc_revisions', arguments: { file: xlsx } });
  check('非 docx 时 doc_revisions 明确拒绝', /只有 \.docx/.test(text(revXlsx)), text(revXlsx));

  // 只有基线、没有变更记录 → 必须给出"可能还没和上一版对照"的解释，而不是"0 处改动"
  const base = path.join(dir, '示例报告_v3.0.xlsx');
  fs.writeFileSync(base, 'x');
  const bet = path.join(dir, 'revised record', '示例报告_v3.0.xlsx.edittrail');
  fs.mkdirSync(bet, { recursive: true });
  const brec = {
    seq: 1, ts: '2026-01-15T15:49:14+08:00', tsMs: Date.parse('2026-01-15T15:49:14+08:00'),
    file: '示例报告_v3.0.xlsx', docType: 'xlsx', actor: 'wps-user', actorConfidence: 'high',
    source: 'watcher', size: 12345, sha256: 'cccc3333', prevSha256: null, seqInLineage: 1,
    changeCount: 0, counts: {}, summary: '建立基线：xlsx，2 个 sheet / 120 个非空单元格', changes: [],
  };
  fs.writeFileSync(path.join(bet, 'journal.jsonl'), JSON.stringify(brec) + '\n');
  const c5 = await rpc('tools/call', { name: 'doc_changes', arguments: { file: base, reader: 'baseline-test' } });
  const t5 = text(c5);
  check('基线态给出对照缺失提示', t5.includes('已有基线') || t5.includes('建立基线'), t5);
  check('基线态列出同族版本', t5.includes('同族版本'), t5);
} catch (e) {
  check('无异常', false, e && e.stack || e);
} finally {
  child.kill();
  const failed = results.filter(r => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过${stderr ? `\nserver stderr: ${stderr.split('\n').slice(0, 3).join(' | ')}` : ''}`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(failed.length ? 1 : 0);
}
