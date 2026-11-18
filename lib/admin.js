// ---------- Requests from the server commands ----------
const fs = require('fs');
const path = require('path');
const common = require('./common');
const { DATA, REQUESTS, writeAtomic, fmt, CLEARABLE, clearedText } = common;
const { logOut } = require('./log');
const { PORT } = require('./settings');
const { killTree } = require('./tools');
const room = require('./room');
const downloads = require('./downloads');
const songs = require('./songs');
const playback = require('./playback');
const presence = require('./presence');

function handleRequests() {
  let files;
  try { files = fs.readdirSync(REQUESTS); } catch { return; }
  for (const f of files) {
    const file = path.join(REQUESTS, f);
    if (f.endsWith('.reply')) { try { if (Date.now() - fs.statSync(file).mtimeMs > 60000) fs.rmSync(file, { force: true }); } catch {} continue; }
    if (!f.endsWith('.json')) continue;
    let request;
    try { request = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    fs.rmSync(file, { force: true });
    const reply = request.stop ? stopRequest() : request.status ? statusRequest() : request.restart ? restartRequest()
      : Array.isArray(request.clear) ? clearRequest(request.clear) : removeRequest(request.removeSong);
    try { writeAtomic(file.replace(/\.json$/, '.reply'), JSON.stringify(reply)); } catch {}
  }
}

function removeRequest(id) {
  const song = room.queue.find(q => q.id === id);
  if (!song) return { ok: false, text: "That song isn't in the queue any more (it may have just started playing). Nothing was changed." };
  songs.removeFromQueue(song, 'server', `removed "${song.title}" (whoever runs Couchwave did)`);
  return { ok: true, text: `Done: removed "${song.title}" from the queue.` };
}

function clearRequest(asked) {
  const what = Object.keys(CLEARABLE).filter(w => asked.includes(w));
  if (!what.length) return { ok: false, text: 'Nothing to clear. Nothing was changed.' };
  if (what.includes('history')) { room.history = []; room.historyRev++; }
  if (what.includes('chat')) { room.chat = []; room.chatRev++; }
  if (what.includes('activity')) { room.log = []; room.logRev++; }
  room.addLog('server', `cleared ${clearedText(what)} (whoever runs Couchwave did)`);
  room.dirty = true;
  return { ok: true, text: `Done: cleared ${clearedText(what)}.` };
}

// ---------- Stopping ----------
const STOP_FILE = path.join(DATA, 'stop');
try { fs.rmSync(STOP_FILE, { force: true }); } catch {}
function startedBySystemd() {
  if (process.env.COUCHWAVE_FAKE_SYSTEMD) return true;
  try { return fs.readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim() === 'systemd'; } catch { return false; }
}
function stopRequest() {
  if (startedBySystemd()) {
    return { ok: false, text: 'Couchwave runs as a systemd service here, which would start it again straight away. Stop it with: sudo systemctl stop couchwave' };
  }
  setTimeout(() => {
    room.save();
    try { fs.writeFileSync(STOP_FILE, 'stopped by node server.js --stop\n'); } catch {}
    for (const p of downloads.running.values()) killTree(p);
    logOut('stopped by node server.js --stop');
    if (process.env.WATCH_REPORT_DEPENDENCIES) { try { process.kill(process.ppid); } catch {} }
    setTimeout(() => process.exit(0), 200);
  }, 200);
  return { ok: true, text: 'Done: Couchwave has stopped, and everything is saved. To start it again: start.cmd (or Start-ScheduledTask Couchwave) on Windows, or node server.js.' };
}

// ---------- Restarting after an update ----------
const runBy = () => (process.env.WATCH_REPORT_DEPENDENCIES ? 'watch' : startedBySystemd() ? 'systemd' : 'none');
function restartRequest() {
  if (!startedBySystemd()) return { ok: false, text: 'Only Couchwave run as a systemd service restarts this way.' };
  setTimeout(() => {
    room.save();
    for (const p of downloads.running.values()) killTree(p);
    logOut('restarting, to finish updating');
    setTimeout(() => process.exit(75), 200);
  }, 200);
  return { ok: true, text: 'Restarting.' };
}

// ---------- Status ----------
function statusRequest() {
  const { queue, current } = room;
  const users = presence.online().sort((a, b) => a.localeCompare(b)), counts = {};
  for (const q of queue) counts[q.status] = (counts[q.status] || 0) + 1;
  const kinds = Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ');
  const at = current ? `${fmt(Math.min(playback.elapsed(), current.duration || 0))} of ${fmt(current.duration || 0)}${room.paused ? ', paused' : ''}` : '';
  return { ok: true, version: common.VERSION, runBy: runBy(), online: users.length, text: [
    `Couchwave v${common.VERSION} is running on port ${PORT}.`,
    `Online now: ${users.join(', ') || 'nobody'}`,
    `Playing: ${current ? `"${current.title}" (added by ${current.by}), ${at}` : 'nothing'}`,
    `Queue: ${queue.length} song${queue.length === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}${downloads.isDiskFull() ? '. Downloads are paused: the disk is nearly full' : ''}`,
    `The DJ is ${room.dj && room.dj.isOn() ? 'on' : 'off'}.`,
  ].join('\n') };
}

Object.assign(exports, { handleRequests });
