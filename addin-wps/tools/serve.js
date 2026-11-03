// EditTrail addin host: static server (per-host entry) + event sink
//
// WPS loads the addin from publish.xml. One package can serve all three WPS
// components; each host gets its own URL so the page knows which host it is:
//   http://127.0.0.1:39871/       -> et  (Spreadsheets)
//   http://127.0.0.1:39871/wps/   -> wps (Writer)
//   http://127.0.0.1:39871/wpp/   -> wpp (Presentation)
// /<host>/host.js is generated on the fly: `var EDIT_TRAIL_HOST = '<host>'`.
//
// Event channel: POST /log with a JSON body (or GET /log?l=<json>).
// Usage: node addin-wps/tools/serve.js [port]
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || '39871', 10);
const LOGDIR = path.join(ROOT, 'logs');
fs.mkdirSync(LOGDIR, { recursive: true });
const SRVLOG = path.join(LOGDIR, 'server.log');
const HTTPLOG = path.join(LOGDIR, 'http.log');
const EVENTS = path.join(LOGDIR, 'addin-events.jsonl');

const HOSTS = { et: 'et', wps: 'wps', wpp: 'wpp' };

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

// Split "/wps/js/trail.js" -> { host: 'wps', rel: '/js/trail.js' }.
// Bare "/" or "/manifest.xml" belongs to the default (et) entry.
function route(pathname) {
  const m = /^\/(et|wps|wpp)(\/.*)?$/i.exec(pathname);
  if (m) return { host: m[1].toLowerCase(), rel: m[2] || '/index.html' };
  return { host: 'et', rel: pathname };
}

function send(res, status, body, type, extra) {
  const headers = Object.assign({
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extra || {});
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const t = new Date().toISOString();
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); if (chunks.length > 4000) req.destroy(); });
  req.on('end', () => {
    const u = new URL(req.url, 'http://127.0.0.1:' + PORT);
    const p = u.pathname;
    const body = Buffer.concat(chunks).toString('utf8');

    // ---- event sink -------------------------------------------------------
    if (p === '/log' || p === '/log/') {
      let payload = u.searchParams.get('l') || body || '';
      let decoded = payload;
      try { decoded = decodeURIComponent(payload); } catch (e) {}
      log(SRVLOG, t + ' ' + decoded);
      log(EVENTS, decoded);
      log(HTTPLOG, t + ' ' + req.method + ' /log len=' + decoded.length);
      send(res, 200, 'ok');
      return;
    }
    if (p === '/health') {
      send(res, 200, JSON.stringify({ ok: true, hosts: Object.keys(HOSTS), root: ROOT }),
        'application/json; charset=utf-8');
      return;
    }

    const r = route(p);

    // Per-host marker page: lets every component share one package.
    if (r.rel === '/host.js') {
      const js = "var EDIT_TRAIL_HOST = '" + r.host + "';\n";
      log(HTTPLOG, t + ' GET /' + r.host + '/host.js -> 200');
      send(res, 200, js, MIME['.js']);
      return;
    }

    let rel = decodeURIComponent(r.rel);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(ROOT, path.normalize(rel).replace(/^([/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      log(SRVLOG, t + ' DENY ' + rel);
      send(res, 403, 'forbidden');
      return;
    }
    fs.readFile(full, (err, data) => {
      if (err) {
        log(HTTPLOG, t + ' ' + req.method + ' /' + r.host + rel + ' -> 404');
        send(res, 404, 'not found');
        return;
      }
      log(HTTPLOG, t + ' ' + req.method + ' /' + r.host + rel + ' -> 200 ' + data.length + 'B');
      send(res, 200, data, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream');
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const msg = '[serve] listening http://127.0.0.1:' + PORT + '/ (et|wps|wpp) root=' + ROOT;
  console.log(msg);
  log(SRVLOG, new Date().toISOString() + ' ' + msg);
});
