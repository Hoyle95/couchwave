// ---------- Starting Couchwave ----------
const { DATA, secs, writeAtomic, watchUrl } = require('./common');
require('./log');
require('./settings');
require('./addresses');
require('./logins');
require('./limits');
const room = require('./room');
require('./presence');
const songs = require('./songs');
const downloads = require('./downloads');
const playback = require('./playback');
const admin = require('./admin');
const { killTree } = require('./tools');

// ---------- Picking up where it left off ----------
for (const job of room.playlistJobs) songs.readPlaylist(job);
for (const e of room.log) {
  if (e.text === 'is adding a playlist…' && !room.playlistJobs.some(j => j.id === e.id)) { e.text = 'didn\'t finish adding a playlist (Couchwave restarted): add it again'; room.logRev++; }
}
for (const q of [...room.queue, ...room.trashed()]) {
  if (q.status === 'downloading') q.status = 'waiting';
  if (q.status === 'searching' && q.query) songs.search(q);
}
for (const q of [...room.queue]) if (q.status === 'failed' && /^Longer than /.test(q.error || '')) songs.dropTooLong(q);
for (const q of [room.current, ...room.queue]) if (q && q.status === 'ready') downloads.measureLoudness(q);
downloads.pump();
downloads.cleanup();
setInterval(() => { downloads.cleanup(); downloads.pump(); }, 60 * 1000);

// ---------- Every second ----------
setInterval(() => {
  playback.tick();
  admin.handleRequests();
  if (room.dirty) room.save();
}, secs(1));

// ---------- The DJ ----------
room.dj = require('./dj')({
  dataDir: DATA,
  writeAtomic,
  faces: room.faces,
  queue: () => room.queue,
  current: () => room.current,
  history: () => room.history,
  youtubePaused: () => downloads.youtubePaused(),
  mix: id => new Promise(ok => downloads.listSongs(`${watchUrl(id)}&list=RD${id}`, 30, ok)),
  addSong: (url, title, by, logText, about) => { songs.addSong(url, title, by, about); room.addLog(by, logText); downloads.pump(); room.dirty = true; },
  log: (who, text) => { room.addLog(who, text); room.dirty = true; },
  say: (by, text) => { room.addChat(by, text); room.dirty = true; },
});

// ---------- Told to stop (Ctrl+C, systemctl stop, shutting down) ----------
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    room.save();
    for (const p of downloads.running.values()) killTree(p);
    process.exit(0);
  });
}

// ---------- Upkeep and the web server ----------
require('./upkeep');
require('./routes').serve();
