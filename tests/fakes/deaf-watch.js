// ---------- Stand-in for node --watch that misses the first change to server.js, as Windows sometimes does when busy ----------
const fs = require('fs');
const { spawn } = require('child_process');

let child, seen = 0, last = fs.statSync('server.js').mtimeMs;
const start = () => {
  child = spawn(process.execPath, ['server.js'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, WATCH_REPORT_DEPENDENCIES: '1' } });
  child.on('message', () => {});
};
start();
setInterval(() => {
  let now;
  try { now = fs.statSync('server.js').mtimeMs; } catch { return; }
  if (now === last) return;
  last = now;
  if (++seen === 1) return;
  child.once('exit', start);
  child.kill();
}, 100);
process.on('SIGTERM', () => { child.kill(); process.exit(0); });
