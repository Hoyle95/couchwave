// ---------- Who's here ----------
const { secs } = require('./common');
const room = require('./room');
const { loggedIn } = require('./logins');

const LEAVE_AFTER = secs(60), CLOSED_AFTER = secs(10), ONLINE_FOR = secs(10);
let quietUntil = Date.now() + secs(15);
function checkIn(who) { room.seen[who] = Date.now(); arrived(who); }
function arrived(who) {
  if (room.here.has(who)) return;
  room.here.add(who);
  room.dirty = true;
  if (Date.now() > quietUntil) room.addLog(who, 'joined');
}
function departed(who, t) { delete room.closed[who]; if (room.here.delete(who)) { room.addLog(who, 'left', undefined, t); room.dirty = true; } }
const gone = (who, now) => now - (room.seen[who] || 0) > LEAVE_AFTER || (room.closed[who] > (room.seen[who] || 0) && now - room.closed[who] > CLOSED_AFTER);
function streamsSeen() {
  const now = Date.now();
  for (const res of room.listeners) {
    if (loggedIn(res.auth)?.acc.name !== res.who) { room.listeners.delete(res); res.end(); continue; }
    room.seen[res.who] = now;
  }
}
setInterval(() => {
  streamsSeen();
  const now = Date.now();
  for (const who of room.here) if (gone(who, now)) departed(who);
  if (room.here.size && now - room.savedAt > secs(30)) room.dirty = true;
}, secs(5));
const online = () => { const now = Date.now(); return Object.keys(room.seen).filter(n => now - room.seen[n] < ONLINE_FOR); };

// ---------- Who was here before a restart ----------
if (room.wasHere) {
  quietUntil = 0;
  const now = Date.now();
  for (const [who, t] of Object.entries(room.wasHere)) {
    if (typeof t !== 'number' || who === '__proto__' || who === 'constructor' || who === 'prototype') continue;
    room.here.add(who);
    room.seen[who] = Math.min(t, now);
    if (now - room.seen[who] > LEAVE_AFTER) departed(who, room.seen[who]);
  }
}

Object.assign(exports, { checkIn, departed, online });
