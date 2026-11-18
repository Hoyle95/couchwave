// ---------- The server's log file ----------
const fs = require('fs');
const path = require('path');
const { DATA } = require('./common');

const LOGFILE = path.join(DATA, 'server.log');
const LOG_MAX = 5 * 1024 * 1024, LOG_KEEP = 2 * 1024 * 1024;
let logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
const stamp = () => new Date().toLocaleString('en-GB', { hour12: false }).replace(',', '');
function logOut(text) {
  text = String(text).replace(/\r/g, '');
  const lines = text.split('\n').filter(l => l.trim()).map(l => `${stamp()}  ${l}\n`).join('');
  if (!lines) return;
  logStream.write(lines);
  if (process.stdout.isTTY) process.stdout.write(lines);
}
console.log = (...a) => logOut(a.join(' '));
console.error = (...a) => logOut(a.join(' '));

function trimLog() {
  try {
    if (!fs.existsSync(LOGFILE)) return;
    const size = fs.statSync(LOGFILE).size;
    if (size <= LOG_MAX) return;
    const buf = Buffer.alloc(LOG_KEEP), fd = fs.openSync(LOGFILE, 'r');
    fs.readSync(fd, buf, 0, LOG_KEEP, size - LOG_KEEP);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const old = logStream, held = [];
    logStream = { write: l => held.push(l) };
    old.end(() => {
      try { fs.writeFileSync(LOGFILE, `---- ${stamp()}: older lines trimmed, keeping the newest ----\n` + text.slice(text.indexOf('\n') + 1)); } catch {}
      logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
      for (const l of held) logStream.write(l);
    });
  } catch (err) { logOut('log trim failed: ' + err.message); }
}
trimLog();
setInterval(trimLog, 60 * 60 * 1000);

// ---------- Crashes and stopping ----------
process.on('uncaughtException', err => {
  try { fs.appendFileSync(LOGFILE, `${stamp()}  CRASH ${err.stack || err}\n`); } catch {}
  process.exit(1);
});
const fatal = msg => { const l = `${stamp()}  ${msg}\n`; try { fs.appendFileSync(LOGFILE, l); } catch {} process.stderr.write(l); process.exit(1); };

Object.assign(exports, { logOut, fatal });
