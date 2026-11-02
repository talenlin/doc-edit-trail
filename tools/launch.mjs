// Detached launcher: starts the add-in server + one watcher per directory and exits.
// Children are spawned with detached:true + unref() so they survive the parent
// (a plain `Start-Process` child dies when its console closes on Windows).
// Usage: node tools/launch.mjs [--port 39871] [--actor wps-user] [--no-addin] [--dry]
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const logDir = path.join(root, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const pidFile = path.join(logDir, 'service-pids.json');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const port = Number(flag('port', '39871'));
const actor = flag('actor', 'wps-user');
const noAddin = argv.includes('--no-addin');
const dry = argv.includes('--dry');

// 1) stop a previous run (own pid file only — never touch other node processes)
if (fs.existsSync(pidFile)) {
  try {
    const old = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    for (const e of old.entries || []) {
      try { process.kill(e.pid); } catch { /* already gone */ }
    }
  } catch { /* corrupt pid file */ }
}

// 1b) free our own port if a stale serve.js still holds it (never touch other apps)
function freeOwnPort(p) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    const line = out.split(/\r?\n/).find((l) => new RegExp(`[:.]${p}\\s+\\S+\\s+LISTENING`, 'i').test(l));
    if (!line) return null;
    const owner = Number(line.trim().split(/\s+/).pop());
    if (!owner) return null;
    let cmd = '';
    try {
      cmd = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${owner}").CommandLine`], { encoding: 'utf8', windowsHide: true }).trim();
    } catch { return null; }
    if (!/serve\.js/i.test(cmd)) {
      console.log(`[warn] port ${p} is held by an unrelated process (pid ${owner}); add-in server not restarted`);
      return null;
    }
    try { process.kill(owner); } catch { /* ignore */ }
    console.log(`[ok] freed port ${p} from stale serve.js (pid ${owner})`);
    return owner;
  } catch {
    return null;
  }
}

// 2) directories to watch
let dirs = argv.filter((a) => !a.startsWith('--') && a !== String(port) && a !== actor && fs.existsSync(a) && fs.statSync(a).isDirectory());
if (dirs.length === 0) {
  const cfg = path.join(here, 'watch-dirs.txt');
  dirs = fs.existsSync(cfg)
    ? fs.readFileSync(cfg, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
    : [];
}

function launch(role, cmd, args, logName, argLabel) {
  const out = fs.openSync(path.join(logDir, logName), 'a');
  const child = spawn(cmd, args, {
    cwd: root,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.closeSync(out);
  return { role, pid: child.pid, arg: argLabel ?? args.slice(-1)[0] };
}

const entries = [];
if (dry) {
  console.log('[dry] dirs=', dirs);
  if (!noAddin) console.log('[dry] would start serve on', port);
} else {
  if (!noAddin) {
    freeOwnPort(port);
    entries.push(launch('serve', process.execPath, [path.join(root, 'addin-wps', 'tools', 'serve.js'), String(port)], 'serve.log'));
  }
  for (const d of dirs) {
    const slug = path.basename(d).replace(/[^A-Za-z0-9]+/g, '_') || 'dir';
    entries.push(launch('watch', process.execPath, [path.join(root, 'src', 'cli', 'edittrail.mjs'), 'watch', d, '--actor', actor], `watch-${slug}.log`, d));
  }
  fs.writeFileSync(pidFile, JSON.stringify({ startedAt: new Date().toISOString(), actor, port, entries }, null, 2));
  for (const e of entries) console.log(`[ok] ${e.role} pid=${e.pid} ${e.arg}`);
  console.log(`[ok] pid file ${pidFile}`);
}
