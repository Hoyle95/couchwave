// ---------- Playback ----------
const fs = require('fs');
const room = require('./room');
const downloads = require('./downloads');
const songs = require('./songs');
const presence = require('./presence');

const GRACE = 2;
const elapsed = () => (room.paused ? room.pausedAt : (Date.now() - room.startedAt) / 1000);
const nextUp = () => room.queue.find(q => q.status === 'ready');

function advance(headStart = 0) {
  const old = room.current;
  if (old) for (const f of [old.file, old.audio]) if (f) fs.rm(f, () => {});
  room.current = null;
  room.paused = false;
  room.skipVotes.clear();
  const idx = room.queue.findIndex(q => q.status === 'ready');
  if (idx >= 0) {
    const current = room.current = room.queue.splice(idx, 1)[0];
    for (const n of room.removeVotes.get(current.id) || []) if (n !== current.by) room.skipVotes.add(n);
    room.removeVotes.delete(current.id);
    room.startedAt = Date.now() - headStart * 1000;
    room.history.unshift({ url: current.url, title: current.title, ...(current.channel && { channel: current.channel }), by: current.by, t: Date.now(), ...(current.duration > 0 && { duration: current.duration }) });
    room.history.length = Math.min(room.history.length, room.HISTORY_MAX);
    room.historyRev++;
  }
  room.dirty = true;
  downloads.pump();
}

// ---------- Vote to skip ----------
function checkSkip() {
  const current = room.current;
  if (!current) return;
  const people = presence.online(), voters = people.filter(n => room.skipVotes.has(n));
  if (!voters.length || voters.length < songs.votesNeeded(people.length)) return;
  if (people.length === 1) room.addLog(voters[0], `skipped "${current.title}"`);
  else room.addLog('', `"${current.title}" was skipped (${voters.length} of ${people.length} voted)`);
  advance();
}

// ---------- Every second ----------
function tick() {
  checkSkip();
  songs.checkRemoves();
  const current = room.current;
  if (!current) { if (nextUp()) advance(); }
  else if (!room.paused && elapsed() > current.duration + GRACE) advance(Math.min(elapsed() - current.duration, GRACE + 1));
  for (const [id, { t }] of room.trash) if (Date.now() - t > room.UNDO_MS) { room.trash.delete(id); room.logRev++; room.dirty = true; }
  const due = room.queue.filter(q => q.status === 'failed' && q.retryAt && Date.now() >= q.retryAt);
  for (const q of due) { q.status = 'waiting'; q.retryAt = null; room.dirty = true; }
  if (due.length) downloads.pump();
}

Object.assign(exports, { elapsed, nextUp, advance, checkSkip, tick });
