// EditTrail probe 静态服务器 + 事件接收器
// 用途: 托管加载项页面 (publish.xml 的 url 指向这里), 并把加载项发来的事件落盘
// 用法: node tools/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '39871', 10);
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const SRVLOG = path.join(LOGDIR, 'server.log');
const HTTPLOG = path.join(LOGDIR, 'http.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
};

function log(file, line) {
  try { fs.appendFileSync(file, line + '\n'); } catch (e) {}
}

const server = http.createServer((req, res) => {
  const t = new Date().toISOString();
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const p = u.pathname;

    // 事件通道: GET/POST /log?l=<json>
    if (p === '/log') {
      const raw = u.searchParams.get('l') || body || '';
      let decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch (e) {}
      log(SRVLOG, `${t} ${decoded}`);
      log(HTTPLOG, `${t} ${req.method} /log len=${decoded.length}`);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // 静态文件
    let rel = decodeURIComponent(p.split('?')[0]);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      log(SRVLOG, `${t} DENY ${rel}`);
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        log(HTTPLOG, `${t} ${req.method} ${rel} -> 404`);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      log(HTTPLOG, `${t} ${req.method} ${rel} -> 200 ${data.length}B`);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const msg = `[serve] listening http://127.0.0.1:${PORT}/ root=${ROOT}`;
  console.log(msg);
  log(SRVLOG, `${new Date().toISOString()} ${msg}`);
});
