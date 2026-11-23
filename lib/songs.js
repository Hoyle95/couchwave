// ---------- Adding songs ----------
const crypto = require('crypto');
const { videoId, watchUrl, songText } = require('./common');
const { VOTE_PERCENT, MAX_LENGTH_TEXT, tooLong } = require('./settings');
const room = require('./room');
const downloads = require('./downloads');
const presence = require('./presence');

const PLAYLIST_MAX = 100, QUEUE_MAX = 500;
const queueFull = () => room.queue.length >= QUEUE_MAX;
const DJ_NAME = 'DJ';
const isDjSong = item => !!item && item.by === DJ_NAME;

function fairIndex(who) {
  const { queue, current } = room;
  if (who === DJ_NAME) return queue.length;
  const count = {};
  if (current && !isDjSong(current)) count[current.by] = 1;
  const round = queue.reduce((n, q) => n + (q.by === who), count[who] || 0) + 1;
  let at = 0;
  queue.forEach((q, i) => {
    if (isDjSong(q)) return;
    count[q.by] = (count[q.by] || 0) + 1;
    if (count[q.by] <= round) at = i + 1;
  });
  return at;
}
const known = s => ({ ...(s.duration > 0 && { duration: s.duration }), ...(s.channel && { channel: s.channel }) });
function addSong(url, title, who, about = {}) {
  const item = { id: room.nextId++, url, title, by: who, status: 'waiting', ...known(about) };
  room.queue.splice(fairIndex(who), 0, item);
  return item;
}
const alreadyHere = id => !!id && [room.current, ...room.queue].find(q => q && videoId(q.url) === id);
const songName = item => (/^https?:\/\//.test(item.title) ? 'That song' : `"${item.title}"`);
const alreadyText = item => (item === room.current ? 'is playing right now' : 'is already in the queue');

// ---------- Playlists ----------
function addPlaylist(link, who) {
  const job = { id: `playlist-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, link, who };
  room.playlistJobs.push(job);
  room.addLog(who, 'is adding a playlist…', job.id);
  readPlaylist(job);
}
function readPlaylist(job) {
  const { link, who } = job;
  downloads.listSongs(link, PLAYLIST_MAX, all => {
    room.playlistJobs = room.playlistJobs.filter(j => j !== job);
    const entry = room.log.find(e => e.id === job.id);
    const songs = all.filter(s => !tooLong(s)), skipped = all.length - songs.length;
    let n = 0, twice = 0, full = 0;
    for (const s of songs) {
      if (alreadyHere(s.id)) { twice++; continue; }
      if (queueFull()) { full++; continue; }
      addSong(watchUrl(s.id), s.title, who, s);
      n++;
    }
    const name = all.length && all[0].playlist;
    const out = [skipped && `${skipped} longer than ${MAX_LENGTH_TEXT}`, twice && `${twice} already in the queue`, full && `${full} more than the queue has room for (${QUEUE_MAX} songs)`].filter(Boolean);
    const left = out.length ? `, ${out.join(' and ')} left out` : '';
    if (entry) entry.text = all.length ? `added playlist${name ? ` "${name}"` : ''} (${n} song${n === 1 ? '' : 's'}${left})` : `couldn't read the playlist ${link}`;
    room.logRev++;
    room.dirty = true;
    downloads.pump();
  });
}

// ---------- Searching ----------
function addSearch(query, who) {
  const item = addSong(null, `Searching for "${query}"…`, who);
  Object.assign(item, { status: 'searching', query });
  room.addLog(who, `is searching for "${query}"…`, item.id);
  search(item);
}
const words = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function bestMatch(query, songs) {
  const wanted = [...words(query)];
  let best = null, bestScore = -1;
  for (const s of songs) {
    if (!(s.duration > 0) || tooLong(s)) continue;
    const title = words(s.title), score = wanted.filter(w => title.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}
function search(item) {
  downloads.listSongs(`ytsearch3:${item.query}`, 3, songs => {
    const s = bestMatch(item.query, songs);
    const entry = room.log.find(e => e.id === item.id && /^is searching/.test(e.text));
    const twin = s && alreadyHere(s.id);
    if (s && !twin) {
      Object.assign(item, { url: watchUrl(s.id), title: s.title, status: 'waiting', ...known(s) });
      if (entry) entry.text = item.removed ? `searched for "${item.query}" and found ${songText(s)}` : `added ${songText(s)}`;
    } else {
      const i = room.queue.indexOf(item);
      if (i >= 0) room.queue.splice(i, 1);
      room.trash.delete(item.id);
      if (entry) entry.text = twin ? `searched for "${item.query}": "${s.title}" ${alreadyText(twin)}`
        : songs.some(tooLong) ? `couldn't find anything shorter than ${MAX_LENGTH_TEXT} for "${item.query}"`
        : `couldn't find anything for "${item.query}"`;
    }
    delete item.query;
    room.logRev++;
    room.dirty = true;
    downloads.pump();
  });
}

// ---------- Removing songs ----------
const votesNeeded = people => Math.max(1, Math.ceil(people * VOTE_PERCENT / 100 - 1e-9));
function removeFromQueue(item, who, text, undoable) {
  const i = room.queue.indexOf(item);
  if (i < 0) return;
  room.queue.splice(i, 1);
  item.removed = true;
  room.removeVotes.delete(item.id);
  if (downloads.running.has(item.id)) downloads.stopDownload(item);
  const entry = room.addLog(who, text);
  if (undoable) { room.trash.set(item.id, { item, index: i, t: Date.now(), by: who }); entry.undo = item.id; }
  room.dirty = true;
  downloads.pump();
}
function dropTooLong(item) {
  const i = room.queue.indexOf(item);
  if (i >= 0) room.queue.splice(i, 1);
  item.removed = true;
  room.removeVotes.delete(item.id);
  const name = /^https?:\/\//.test(item.title) ? item.title : `"${item.title}"`;
  const text = `tried to add ${name}, but it's longer than ${MAX_LENGTH_TEXT}`;
  const entry = room.log.find(e => e.id === item.id);
  if (entry) { entry.text = text; room.logRev++; } else room.addLog(item.by, text);
  room.dirty = true;
}
function checkRemoves() {
  const people = presence.online();
  for (const [id, votes] of room.removeVotes) {
    const item = room.queue.find(q => q.id === id);
    if (!item) { room.removeVotes.delete(id); continue; }
    const voters = people.filter(n => votes.has(n));
    if (!voters.length || voters.length < votesNeeded(people.length)) continue;
    const last = [...votes].filter(n => voters.includes(n)).pop();
    removeFromQueue(item, last, people.length === 1 ? `removed "${item.title}"` : `removed "${item.title}" (${voters.length} of ${people.length} voted)`);
  }
}

Object.assign(exports, {
  QUEUE_MAX, queueFull,
  DJ_NAME, isDjSong, addSong, alreadyHere, songName, alreadyText, addPlaylist, readPlaylist, addSearch, search,
  votesNeeded, removeFromQueue, dropTooLong, checkRemoves,
});
