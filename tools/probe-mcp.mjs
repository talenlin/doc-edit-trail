// Probe the MCP server over stdio and print what a model would see.
// Usage: node tools/probe-mcp.mjs <file> [more files...]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'src', 'mcp', 'server.mjs');
const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node tools/probe-mcp.mjs <file> [...]');
  process.exit(2);
}

const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();

child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = waiters.get(msg.id);
    if (w) { waiters.delete(msg.id); w(msg); }
  }
});

let seq = 0;
const rpc = (method, params) => new Promise((resolve) => {
  const id = ++seq;
  waiters.set(id, resolve);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const init = await rpc('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0' },
});
console.log(`server: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

const list = await rpc('tools/list', {});
console.log('tools:', list.result.tools.map((t) => t.name).join(', '));

const reader = process.env.EDITTRAIL_SESSION_ID || 'probe:manual';
for (const f of files) {
  console.log(`\n===== ${path.basename(f)} =====`);
  const res = await rpc('tools/call', { name: 'doc_changes', arguments: { file: f, reader } });
  console.log(res.result?.content?.[0]?.text ?? JSON.stringify(res));
}

child.stdin.end();
