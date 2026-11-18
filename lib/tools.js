// ---------- Running yt-dlp, ffmpeg and ffprobe ----------
const path = require('path');
const { spawn } = require('child_process');
const { FAKE_TOOLS, secs } = require('./common');
const { logOut } = require('./log');

const TOOL_LIMIT = secs(60 * (Number(process.env.COUCHWAVE_TOOL_MINUTES) || 30));
function run(name, args, limit, what = name) {
  const p = FAKE_TOOLS ? spawn(process.execPath, [path.join(FAKE_TOOLS, name + '.js'), ...args]) : spawn(name, args);
  if (limit) {
    const timer = setTimeout(() => { p.timedOut = true; logOut(`${what} was still going after ${Math.round(limit / secs(60))} minutes: stopped`); killTree(p); }, limit);
    p.on('close', () => clearTimeout(timer));
    p.on('error', () => clearTimeout(timer));
  }
  return p;
}
function killTree(proc) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on('error', () => proc.kill());
  else proc.kill();
}

Object.assign(exports, { TOOL_LIMIT, run, killTree });
