// ---------- The room ----------
const fs = require('fs');
const path = require('path');
const { DL, STATE, secs, writeAtomic } = require('./common');

const room = exports;
Object.assign(room, {
  HISTORY_MAX: 100, UNDO_MS: secs(600),
  nextId: 1, queue: [], current: null, startedAt: 0, paused: false, pausedAt: 0,
  log: [], chat: [], history: [], colors: {}, faces: {}, playlistJobs: [], newestTold: '',
  reactions: [], reactId: Date.now(), logRev: Date.now(), chatRev: Date.now(), historyRev: Date.now(),
  trash: new Map(), skipVotes: new Set(), removeVotes: new Map(),
  seen: {}, here: new Set(), closed: {}, wasHere: null, listeners: new Set(),
  dj: null, dirty: false, savedAt: 0, saveFailed: null,
});
room.trashed = () => [...room.trash.values()].map(e => e.item);

// ---------- Loading what was saved ----------
let saved = {};
try { saved = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; }
catch (err) {
  if (err.code !== 'ENOENT') {
    const copy = `${STATE}.broken-${Date.now()}`;
    try { fs.copyFileSync(STATE, copy); } catch {}
    console.error(`Can't read ${STATE} (${err.message}): starting with an empty queue. The old file is kept as ${path.basename(copy)}`);
  }
}
const listOf = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && !Array.isArray(x)) : []);
const objectOf = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
room.queue = listOf(saved.queue); room.current = objectOf(saved.current);
room.log = listOf(saved.log); room.chat = listOf(saved.chat); room.history = listOf(saved.history); room.playlistJobs = listOf(saved.playlists);
room.colors = objectOf(saved.colors) || {}; room.faces = objectOf(saved.faces) || {};
room.startedAt = Number(saved.startedAt) || 0; room.paused = saved.paused === true; room.pausedAt = Number(saved.pausedAt) || 0;
room.newestTold = typeof saved.newestTold === 'string' ? saved.newestTold : '';
room.wasHere = objectOf(saved.here);
for (const e of listOf(saved.trash)) {
  if (objectOf(e.item) && typeof e.t === 'number' && typeof e.by === 'string') room.trash.set(e.item.id, { item: e.item, index: Number(e.index) || 0, t: e.t, by: e.by });
}
room.nextId = Math.max(Number.isInteger(saved.nextId) ? saved.nextId : 1,
  ...[room.current, ...room.queue, ...room.trashed()].filter(Boolean).map(q => (Number(q.id) || 0) + 1));
for (const item of [room.current, ...room.queue, ...room.trashed()]) {
  if (!item) continue;
  for (const k of ['file', 'audio', 'out']) if (item[k]) item[k] = path.join(DL, path.basename(item[k]));
}
const savedSkip = objectOf(saved.skip), savedRemove = objectOf(saved.removeVotes);
if (savedSkip && room.current && savedSkip.song === room.current.id && Array.isArray(savedSkip.voters)) {
  for (const n of savedSkip.voters) if (typeof n === 'string') room.skipVotes.add(n);
}
if (savedRemove) {
  for (const [id, names] of Object.entries(savedRemove)) {
    if (Array.isArray(names) && room.queue.some(q => q.id === +id)) room.removeVotes.set(+id, new Set(names.filter(n => typeof n === 'string')));
  }
}

// ---------- Saving ----------
room.save = function save() {
  room.dirty = false;
  room.savedAt = Date.now();
  try {
    const here = Object.fromEntries([...room.here].map(n => [n, room.seen[n] || 0]));
    const skip = room.current ? { song: room.current.id, voters: [...room.skipVotes] } : null;
    const removeVotes = Object.fromEntries([...room.removeVotes].map(([id, votes]) => [id, [...votes]]));
    const { nextId, queue, current, startedAt, paused, pausedAt, log, chat, history, colors, faces, playlistJobs, newestTold } = room;
    writeAtomic(STATE, JSON.stringify({ nextId, queue, current, startedAt, paused, pausedAt, log, chat, history, colors, faces,
      here, skip, removeVotes, playlists: playlistJobs, trash: [...room.trash.values()], newestTold }));
    room.saveFailed = null;
  } catch (err) {
    room.dirty = true;
    room.saveFailed = err.message;
    console.error('save failed:', err.message);
  }
  room.nudge();
};

// ---------- Instant updates ----------
let nudgeTimer = null;
room.nudge = function nudge() {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => { nudgeTimer = null; for (const res of room.listeners) res.write('data: changed\n\n'); }, 30);
};
setInterval(() => { for (const res of room.listeners) res.write(': still here\n\n'); }, 25000);

// ---------- Activity log and chat ----------
room.addChat = function addChat(by, text, gif) {
  room.chat.push(gif ? { t: Date.now(), by, text: '', gif } : { t: Date.now(), by, text });
  if (room.chat.length > 200) room.chat.shift();
  room.chatRev++;
};
room.addLog = function addLog(by, text, id, t = Date.now()) {
  const log = room.log;
  let i = log.length;
  while (i > 0 && log[i - 1].t > t) i--;
  const entry = { t, by, text, id };
  log.splice(i, 0, entry);
  if (log.length > 200) log.shift();
  room.logRev++;
  return entry;
};
room.logLook = function logLook(who, text) {
  const last = room.log[room.log.length - 1], kind = text.split(' ').slice(0, 3).join(' ');
  if (last && last.by === who && last.text.startsWith(kind) && Date.now() - last.t < 60000) { last.t = Date.now(); last.text = text; room.logRev++; }
  else room.addLog(who, text);
};
