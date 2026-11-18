// ---------- Checking the tools ----------
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const common = require('./common');
const { DATA, CONFIG, RELEASES, newer, newestOf, secs } = common;
const { logOut } = require('./log');
const { config } = require('./settings');
const { run } = require('./tools');
const room = require('./room');
const downloads = require('./downloads');

const TOOLS = [
  ['yt-dlp', '--version', "songs can't be found or downloaded"],
  ['ffmpeg', '-version', "songs won't download properly"],
  ['ffprobe', '-version', "some songs' lengths can't be read"],
];
for (const [tool, flag, effect] of process.env.COUCHWAVE_CHECK_TOOLS === 'no' ? [] : TOOLS) {
  const p = run(tool, [flag], secs(60));
  let out = '', fin = false;
  p.stdout.on('data', d => (out += d));
  const end = code => {
    if (fin) return;
    fin = true;
    const version = String(out).trim().split(/\r?\n/)[0];
    if (code === 0 && version) return logOut(`found ${tool}: ${version}`);
    const text = `can't find ${tool}, so ${effect}. Install it (see docs/INSTALL.md) and restart Couchwave`;
    logOut(text);
    room.addLog('server', text);
    room.dirty = true;
  };
  p.on('error', () => end(-1));
  p.on('close', end);
}
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 11)) {
    const text = `Couchwave needs Node.js 18.11 or newer, and this is ${process.versions.node}: some things won't work. Install a newer Node.js (see docs/INSTALL.md)`;
    logOut(text);
    room.addLog('server', text);
  }
}

// ---------- Keeping yt-dlp up to date ----------
let toldCantUpdate = false;
function updateYtdlp() {
  if (downloads.running.size) return setTimeout(updateYtdlp, secs(300));
  const p = run('yt-dlp', ['-U'], secs(300));
  let out = '', fin = false;
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const end = () => {
    if (fin) return;
    fin = true;
    const updated = /Updated yt-dlp to:?\s*(?:\S*@)?([\d.]+)/i.exec(out);
    if (updated) { room.addLog('server', `updated yt-dlp to ${updated[1]}`); room.dirty = true; }
    logOut('yt-dlp update check: ' + (out.trim().split('\n').pop() || 'no output'));
    if (!updated && !toldCantUpdate && /installed yt-dlp .*use that to update/i.test(out)) {
      toldCantUpdate = true;
      const how = /pip|pypi/i.test(out) ? 'with pip' : 'with a package manager';
      const text = `yt-dlp can't update itself here (it was installed ${how}), so it will go out of date and YouTube downloads will start failing. Update it the same way it was installed, or install it as in docs/INSTALL.md`;
      logOut(text);
      room.addLog('server', text);
      room.dirty = true;
    }
  };
  p.on('error', end);
  p.on('close', end);
}
setTimeout(updateYtdlp, secs(60));
setInterval(updateYtdlp, secs(24 * 3600));

// ---------- New versions of Couchwave ----------
function checkForUpdate() {
  if (config.updateCheck === false) return;
  const req = (RELEASES.startsWith('https:') ? https : http).get(RELEASES, { headers: { 'User-Agent': 'Couchwave', Accept: 'application/vnd.github+json' }, timeout: 15000 }, res => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', d => { body += d; if (body.length > 2e6) req.destroy(); });
    res.on('end', () => {
      let list;
      try { list = JSON.parse(body); } catch { return; }
      const newest = newestOf(list);
      if (!newest || !newer(newest.tag_name, common.VERSION) || room.newestTold === newest.tag_name) return;
      room.newestTold = newest.tag_name;
      room.dirty = true;
      const text = `a newer Couchwave is out: ${newest.tag_name.slice(0, 40)} (this is v${common.VERSION}). Whoever runs it can update: see docs/INSTALL.md#updating`;
      logOut(text);
      room.addLog('server', text);
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', () => {});
}
setTimeout(checkForUpdate, secs(120));
setInterval(checkForUpdate, secs(24 * 3600));

// ---------- Daily backups ----------
const BACKUPS = path.join(DATA, 'backups'), BACKUP_DAYS = 7;
const BACKED_UP = ['accounts.json', 'state.json', 'logins.json', 'login-key', 'dj.json'];
function backUp() {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  try {
    const dir = path.join(BACKUPS, day);
    if (!fs.existsSync(dir)) {
      room.save();
      const making = `${dir}.making`;
      fs.rmSync(making, { recursive: true, force: true });
      fs.mkdirSync(making, { recursive: true });
      for (const f of BACKED_UP) { try { fs.copyFileSync(path.join(DATA, f), path.join(making, f)); } catch {} }
      try { fs.copyFileSync(CONFIG, path.join(making, 'config.json')); } catch {}
      fs.renameSync(making, dir);
    }
    const days = fs.readdirSync(BACKUPS).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
    for (const old of days.slice(0, -BACKUP_DAYS)) fs.rmSync(path.join(BACKUPS, old), { recursive: true, force: true });
  } catch (err) { console.error('backing up failed:', err.message); }
}
setTimeout(backUp, secs(30));
setInterval(backUp, secs(3600));
