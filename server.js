// Couchwave: watch YouTube together with friends, on your own server. No npm packages needed.
// Run: node server.js   then open http://localhost:3000   (the password is in config.json, see README.md)
// Log everyone out: node server.js --logout-everyone
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The programs Couchwave runs (yt-dlp, ffmpeg, ffprobe). The tests (tests/) swap in stand-ins that act like
// them in a split second, without YouTube: COUCHWAVE_FAKE_TOOLS = a folder with a <name>.js for each.
const FAKE_TOOLS = process.env.COUCHWAVE_FAKE_TOOLS;
const run = (name, args) => (FAKE_TOOLS ? spawn(process.execPath, [path.join(FAKE_TOOLS, name + '.js'), ...args]) : spawn(name, args));
// The tests also run the clock faster: COUCHWAVE_TIME_SCALE=0.25 makes "10 seconds" last 2.5. It only changes
// timings about people (online, leaving, joining, votes, reactions, the DJ's checks), never songs. Normally 1.
const TIME_SCALE = Number(process.env.COUCHWAVE_TIME_SCALE) > 0 ? Number(process.env.COUCHWAVE_TIME_SCALE) : 1;
const secs = n => n * 1000 * TIME_SCALE; // n seconds, in milliseconds

// Everything the server saves goes in data/: the queue/chat/log (state.json), downloaded songs, log files.
// Back it up by copying the folder. It's not in git.
const DATA = path.join(__dirname, 'data');
const DL = path.join(DATA, 'downloads');
const STATE = path.join(DATA, 'state.json');
const MAX_DOWNLOADS = 3; // at the same time; the rest wait their turn (in queue order)
const PREFETCH = 20;     // the top this-many songs of the queue get downloaded ahead (so a big playlist doesn't
                         // fill the disk).
const PLAYLIST_MAX = 100; // songs taken from one playlist
const GRACE = 2;         // seconds after a song ends before the server moves on (see the timer below)
fs.mkdirSync(DL, { recursive: true });

// `node server.js --logout-everyone`: everyone has to enter the password again (works while the server is running).
const KEYFILE = path.join(DATA, 'login-key');
const newLoginKey = () => fs.writeFileSync(KEYFILE, crypto.randomBytes(32).toString('hex'));
if (process.argv.includes('--logout-everyone')) {
  newLoginKey();
  console.log('Done: everyone is logged out and has to enter the password again.');
  process.exit(0);
}

// Accounts: each nickname has its own password, set the first time someone joins with it (see "Logins").
// The admin commands --delete-account and --set-password are below.
const ACCOUNTS = path.join(DATA, 'accounts.json');

// Write a file safely: to a temporary file, then renamed over the real one, so a crash mid-write can't leave
// it half-written. The temporary name is unique, so two writers (the server, an admin command) can't clash.
// Throws if it fails (e.g. antivirus locking the file for a moment on Windows).
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch (err) { fs.rm(tmp, { force: true }, () => {}); throw err; }
}

// The accounts. No file yet = no accounts yet. A file that can't be read (locked for a moment, or broken by
// editing it by hand) throws instead of looking empty: otherwise every nickname would look free to claim,
// and saving the next one would wipe out everyone else's.
function readAccounts() {
  let text;
  try { text = fs.readFileSync(ACCOUNTS, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const list = JSON.parse(text);
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error('accounts.json should be a list of accounts');
  return list;
}
const writeAccounts = list => writeAtomic(ACCOUNTS, JSON.stringify(list, null, 1));

// Nicknames: spaces tidied up, look-alike characters made the same (NFKC: e.g. full-width letters) and
// invisible ones removed (zero-width spaces...), so nobody can make a second "Alice" that looks the same.
const cleanName = name => String(name || '').normalize('NFKC').replace(/[\p{Cf}\p{Cc}]/gu, '').trim().replace(/\s+/g, ' ').slice(0, 30);
const nameKey = name => String(name).toLowerCase(); // nicknames ignore capitals: "matt" is "Matt"
// Letters from more than one alphabet (a Cyrillic "А" in "Alice") would also make a look-alike.
const mixedAlphabets = name => [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u].filter(r => r.test(name)).length > 1;

// Admin commands for accounts (they work while the server is running: it notices accounts.json changing).
//   node server.js --delete-account <name>              an account nobody wants any more: logged out
//       everywhere, and the nickname is free. Whoever takes it next starts fresh (their own picture). Their
//       chat messages and activity stay, as history; songs they queued stay in the queue.
//   node server.js --set-password <name> <new password> a forgotten password: logged out everywhere, and
//       the new password works from now on. The account (picture, songs...) is kept.
// A deleted account is kept as a marker ({ name, deleted: time }), so that "starts fresh" works even if the
// server was off at the time.
const MIN_OWN_PASSWORD = 4;
const isAccount = a => a && !a.deleted;
const adminCommand = ['--delete-account', '--set-password'].find(c => process.argv.includes(c));
if (adminCommand) {
  const at = process.argv.indexOf(adminCommand);
  const name = cleanName(process.argv[at + 1]);
  let list;
  try { list = readAccounts(); } catch (err) { console.log(`Can't read ${ACCOUNTS}: ${err.message}`); process.exit(1); }
  const acc = Object.hasOwn(list, nameKey(name)) ? list[nameKey(name)] : null;
  if (!name || !isAccount(acc)) {
    const names = Object.values(list).filter(isAccount).map(a => a.name);
    console.log(`No account "${name}". Accounts: ${names.join(', ') || 'none yet'}`);
    process.exit(1);
  }
  if (adminCommand === '--delete-account') {
    list[nameKey(name)] = { name: acc.name, deleted: Date.now() };
    writeAccounts(list);
    console.log(`Done: "${acc.name}" is deleted and logged out. Whoever joins with that nickname next starts fresh.`);
  } else {
    const password = String(process.argv[at + 2] || '');
    if (password.length < MIN_OWN_PASSWORD) {
      console.log(`Usage: node server.js --set-password ${acc.name} <new password>   (at least ${MIN_OWN_PASSWORD} characters)`);
      process.exit(1);
    }
    const salt = crypto.randomBytes(16).toString('hex'); // a new salt also ends their old logins (see userToken)
    list[nameKey(name)] = { ...acc, salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
    writeAccounts(list);
    console.log(`Done: "${acc.name}" has a new password and is logged out everywhere. Send them the new password.`);
  }
  process.exit(0);
}

// ---------- Log file ----------
// Everything the server prints goes to server.log, with timestamps. Once it passes LOG_MAX it's trimmed to
// the newest LOG_KEEP (oldest lines dropped), so it never grows forever. Run by hand in a terminal, it also
// prints there.
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
    if (!fs.existsSync(LOGFILE)) return; // brand new: not even created yet
    const size = fs.statSync(LOGFILE).size;
    if (size <= LOG_MAX) return;
    const buf = Buffer.alloc(LOG_KEEP), fd = fs.openSync(LOGFILE, 'r');
    fs.readSync(fd, buf, 0, LOG_KEEP, size - LOG_KEEP);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const old = logStream, held = [];
    logStream = { write: l => held.push(l) }; // lines printed mid-trim wait here, then go in after
    old.end(() => {
      try { fs.writeFileSync(LOGFILE, `---- ${stamp()}: older lines trimmed, keeping the newest ----\n` + text.slice(text.indexOf('\n') + 1)); } catch {}
      logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
      for (const l of held) logStream.write(l);
    });
  } catch (err) { logOut('log trim failed: ' + err.message); }
}
trimLog();
setInterval(trimLog, 60 * 60 * 1000);
// A crash: write it down before exiting (start.cmd restarts the server).
process.on('uncaughtException', err => {
  try { fs.appendFileSync(LOGFILE, `${stamp()}  CRASH ${err.stack || err}\n`); } catch {}
  process.exit(1);
});

// ---------- Settings ----------
// config.json holds the room password, the port, votePercent and public (see below). It's not in git. The
// first run makes one with a random password, port 3000, votePercent 60 and public false; change them there.
// Saving the file restarts the server by itself when it's run with `node --watch` (start.cmd does).
const CONFIG = path.join(__dirname, 'config.json');
const DEFAULT_PORT = 3000, DEFAULT_VOTE_PERCENT = 60;
if (!fs.existsSync(CONFIG)) {
  const fresh = { password: crypto.randomBytes(6).toString('base64url'), port: DEFAULT_PORT, votePercent: DEFAULT_VOTE_PERCENT, public: false };
  fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`No config.json yet: made one with the password "${fresh.password}" and port ${fresh.port}. Change them in config.json.`);
}
// Can't start: say why (in the log and the console), then stop. With --watch, fixing config.json starts it again.
const fatal = msg => { const l = `${stamp()}  ${msg}\n`; try { fs.appendFileSync(LOGFILE, l); } catch {} process.stderr.write(l); process.exit(1); };
let config;
try { config = require(CONFIG); } catch (err) { fatal('config.json is broken: ' + err.message); }
const PORT = process.env.PORT || config.port || DEFAULT_PORT;
const PASSWORD = String(process.env.YTP_PASSWORD || config.password || '');
// public: true = no room password: anyone who has the address can join (with a nickname and its own password,
// so names are still protected). Not recommended: see the README. Only the exact value true turns it on.
const PUBLIC = config.public === true;
if (!PASSWORD && !PUBLIC) fatal('No password set: put one in config.json');
if (PUBLIC) console.log('config.json: "public" is on: there\'s no room password, so anyone who has the address can join');
// votePercent: how many of the people online (as a percentage, rounded up) have to vote to skip the song
// playing, or to remove someone else's song from the queue. The DJ isn't a person, so it never counts.
const VOTE_PERCENT = (() => {
  const p = Number(config.votePercent ?? DEFAULT_VOTE_PERCENT);
  if (p > 0 && p <= 100) return p;
  console.log(`config.json: votePercent should be a number from 1 to 100, not ${JSON.stringify(config.votePercent)}; using ${DEFAULT_VOTE_PERCENT}`);
  return DEFAULT_VOTE_PERCENT;
})();

// Logins: joining takes the room password (config.json: keeps strangers out) plus a nickname and that
// nickname's own password (keeps the name yours). The first time a nickname is used, its password is
// whatever that person chooses. Nicknames ignore capitals: "matt" is "Matt". Own passwords are kept
// scrambled (scrypt, in data/accounts.json), never the passwords themselves.
// The server answers with a login cookie that says who you are, signed with a secret key (data/login-key),
// so it can't be edited to be someone else, and browsers never store a password. A new key
// (--logout-everyone), a new room password, or --delete-account / --set-password for one account ends old logins.
let keyCache = { mtime: -1, key: '' };
function loginKey() {
  if (!fs.existsSync(KEYFILE)) newLoginKey();
  const mtime = fs.statSync(KEYFILE).mtimeMs; // re-read when the file changes, so a running server notices
  if (mtime !== keyCache.mtime) keyCache = { mtime, key: fs.readFileSync(KEYFILE, 'utf8').trim() };
  return keyCache.key;
}
const same = (a, b) => { a = Buffer.from(String(a ?? '')); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const AUTH_COOKIE = 'auth=%s; Path=/; Max-Age=%d; SameSite=Lax; HttpOnly';
// The nickname, for the page to show (and to fill in the join screen next time). Only shown: the server
// goes by the login cookie.
const NAME_COOKIE = 'name=%s; Path=/; Max-Age=31536000; SameSite=Lax';

// accounts.json: { "<nickname in lower case>": { name: as typed when it was claimed, salt, hash, created } }
// (or { name, deleted: time } for a deleted one, see --delete-account).
// Kept in memory, and re-read when the file changes (admin commands). If it can't be read, the last good copy
// is kept and `broken` says why: nobody can claim a nickname until it reads again (see readAccounts()).
let accCache = { mtime: -2, list: {}, broken: null };
function accounts() {
  let mtime = -1;
  try { mtime = fs.statSync(ACCOUNTS).mtimeMs; } catch {}
  if (mtime !== accCache.mtime) {
    try { accCache = { mtime, list: readAccounts(), broken: null }; }
    catch (err) { // keep the last good copy; mtime unchanged, so it tries again next time
      if (accCache.broken !== err.message) console.error(`Can't read ${ACCOUNTS}: ${err.message}`);
      accCache.broken = err.message;
    }
  }
  return accCache.list;
}
// Saves the accounts with one added, re-reading the file first so nothing written meanwhile is lost
// (e.g. by an admin command). Returns false if someone claimed that nickname in the meantime. Throws if it can't save.
function addAccount(acc) {
  const list = readAccounts(), key = nameKey(acc.name);
  if (Object.hasOwn(list, key) && isAccount(list[key])) return false;
  list[key] = acc;
  writeAccounts(list);
  let mtime = -1;
  try { mtime = fs.statSync(ACCOUNTS).mtimeMs; } catch {}
  accCache = { mtime, list, broken: null }; // what was just written (not left to the mtime, which can be coarse)
  return true;
}
// (A reserved nickname never has an account, even one made before it was reserved: nobody can log in as "DJ".)
const account = name => { const list = accounts(), key = nameKey(name); return !RESERVED.has(key) && Object.hasOwn(list, key) && isAccount(list[key]) ? list[key] : null; };
const wasDeleted = name => { const list = accounts(), key = nameKey(name); return Object.hasOwn(list, key) && !!list[key].deleted; };
// Not allowed as nicknames: the activity log's own entries, the DJ's name, and names that would confuse object lookups.
const RESERVED = new Set(['server', 'someone', 'dj', '__proto__', 'constructor', 'prototype']);
let dj = null; // the DJ (dj.js), started further down (see "The DJ")
const DJ_NAME = 'DJ'; // its songs go in under this name (reserved above), always after everyone else's
const isDjSong = item => !!item && item.by === DJ_NAME;
// Scrambling a password takes a moment (that's the point: it makes guessing slow), so it runs in the
// background rather than holding up everyone's video and chat.
const scramble = (password, salt) => new Promise((ok, fail) =>
  crypto.scrypt(String(password), salt, 32, (err, key) => (err ? fail(err) : ok(key.toString('hex')))));

// Login cookie: "<nickname, base64url>.<signature>". The signature covers the room password, the nickname
// and that account's salt (new for every account), so freeing a nickname and claiming it again ends old logins.
const userToken = acc => Buffer.from(acc.name).toString('base64url') + '.' +
  crypto.createHmac('sha256', loginKey()).update(`${PASSWORD}\n${nameKey(acc.name)}\n${acc.salt}`).digest('base64url');
function loggedIn(cookie) { // the account a login cookie belongs to, or null
  cookie = String(cookie || '');
  const dot = cookie.lastIndexOf('.');
  if (dot < 1) return null;
  const acc = account(Buffer.from(cookie.slice(0, dot), 'base64url').toString());
  return acc && same(cookie, userToken(acc)) ? acc : null;
}

// ---------- State ----------
let nextId = 1;
let queue = [];        // { id, url, title, by, status: 'waiting'|'downloading'|'ready'|'failed', duration, file, audio }
let current = null;    // item currently playing
let startedAt = 0;     // Date.now() when current started (shifted on seek/resume)
let paused = false;
let pausedAt = 0;      // position in seconds while paused
let log = [];          // { t, by, text, id } newest last, capped at 200
let chat = [];         // { t, by, text } newest last, capped at 200
let history = [];      // songs played: { url, title, by, t: when it started } newest FIRST, the last HISTORY_MAX
const HISTORY_MAX = 100;
let colors = {};       // nickname -> '#rrggbb' they picked (older entries may be a hue number)
let faces = {};        // nickname -> the emoji they picked for their profile picture (pages make one up otherwise)

// Not saved:
const seen = {};       // nickname -> last time their page checked in

// "joined" / "left" in the activity log. Someone has left once their page hasn't checked in for a minute
// (so a phone briefly dropping out isn't logged), about 10 seconds after they close the page (a reload
// comes back sooner, so isn't logged), or straight away when they log out. Who's here is saved with the
// rest of the state, so a restart neither forgets people (and misses their "left") nor re-announces them.
const here = new Set();
const LEAVE_AFTER = secs(60), CLOSED_AFTER = secs(10);
const ONLINE_FOR = secs(10); // "online": checked in within the last 10 seconds (pages do every 2)
const closed = {};     // nickname -> when their page said it was closing (POST /bye)
let quietUntil = Date.now() + secs(15); // state saved before "here" was: don't announce pages already open
function arrived(who) {
  if (here.has(who)) return;
  here.add(who);
  dirty = true;
  if (Date.now() > quietUntil) addLog(who, 'joined');
}
// t: when they left, if not now (someone last seen before the server was switched off).
function departed(who, t) { delete closed[who]; if (here.delete(who)) { addLog(who, 'left', undefined, t); dirty = true; } }
// Gone: no check-in for a minute, or their page said it was closing and hasn't checked in since (a reload
// checks in again within a second or two, so it doesn't count; neither does closing one of two tabs).
const gone = (who, now) => now - (seen[who] || 0) > LEAVE_AFTER || (closed[who] > (seen[who] || 0) && now - closed[who] > CLOSED_AFTER);
setInterval(() => {
  const now = Date.now();
  for (const who of here) if (gone(who, now)) departed(who);
  if (here.size && now - savedAt > secs(30)) dirty = true; // keeps the saved last-seen times fresh (see save())
}, secs(5));
let wasHere = null;    // who was here when the server last stopped, and when each was last seen (loaded below)
let savedSkip = null;  // skip votes when the server last stopped (loaded below, see "Vote to skip")
let savedRemove = null; // votes to remove queued songs, the same (see "Vote to remove")
let reactions = [];    // { id, t, e, n, cid } emoji floating over the video; n = clicks in the bundle, cid = sending page
let reactId = Date.now();  // ids start from the clock so they keep increasing across restarts
// Log/chat change counters. Pages send back the ones they have, and only get the log/chat again when it
// changed: most polls are then tiny. Start from the clock so a restart never matches an old value.
let logRev = Date.now(), chatRev = Date.now(), historyRev = Date.now();
const running = new Map(); // id -> yt-dlp process, for songs downloading right now
// Deleted songs can be undone for 10 minutes (from the Activity log). Their files are kept until then.
const trash = new Map();   // id -> { item, index }  (index = where it was in the queue)
const UNDO_MS = 10 * 60 * 1000;

try {
  ({ nextId, queue, current, startedAt, paused = false, pausedAt = 0, log = [], chat = [], history = [], colors = {}, faces = {}, here: wasHere = null, skip: savedSkip = null, removeVotes: savedRemove = null } =
    JSON.parse(fs.readFileSync(STATE, 'utf8')));
} catch {}
for (const e of log) delete e.undo; // the trash does not survive a restart
// Song files are found by name in data/downloads, wherever the data folder has been copied/moved to.
for (const item of [current, ...queue]) {
  if (!item) continue;
  for (const k of ['file', 'audio', 'out']) if (item[k]) item[k] = path.join(DL, path.basename(item[k]));
}

// Saving: changes people make are saved straight away (so a restart never loses a click);
// background changes (downloads finishing, songs advancing) mark the state dirty and the 1s timer saves it.
let dirty = false, savedAt = 0;
function save() {
  dirty = false;
  savedAt = Date.now();
  try {
    // here: who's here and when each was last seen (saved at least every 30s while anyone is, so a restart
    // can tell a quick restart from the server having been off). skip: the votes on the current song.
    const herePlus = Object.fromEntries([...here].map(n => [n, seen[n] || 0]));
    const skip = current ? { song: current.id, voters: [...skipVotes] } : null;
    const removeVotesSaved = Object.fromEntries([...removeVotes].map(([id, votes]) => [id, [...votes]]));
    writeAtomic(STATE, JSON.stringify({ nextId, queue, current, startedAt, paused, pausedAt, log, chat, history, colors, faces, here: herePlus, skip, removeVotes: removeVotesSaved }));
  } catch (err) {
    dirty = true; // e.g. antivirus briefly locking the file on Windows: try again next second
    console.error('save failed:', err.message);
  }
  nudge(); // something changed: pages fetch it now (see "Instant updates")
}

// ---------- Instant updates ----------
// Each page keeps a /events connection open. When anything changes (a chat message, a song starting, a
// vote, someone joining: everything that gets saved, plus reactions), every page gets a nudge and fetches
// /state straight away, instead of on its next 2-second check. Nudges close together are sent as one.
const listeners = new Set(); // open /events responses
let nudgeTimer = null;
function nudge() {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => { nudgeTimer = null; for (const res of listeners) res.write('data: changed\n\n'); }, 30);
}
// Cloudflare closes a connection that's been silent for 100 seconds: say something every 25.
setInterval(() => { for (const res of listeners) res.write(': still here\n\n'); }, 25000);

// People here before the restart, with when each was last seen. Back within the minute (e.g. --watch
// restarting the server): carries on as if nothing happened. Gone longer (the server was off): "left",
// at the time they were last seen. (Saves from before last-seen times were kept are just a list of names.)
if (wasHere && typeof wasHere === 'object') {
  quietUntil = 0;
  const now = Date.now();
  const list = Array.isArray(wasHere) ? Object.fromEntries(wasHere.map(n => [n, now - ONLINE_FOR])) : wasHere;
  for (const [who, t] of Object.entries(list)) {
    if (typeof t !== 'number' || who === '__proto__' || who === 'constructor' || who === 'prototype') continue;
    here.add(who);
    seen[who] = Math.min(t, now);
    if (now - seen[who] > LEAVE_AFTER) departed(who, seen[who]);
  }
}

const elapsed = () => (paused ? pausedAt : (Date.now() - startedAt) / 1000);
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

function addLog(by, text, id, t = Date.now()) {
  let i = log.length;
  while (i > 0 && log[i - 1].t > t) i--; // an entry for earlier (see departed()): in its place, not at the end
  log.splice(i, 0, { t, by, text, id });
  if (log.length > 200) log.shift();
  logRev++;
}

// Someone changed their profile picture. Several tweaks in a row (within a minute) are one log entry,
// e.g. dragging around the colour wheel, or trying a few emojis.
function logLook(who, text) {
  const last = log[log.length - 1], kind = text.split(' ').slice(0, 3).join(' '); // "changed their colour/emoji"
  if (last && last.by === who && last.text.startsWith(kind) && Date.now() - last.t < 60000) { last.t = Date.now(); last.text = text; logRev++; }
  else addLog(who, text);
}

// ---------- Downloads ----------
// Delete files no song refers to: played songs, and duplicates left by downloads a restart interrupted.
// Files of downloads in progress (e.g. 5-123.mp4.part, 5-123.f137.mp4) are kept by matching their prefix.
function cleanup() {
  const keep = [current, ...queue, ...[...trash.values()].map(x => x.item)].filter(Boolean)
    .map(q => (q.status === 'downloading' ? q.out : q.file))
    .filter(Boolean).map(f => path.basename(f, '.mp4'));
  for (const f of fs.readdirSync(DL)) {
    if (!keep.some(k => f.startsWith(k))) fs.rm(path.join(DL, f), { force: true }, () => {}); // locked files retry next minute
  }
}

// Downloads: the top PREFETCH songs of the queue get downloaded (so the disk doesn't fill up with a whole
// playlist), MAX_DOWNLOADS at a time, highest in the queue first. If both slots are busy with songs lower
// down than a waiting one (e.g. a song that went in ahead of them), the lowest is stopped and restarted
// later, so the song nearer the top goes first. Called whenever a download finishes, a song is played,
// or the queue changes.
function pump() {
  for (const [i, q] of queue.slice(0, PREFETCH).entries()) {
    if (q.status !== 'waiting') continue;
    if (running.size >= MAX_DOWNLOADS) {
      const lowest = [...running.keys()].map(id => queue.find(x => x.id === id)).filter(Boolean)
        .sort((a, b) => queue.indexOf(b) - queue.indexOf(a))[0];
      if (!lowest || queue.indexOf(lowest) < i) break; // the slots are on songs above this one: wait your turn
      stopDownload(lowest);
    }
    download(q);
  }
}

// yt-dlp.exe on Windows is a launcher that starts the real downloader as a child process, so killing it alone
// leaves the download running: kill the whole process tree.
function killTree(proc) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on('error', () => proc.kill());
  else proc.kill();
}

// Put a downloading song back to waiting (it starts again from scratch later; cleanup() clears its files).
function stopDownload(item) {
  const proc = running.get(item.id);
  if (proc) killTree(proc);
  running.delete(item.id);
  item.out = null; // marks the old attempt as stale, so its exit is ignored
  item.status = 'waiting';
  dirty = true;
}

// Fair queue: people take turns. Someone's new song goes in their next "round" (their 1st song in the queue is
// round 1, their 2nd round 2...): after every song from the same or an earlier round, so it never jumps ahead
// of anyone who's waited longer, and one big playlist can't keep everyone else waiting. The song playing now
// counts as its person's turn. (The queue can't be reordered by hand.)
// The DJ's songs (see "The DJ") don't take turns: they go at the very end, and people's songs go ahead of them.
function fairIndex(who) {
  if (who === DJ_NAME) return queue.length;
  const count = {};
  if (current && !isDjSong(current)) count[current.by] = 1;
  const round = queue.reduce((n, q) => n + (q.by === who), count[who] || 0) + 1; // the new song's round
  let at = 0;
  queue.forEach((q, i) => {
    if (isDjSong(q)) return;
    count[q.by] = (count[q.by] || 0) + 1;
    if (count[q.by] <= round) at = i + 1;
  });
  return at;
}

function addSong(url, title, who) {
  const item = { id: nextId++, url, title, by: who, status: 'waiting' };
  queue.splice(fairIndex(who), 0, item);
  return item;
}

// Read songs from YouTube without downloading anything (takes a few seconds): a playlist's songs, or
// search results ("ytsearch3:daft punk"). Calls back with [{ id, duration, title, playlist }], playable ones only.
function listSongs(target, max, cb) {
  const p = run('yt-dlp', [
    '--encoding', 'utf-8', // (see download())
    '--flat-playlist', '--yes-playlist', '--playlist-end', String(max),
    '--print', '%(id)s\t%(duration)s\t%(title)s\t%(playlist_title)s', '--', target, // tab-separated: titles can contain anything else
  ]);
  let stdout = '', finished = false;
  p.stdout.setEncoding('utf8'); // (a character split between two chunks still comes out whole)
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => logOut(d));
  const finish = () => {
    if (finished) return;
    finished = true;
    const songs = [];
    for (const line of stdout.split('\n')) {
      const [id, duration, title, playlist] = line.trim().split('\t');
      if (!/^[\w-]{11}$/.test(id || '') || /^\[(Private|Deleted|Unavailable) video\]$/.test(title)) continue; // skip unplayable entries
      songs.push({ id, duration: parseFloat(duration) || 0, title: title || id, playlist: playlist && playlist !== 'NA' ? playlist : '' });
    }
    cb(songs);
  };
  p.on('error', finish);
  p.on('close', finish);
}

// A whole playlist: queue every song (each one fitted into the fair queue).
function addPlaylist(link, who) {
  addLog(who, 'is adding a playlist…');
  const entry = log[log.length - 1];
  listSongs(link, PLAYLIST_MAX, songs => {
    for (const s of songs) addSong(`https://www.youtube.com/watch?v=${s.id}`, s.title, who);
    const name = songs.length && songs[0].playlist, n = songs.length;
    entry.text = n ? `added playlist${name ? ` "${name}"` : ''} (${n} song${n === 1 ? '' : 's'})` : `couldn't read the playlist ${link}`;
    logRev++;
    dirty = true;
    pump();
  });
}

// A song name instead of a link: queue YouTube's top result. Looks at the top 3 and skips livestreams
// (no length), which can't be played.
// A "Searching for …" stand-in goes into the queue straight away, in its fair place, so songs stay in the
// order they were asked for however long each search takes (and people see their request went in). It
// turns into the song when the search is done, or goes if nothing was found. It can be deleted
// like any song meanwhile; a search cut short by a restart starts again (see the startup code).
function addSearch(query, who) {
  const item = addSong(null, `Searching for "${query}"…`, who);
  Object.assign(item, { status: 'searching', query });
  addLog(who, `is searching for "${query}"…`, item.id);
  search(item);
}

// Which search result to queue. Livestreams (no length) can't be played. Of the rest, the one whose title has
// the most of the words typed: YouTube's order varies from one search to the next, and its top result isn't
// always the song asked for ("a-ha Take On Me" once came back with another a-ha song first). A tie goes to
// YouTube's order.
const words = text => new Set(String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
function bestMatch(query, songs) {
  const wanted = [...words(query)];
  let best = null, bestScore = -1;
  for (const s of songs) {
    if (!(s.duration > 0)) continue;
    const title = words(s.title), score = wanted.filter(w => title.has(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  return best;
}

function search(item) {
  listSongs(`ytsearch3:${item.query}`, 3, songs => {
    const s = bestMatch(item.query, songs);
    const entry = log.find(e => e.id === item.id && /^is searching/.test(e.text));
    if (s) {
      Object.assign(item, { url: `https://www.youtube.com/watch?v=${s.id}`, title: s.title, status: 'waiting' });
      if (entry) entry.text = `added "${s.title}"`;
    } else {
      // Nothing playable: the stand-in goes (from the queue, or from the deleted songs if it was deleted meanwhile).
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      trash.delete(item.id);
      if (entry) entry.text = `couldn't find anything for "${item.query}"`;
    }
    delete item.query;
    logRev++;
    dirty = true;
    pump();
  });
}

// Turn yt-dlp's error output into a short reason, and whether trying again could help.
function failReason(err) {
  // The last error line, without "ERROR: [youtube] <id>: " in front.
  const msg = ((err.match(/ERROR: .*/g) || []).pop() || '').replace(/^ERROR: (\[\w+\] [\w-]+: )?/, '');
  if (/confirm your age|age.restricted|inappropriate/i.test(msg)) return ['Age-restricted', true];
  if (/private video/i.test(msg)) return ['Private video', true];
  if (/unavailable|has been removed|not available|does not exist|terminated/i.test(msg)) return ['Unavailable', true];
  if (/members.only|join this channel/i.test(msg)) return ['Members only', true];
  if (/HTTP Error 403/i.test(msg)) return ['Blocked by YouTube (403)', false];
  if (/HTTP Error 429|too many requests/i.test(msg)) return ['YouTube rate limit', false];
  if (/not a bot/i.test(msg)) return ['YouTube bot check', false];
  return [msg.slice(0, 80) || 'Download error', false];
}

// A download failed. Temporary problems (e.g. YouTube refusing one attempt) are retried automatically,
// twice, 10s then 20s later; permanent ones (age-restricted, private...) stay failed until someone retries.
function failed(item, reason, permanent) {
  item.status = 'failed';
  item.error = reason;
  item.tries = (item.tries || 0) + 1;
  if (!permanent && item.tries <= 2) { item.retryAt = Date.now() + 10000 * item.tries; return; } // silent: it'll try again
  item.retryAt = null;
  addLog(item.by, `couldn't download "${item.title}" (${reason})`);
}

// Length of a downloaded file in seconds (0 if it can't be read). For the odd video whose length
// YouTube doesn't report: without one, the server would move on 2 seconds into the song.
function probeDuration(file, cb) {
  const p = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  let out = '', fin = false;
  const end = () => { if (fin) return; fin = true; cb(parseFloat(out) || 0); };
  p.stdout.on('data', d => (out += d));
  p.on('error', end);
  p.on('close', end);
}

// Try a failed song again (the retry button).
function retry(item) {
  Object.assign(item, { status: 'waiting', tries: 0, error: null, retryAt: null });
  dirty = true;
}

function download(item) {
  // Unique name per attempt, so a download left running by an old server can't clash with a new one.
  const out = path.join(DL, `${item.id}-${Date.now()}.mp4`);
  item.out = out;
  item.status = 'downloading';
  dirty = true;
  const p = run('yt-dlp', [
    // Titles in UTF-8: on Windows yt-dlp otherwise prints in the old system code page, and anything outside
    // it (a "–", accents, emoji, other alphabets) arrives as "�".
    '--encoding', 'utf-8',
    '--no-playlist', '--playlist-items', '1', // a playlist link: just its first video
    '--no-progress', '--match-filter', '!is_live', // a livestream would download forever
    '-S', 'res:720,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4',
    '-o', out, '--print', 'after_move:%(duration)s|%(title)s', '--', item.url,
  ]);
  running.set(item.id, p);
  let stdout = '', stderr = '', done = false;
  p.stdout.setEncoding('utf8'); // (a character split between two chunks still comes out whole)
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => { logOut(d); stderr = (stderr + d).slice(-4000); });
  // 'error' (yt-dlp missing) and 'close' can both fire: handle whichever comes first, once.
  const finish = code => {
    if (done) return;
    done = true;
    // Deleted from the queue, or stopped to make way for a song moved to the top: ignore this attempt
    // (cleanup() clears its files).
    if (item.removed || item.out !== out) return pump();
    running.delete(item.id);
    dirty = true;
    const line = stdout.trim().split('\n').pop() || '';
    const i = line.indexOf('|');
    if (code !== 0 || i < 0) {
      // Exit code 0 with no output = filtered out by --match-filter, i.e. a livestream.
      if (code === 0) failed(item, "Livestreams aren't supported", true);
      else failed(item, ...failReason(stderr));
      return pump();
    }
    item.error = null; item.tries = 0;
    item.duration = parseFloat(line.slice(0, i)) || 0;
    item.title = line.slice(i + 1);
    const entry = log.find(e => e.id === item.id);
    if (entry) { entry.text = `added "${item.title}"`; logRev++; } // swap the link for the real title
    item.file = out;
    // Copy the audio track into its own small file (no re-encoding, takes a second or two).
    // Phones pause <video> when the screen locks but keep <audio> playing, so pages play sound from this.
    const audio = out.replace(/\.mp4$/, '.m4a');
    const f = run('ffmpeg', ['-y', '-loglevel', 'error', '-i', out, '-vn', '-c:a', 'copy', audio]);
    let fDone = false;
    const ready = ok => {
      if (fDone) return;
      fDone = true;
      if (item.out !== out) return; // stopped (made way for another song) while the audio was being copied
      // (if it was deleted meanwhile, still mark it ready: it's in the trash, and Undo brings it back ready)
      if (ok) item.audio = audio;
      const isReady = () => {
        if (item.out !== out) return;
        if (!item.duration) { failed(item, "Couldn't read the video length", true); return pump(); }
        item.status = 'ready';
        dirty = true;
        pump(); // a 'downloading' slot in the top songs just became 'ready'
      };
      if (item.duration) isReady();
      else probeDuration(out, d => { item.duration = d; isReady(); });
    };
    f.stderr.on('data', d => logOut(d));
    f.on('error', () => ready(false)); // no ffmpeg: /audio falls back to the video file
    f.on('close', c => ready(c === 0));
    pump();
  };
  p.on('error', () => finish(-1));
  p.on('close', finish);
}

// ---------- Vote to skip ----------
// Skip is a vote: the song is skipped once votePercent of the people online have voted (config.json, 60 by
// default, rounded up: 2 of 3, 3 of 4, 3 of 5, 4 of 6; on your own, one click skips). Clicking again takes
// your vote back. Votes are for the current song only, and only count while the voter is online, so someone
// leaving can tip the vote over. Only people count: the DJ never checks in, so it's never online.
const skipVotes = new Set(); // nicknames, in the order they voted
// Votes from before a restart, if the same song is still playing.
if (savedSkip && current && savedSkip.song === current.id && Array.isArray(savedSkip.voters)) {
  for (const n of savedSkip.voters) if (typeof n === 'string') skipVotes.add(n);
}
const online = () => { const now = Date.now(); return Object.keys(seen).filter(n => now - seen[n] < ONLINE_FOR); };
// Votes needed (to skip, or to remove someone else's song) with this many people online: never fewer than 1.
const votesNeeded = people => Math.max(1, Math.ceil(people * VOTE_PERCENT / 100 - 1e-9));
function checkSkip() {
  if (!current) return;
  const people = online(), voters = people.filter(n => skipVotes.has(n));
  if (!voters.length || voters.length < votesNeeded(people.length)) return;
  // On your own, you skipped it; otherwise it was a group effort, so nobody's name goes on it.
  if (people.length === 1) addLog(voters[0], `skipped "${current.title}"`);
  else addLog('', `"${current.title}" was skipped (${voters.length} of ${people.length} voted)`);
  advance();
}

// ---------- Vote to remove ----------
// Every queued song has a bin button. Whoever added a song removes it straight away; anyone else's (the
// DJ's too) is a vote: it goes once votePercent of the people online have voted, as for skipping.
// Clicking again takes the vote back; votes only count while the voter is online, and survive a restart.
const removeVotes = new Map(); // song id -> Set of nicknames, in the order they voted
if (savedRemove && typeof savedRemove === 'object') {
  for (const [id, names] of Object.entries(savedRemove)) {
    if (Array.isArray(names) && queue.some(q => q.id === +id)) removeVotes.set(+id, new Set(names.filter(n => typeof n === 'string')));
  }
}
// Takes a song out of the queue (into the deleted songs, for Undo) and logs it as `who`.
function removeFromQueue(item, who, text) {
  const i = queue.indexOf(item);
  if (i < 0) return;
  queue.splice(i, 1);
  item.removed = true;
  removeVotes.delete(item.id);
  if (running.has(item.id)) stopDownload(item); // still downloading: stop it, free its slot now
  trash.set(item.id, { item, index: i, t: Date.now(), by: who }); // files kept for 10 minutes, in case of undo
  addLog(who, text);
  log[log.length - 1].undo = item.id;
  dirty = true;
  pump(); // its download slot is free for the next waiting song
}
function checkRemoves() {
  const people = online();
  for (const [id, votes] of removeVotes) {
    const item = queue.find(q => q.id === id);
    if (!item) { removeVotes.delete(id); continue; }
    const voters = people.filter(n => votes.has(n));
    if (!voters.length || voters.length < votesNeeded(people.length)) continue;
    const last = [...votes].filter(n => voters.includes(n)).pop(); // the vote that tipped it
    removeFromQueue(item, last, people.length === 1 ? `removed "${item.title}"` : `removed "${item.title}" (${voters.length} of ${people.length} voted)`);
  }
}

// ---------- Playback ----------
const nextUp = () => queue.find(q => q.status === 'ready'); // the song that will play next

// headStart: seconds the next song has already been playing on people's pages (see the timer below).
function advance(headStart = 0) {
  if (current) { fs.rm(current.file, () => {}); if (current.audio) fs.rm(current.audio, () => {}); }
  current = null;
  paused = false;
  skipVotes.clear(); // a new song starts with no votes
  const idx = queue.findIndex(q => q.status === 'ready');
  if (idx >= 0) {
    current = queue.splice(idx, 1)[0];
    // It's playing now, so votes to remove it carry over as votes to skip it (they wanted it gone).
    // Anyone who still wants it can take theirs back; checkSkip (every second) skips it if there are enough.
    for (const n of removeVotes.get(current.id) || []) if (n !== current.by) skipVotes.add(n);
    removeVotes.delete(current.id);
    startedAt = Date.now() - headStart * 1000;
    // History (the panel under Activity, and the DJ's ideas): newest first, the last HISTORY_MAX.
    history.unshift({ url: current.url, title: current.title, by: current.by, t: Date.now() });
    history.length = Math.min(history.length, HISTORY_MAX);
    historyRev++;
  }
  dirty = true;
  pump(); // one fewer song ready ahead: room to download another
}

// Every second: move on when the current song is over (+ GRACE seconds).
// Pages switch to the next song by themselves the moment a song ends (phones block starting audio
// in the background, but allow carrying straight on), so by the time we advance here, the next song
// has been playing for about the grace period already: start its clock from there, so nobody jumps back.
setInterval(() => {
  checkSkip(); // a voter may have come back, or someone who hadn't voted left
  checkRemoves(); // the same, for votes to remove queued songs
  if (!current) { if (nextUp()) advance(); }
  else if (!paused && elapsed() > current.duration + GRACE) advance(Math.min(elapsed() - current.duration, GRACE + 1));
  // Failed songs stay in the queue (with a retry button) until someone retries or deletes them;
  // temporary failures retry by themselves when due.
  // Deleted songs past their 10 minutes: gone for good (the Undo button disappears, cleanup() takes the files).
  for (const [id, { t }] of trash) if (Date.now() - t > UNDO_MS) { trash.delete(id); logRev++; }
  const due = queue.filter(q => q.status === 'failed' && q.retryAt && Date.now() >= q.retryAt);
  for (const q of due) { q.status = 'waiting'; q.retryAt = null; dirty = true; }
  if (due.length) pump();
  if (dirty) save();
}, secs(1));

// After a restart: downloads that were cut off start again.
for (const q of queue) if (q.status === 'downloading' || q.status === 'waiting') q.status = 'waiting';
// ...and searches for a song name start again.
for (const q of queue) if (q.status === 'searching' && q.query) search(q);
pump();
cleanup();
setInterval(() => {
  cleanup();
  for (const [ip, f] of fails) if (Date.now() - f.since > FAIL_WINDOW) fails.delete(ip);
}, 60 * 1000);

// ---------- The DJ ----------
// dj.js: plays something like what people have been asking for when the queue runs out, if someone has
// typed "!dj on" in the chat. This is everything it can use. Its songs are queued as "DJ" (the name can't
// be taken as a nickname). Removing or skipping them is a vote, as for anyone's songs.
dj = require('./dj')({
  dataDir: DATA,
  writeAtomic,
  faces,
  queue: () => queue,
  current: () => current,
  history: () => history, // newest first
  // YouTube's Mix (radio playlist) for a video: [{ id, duration, title }]
  mix: id => new Promise(ok => listSongs(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, 30, ok)),
  addSong: (url, title, by, logText) => { addSong(url, title, by); addLog(by, logText); pump(); dirty = true; },
  log: (who, text) => { addLog(who, text); dirty = true; },
  say: (by, text) => { chat.push({ t: Date.now(), by, text }); if (chat.length > 200) chat.shift(); chatRev++; dirty = true; },
});

// ---------- Keeping yt-dlp up to date ----------
// YouTube changes things often and an old yt-dlp is the usual reason downloads start failing (e.g. 403 errors).
// "yt-dlp -U" checks GitHub for the newest release, verifies it and swaps it in. Run a minute after startup,
// then daily; it waits until no downloads are running.
let ytdlpVersion = '';
function updateYtdlp() {
  if (running.size) return setTimeout(updateYtdlp, 5 * 60 * 1000); // busy: try again in 5 minutes
  const p = run('yt-dlp', ['-U']);
  let out = '', fin = false;
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const end = () => {
    if (fin) return;
    fin = true;
    // yt-dlp says e.g. "Updated yt-dlp to stable@2026.11.20 from yt-dlp/yt-dlp"
    //              or "yt-dlp is up to date (stable@2026.10.26 from yt-dlp/yt-dlp)"
    const updated = /Updated yt-dlp to:?\s*(?:\S*@)?([\d.]+)/i.exec(out);
    const current = /up to date \((?:\S*@)?([\d.]+)/i.exec(out);
    if (updated) { ytdlpVersion = updated[1]; addLog('server', `updated yt-dlp to ${ytdlpVersion}`); dirty = true; }
    else if (current) ytdlpVersion = current[1];
    logOut('yt-dlp update check: ' + (out.trim().split('\n').pop() || 'no output'));
  };
  p.on('error', end);
  p.on('close', end);
}
setTimeout(updateYtdlp, 60 * 1000);
setInterval(updateYtdlp, 24 * 60 * 60 * 1000);

// ---------- What pages see ----------
const pub = i => i && { id: i.id, url: i.url, title: i.title, by: i.by, duration: i.duration };

function state(q) {
  const now = Date.now();
  for (const n in seen) if (now - seen[n] > 3600000) delete seen[n]; // forget people gone for an hour
  const users = online().sort((a, b) => a.localeCompare(b));
  const s = {
    current: pub(current),
    elapsed: current ? elapsed() : 0,
    paused,
    next: pub(nextUp()),
    // removeVoters: who (online) has voted to remove each song (see "Vote to remove")
    queue: queue.map(({ id, url, title, by, status, error, retryAt }) => ({ id, url, title, by, status, error, retrying: !!retryAt,
      removeVoters: removeVotes.has(id) ? users.filter(n => removeVotes.get(id).has(n)) : [] })),
    colors, faces,
    reactions: reactions.filter(r => now - r.t < secs(6)),
    users,
    skip: { voters: users.filter(n => skipVotes.has(n)), need: votesNeeded(users.length) }, // vote to skip
    dj: !!(dj && dj.isOn()),
    logRev, chatRev, historyRev,
  };
  // `undo` (a song id) shows an Undo button on a "removed" entry, while that song can still be brought back.
  if (q.get('log') !== String(logRev)) s.log = log.map(({ t, by, text, undo }) => ({ t, by, text, undo: trash.has(undo) ? undo : undefined }));
  if (q.get('chat') !== String(chatRev)) s.chat = chat;
  if (q.get('history') !== String(historyRev)) s.history = history;
  return s;
}

// ---------- HTTP helpers ----------
// Songs are sent at a steady pace rather than as fast as the connection allows. Browsers grab video as
// fast as they can, and a few of them doing that fills the host's upload: then everything else (chat,
// the page, the 2-second updates) gets stuck behind it, and through a Cloudflare Tunnel a reply can stall
// for 10+ seconds. So each download gets its first PACE_BURST seconds of the song at full speed (songs and
// seeks start straight away), then PACE_SPEEDUP times the song's own bitrate (the browser's buffer still
// grows the whole time), and never less than PACE_MIN bytes a second.
const PACE_BURST = 20, PACE_SPEEDUP = 3, PACE_MIN = 256 * 1024; // 256 KB/s = 2 Mbit/s

// Pipe a file stream to the response: `burst` bytes straight away, then `rate` bytes a second. Time
// spent waiting on the viewer (their buffer is full, they paused, a slow phone) only banks up one second
// of sending, so a download that stalled doesn't then make up for it in one full-speed rush.
async function paced(stream, res, rate, burst) {
  let credit = burst, last = Date.now(); // bytes that may go out right now
  res.on('close', () => stream.destroy()); // the viewer went away (closed, seeked, next song): stop reading
  const drained = () => new Promise(r => {
    const go = () => { res.off('drain', go); res.off('close', go); r(); };
    res.on('drain', go); res.on('close', go);
  });
  try {
    for await (const chunk of stream) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await drained();
      const now = Date.now();
      credit = Math.min(credit + (now - last) / 1000 * rate, Math.max(credit, rate)) - chunk.length;
      last = now;
      if (credit < 0) await new Promise(r => setTimeout(r, -credit / rate * 1000));
    }
    res.end();
  } catch { res.destroy(); }
}

// duration (seconds): pace the download to the song's bitrate (see above). Without it, send at full speed.
function sendFile(req, res, file, type, duration) {
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const size = st.size;
    const bitrate = duration > 0 ? size / duration : 0; // bytes per second of song
    const send = (opts) => {
      const stream = fs.createReadStream(file, opts);
      if (!bitrate) return stream.on('error', () => res.destroy()).pipe(res);
      paced(stream, res, Math.max(PACE_MIN, bitrate * PACE_SPEEDUP), bitrate * PACE_BURST);
    };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
      return send();
    }
    let start, end;
    if (!m[1]) { start = Math.max(0, size - +m[2]); end = size - 1; } // "bytes=-500" = the last 500 bytes
    else { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    send({ start, end });
  });
}

function sendJson(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// A change someone made: save it now, reply with no content (pages poll for the new state).
function done(res) { save(); res.writeHead(204); res.end(); }

function readJson(req, max, cb) {
  let body = '';
  req.on('data', d => { body += d; if (body.length > max) req.destroy(); });
  req.on('end', () => { let data; try { data = JSON.parse(body); } catch {} cb(data && typeof data === 'object' ? data : {}); });
}

function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map(c => {
    const i = c.indexOf('=');
    try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return ['', '']; }
  }));
}

// Wrong-password limit: 20 tries per 15 minutes per address. Behind a tunnel or reverse proxy on this
// machine every request comes from localhost, so then use the visitor address it passes along. Those
// headers are only trusted from localhost: anyone else could fake them to dodge the limit.
const fails = new Map(); // ip -> { n, since }
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 20;
const ipOf = req => {
  const direct = req.socket.remoteAddress || '';
  if (!/^(::1|127\.|::ffff:127\.)/.test(direct)) return direct;
  const h = req.headers;
  return h['cf-connecting-ip'] || h['x-real-ip'] || String(h['x-forwarded-for'] || '').split(',')[0].trim() || direct;
};

// Installing the site as a phone/desktop app. Icons are in icons/ (made from icons/icon.svg).
const MANIFEST = JSON.stringify({
  name: 'Couchwave', short_name: 'Couchwave', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0c0c11', theme_color: '#0c0c11',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }, // Android's shaped icons
  ],
});

// ---------- Routes ----------
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const route = req.method + ' ' + url.pathname;

  if (route === 'GET /') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }

  // For the join screen: whether the room is public (then it hides the room password box).
  if (route === 'GET /room') return sendJson(res, { public: PUBLIC });

  // "Add to Home screen" / install as an app: the app description and its icons. Phones fetch these
  // without the password cookie, and there's nothing private in them.
  if (route === 'GET /manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(MANIFEST);
  }
  const icon = /^\/icons\/([\w-]+\.png)$/.exec(url.pathname);
  if (req.method === 'GET' && icon) {
    const file = path.join(__dirname, 'icons', icon[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    return fs.createReadStream(file).pipe(res);
  }
  // The font (Inter, from Google Fonts, kept in fonts/ so pages never contact Google). The join screen uses it too.
  const font = /^\/fonts\/([\w-]+\.woff2)$/.exec(url.pathname);
  if (req.method === 'GET' && font) {
    const file = path.join(__dirname, 'fonts', font[1]);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'font/woff2', 'Cache-Control': 'max-age=2592000' });
    return fs.createReadStream(file).pipe(res);
  }

  // Join screen: check the password and hand out the login cookie. Wrong tries count towards the limit.
  if (route === 'POST /login') {
    const ip = ipOf(req), f = fails.get(ip);
    if (f && Date.now() - f.since > FAIL_WINDOW) fails.delete(ip);
    else if (f && f.n >= FAIL_MAX) { res.writeHead(429); return res.end('Too many wrong passwords, try again later'); }
    // { password: the room password, name: nickname, own: that nickname's own password }
    return readJson(req, 2000, async ({ password, name, own }) => {
      const say = (status, msg) => { res.writeHead(status); res.end(msg); };
      // Every try counts towards the wrong-password limit straight away (so many at once can't slip past it
      // while their passwords are being checked); a right one is taken off again.
      const g = fails.get(ip) || { n: 0, since: Date.now() };
      g.n++; fails.set(ip, g);
      let counted = true;
      const right = () => { if (counted) { counted = false; g.n = Math.max(0, g.n - 1); } }; // at most once
      try {
        if (!PUBLIC && !same(password, PASSWORD)) return say(401, 'Wrong room password');
        name = cleanName(name);
        if (!name || RESERVED.has(nameKey(name))) { right(); return say(400, 'Pick a different nickname'); }
        if (mixedAlphabets(name)) { right(); return say(400, 'Use letters from one alphabet in your nickname'); }
        own = String(own || '');
        let acc = account(name);
        if (accCache.broken) { right(); return say(503, 'Logins are paused: the server can\'t read its accounts file. Try again in a moment'); }
        if (acc) {
          if (!same(await scramble(own, acc.salt), acc.hash)) return say(401, `"${acc.name}" is taken. If it's yours, that's not its password`);
        } else {
          right();
          if (own.length < MIN_OWN_PASSWORD) return say(400, `Choose a password for your nickname (at least ${MIN_OWN_PASSWORD} characters)`);
          // A deleted account's nickname: the new owner starts fresh, without the old one's picture.
          if (wasDeleted(name)) {
            for (const list of [colors, faces]) for (const n of Object.keys(list)) if (nameKey(n) === nameKey(name)) delete list[n];
            dirty = true;
          }
          // Someone from before accounts (or from the queue, chat...) with this name in other capitals: keep their
          // spelling, so "lvj" claiming the name keeps LVJ's picture, songs and votes.
          const known = [...Object.keys(colors), ...Object.keys(faces), ...here, ...queue.map(q => q.by), current && current.by]
            .find(n => n && nameKey(n) === nameKey(name));
          if (known) name = known;
          const salt = crypto.randomBytes(16).toString('hex');
          acc = { name, salt, hash: await scramble(own, salt), created: Date.now() };
          let added;
          try { added = addAccount(acc); }
          catch (err) { console.error('saving accounts failed:', err.message); return say(503, 'Couldn\'t save your nickname. Try again in a moment'); }
          if (!added) return say(401, `"${name}" was just taken by someone else`); // claimed while this one was being set up
        }
        right();
        res.writeHead(204, { 'Set-Cookie': [
          AUTH_COOKIE.replace('%s', userToken(acc)).replace('%d', 31536000), // a year
          NAME_COOKIE.replace('%s', encodeURIComponent(acc.name)), // as it was claimed: "matt" logs in as "Matt"
        ] });
        res.end();
      } catch (err) {
        console.error('login failed:', err.message);
        if (!res.headersSent) say(500, 'Something went wrong. Try again');
      }
    });
  }
  if (route === 'POST /logout') {
    const acc = loggedIn(parseCookies(req.headers.cookie).auth);
    if (acc) { delete seen[acc.name]; departed(acc.name); }
    res.writeHead(204, { 'Set-Cookie': AUTH_COOKIE.replace('%s', '').replace('%d', 0) }); // the name cookie stays, for the join screen
    return res.end();
  }

  // Everything else needs the login cookie, and goes by the nickname in it.
  const acc = loggedIn(parseCookies(req.headers.cookie).auth);
  if (!acc) { res.writeHead(401); return res.end('Not logged in'); }
  const who = acc.name;

  switch (route) {
    case 'GET /state':
      seen[who] = Date.now();
      arrived(who);
      return sendJson(res, { ...state(url.searchParams), me: who }); // me: who you're logged in as (the page goes by this)

    case 'GET /events': // instant updates (see nudge())
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n'); // after a drop-out, the browser reconnects in 3 seconds
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
      return;

    case 'POST /bye': // the page was closed (or is reloading): "left" soon, unless it checks in again (see gone())
      if (here.has(who)) closed[who] = Date.now();
      res.writeHead(204); return res.end();

    case 'POST /add': // { url: a YouTube link or a song name to search for, playlist: true = queue the whole playlist }
      return readJson(req, 2000, ({ url: link, playlist }) => {
        link = String(link || '').trim();
        if (!link) { res.writeHead(400); return res.end('Paste a YouTube link or type a song name'); }
        if (!/^https?:\/\//i.test(link)) { addSearch(link.slice(0, 150), who); return done(res); }
        if (!/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(link)) {
          res.writeHead(400); return res.end('Not a YouTube link');
        }
        if (playlist === true && /[?&]list=/.test(link)) { addPlaylist(link, who); return done(res); }
        const item = addSong(link, link, who);
        addLog(who, `added ${link}`, item.id);
        pump();
        done(res);
      });

    case 'POST /skip': // { id: the song, vote: true = vote to skip it / false = take the vote back } (see checkSkip)
      return readJson(req, 200, ({ id, vote }) => {
        // Counts as here and online, e.g. the lock-screen "next" button on a phone whose page has gone quiet.
        seen[who] = Date.now();
        arrived(who);
        if (current && id === undefined) { id = current.id; vote = !skipVotes.has(who); } // a page from before votes said which song
        if (current && id === current.id) { // a vote for a song that has already ended does nothing
          if (vote !== false && current.by === who) { // your own song: skipped straight away, no vote (the DJ's: a vote, like any other)
            addLog(who, `skipped their song "${current.title}"`);
            advance();
          } else {
            if (vote === false) skipVotes.delete(who); else skipVotes.add(who);
            checkSkip();
          }
        }
        done(res);
      });

    case 'POST /pause':
      if (current && !paused) { pausedAt = elapsed(); paused = true; addLog(who, `paused at ${fmt(pausedAt)}`); }
      return done(res);

    case 'POST /play':
      if (paused) { startedAt = Date.now() - pausedAt * 1000; paused = false; addLog(who, 'resumed'); }
      return done(res);

    // { t }: move through the song. Only whoever added it can: anyone else could jump to the end, which skips it
    // without a vote. (The DJ's songs: nobody.)
    case 'POST /seek':
      return readJson(req, 200, ({ t }) => {
        if (current && current.by !== who) { res.writeHead(403); return res.end('Only whoever added the song can move it'); }
        if (current) {
          t = Math.max(0, Math.min(Number(t) || 0, current.duration));
          if (paused) pausedAt = t; else startedAt = Date.now() - t * 1000;
          addLog(who, `jumped to ${fmt(t)}`);
        }
        done(res);
      });

    // { id, vote }: your own song goes straight away. Anyone else's (the DJ's too): vote: true = vote to remove
    // it, false = take the vote back (see "Vote to remove"). A page from before votes sends no vote: a vote.
    case 'POST /remove':
      return readJson(req, 200, ({ id, vote }) => {
        const item = queue.find(q => q.id === id);
        if (item) {
          seen[who] = Date.now(); // counts as online
          arrived(who);
          if (item.by === who) removeFromQueue(item, who, `removed "${item.title}"`);
          else {
            const votes = removeVotes.get(item.id) || new Set();
            if (vote === false) votes.delete(who); else votes.add(who);
            if (votes.size) removeVotes.set(item.id, votes); else removeVotes.delete(item.id);
            checkRemoves();
          }
        }
        done(res);
      });

    case 'POST /undo': // bring back a deleted song: { id }. Only whoever deleted it can.
      return readJson(req, 200, ({ id }) => {
        const entry = trash.get(id);
        if (entry && entry.item.by !== who && entry.by !== who) { res.writeHead(403); return res.end('Only whoever deleted a song can bring it back'); }
        if (entry) {
          const { item, index } = entry;
          trash.delete(id);
          item.removed = false;
          // Downloaded: ready again straight away. Stopped mid-download: starts again. Failed: stays failed (retry button).
          // (Still searching: stays searching, the search fills it in.)
          if (item.status !== 'failed' && item.status !== 'searching' && !(item.status === 'ready' && item.file && fs.existsSync(item.file))) {
            Object.assign(item, { status: 'waiting', out: null, file: null, audio: null });
          }
          queue.splice(Math.min(index, queue.length), 0, item); // back where it was
          for (const e of log) if (e.undo === id) delete e.undo;
          addLog(who, `restored "${item.title}"`);
          pump();
        }
        done(res);
      });

    case 'POST /retry': // try a failed song again: { id }
      return readJson(req, 200, ({ id }) => {
        const item = queue.find(q => q.id === id && q.status === 'failed');
        if (item) { retry(item); addLog(who, `retried "${item.title}"`); pump(); }
        done(res);
      });

    case 'POST /chat':
      return readJson(req, 2000, ({ text }) => {
        text = String(text || '').trim().slice(0, 500);
        if (text && dj && dj.command(who, text)) return done(res); // "!dj on" etc.: for the DJ, not posted
        if (text) {
          chat.push({ t: Date.now(), by: who, text });
          if (chat.length > 200) chat.shift();
          chatRev++;
        }
        done(res);
      });

    // Profile picture: { color: '#rrggbb' } / { face: emoji }. quiet = sent while joining (the picture they set
    // up on the join screen), which isn't news for the log.
    case 'POST /color':
      return readJson(req, 200, ({ color, quiet }) => {
        color = String(color || '').toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(color) && colors[who] !== color) {
          colors[who] = color;
          if (!quiet) logLook(who, 'changed their colour');
        }
        done(res);
      });

    case 'POST /face':
      return readJson(req, 200, ({ face, quiet }) => {
        face = String(face || '');
        if (face.length <= 16 && /\p{Extended_Pictographic}/u.test(face) && !/[<>&"'\s]/.test(face) && faces[who] !== face) {
          faces[who] = face;
          if (!quiet) logLook(who, `changed their emoji to ${face}`);
        }
        done(res);
      });

    case 'POST /react': // { e: emoji, n: clicks, cid: page id }. Spammy, so it isn't saved or logged.
      return readJson(req, 300, r => {
        const e = String(r.e || '');
        if (e.length <= 16 && /\p{Extended_Pictographic}/u.test(e) && !/[<>&"']/.test(e)) {
          const now = Date.now();
          reactions.push({ id: ++reactId, t: now, e, n: Math.max(1, Math.min(50, Math.round(Number(r.n)) || 1)), cid: String(r.cid || '').slice(0, 20) });
          reactions = reactions.filter(x => now - x.t < secs(8)).slice(-300);
          nudge();
        }
        res.writeHead(204); res.end();
      });
  }

  // Media for the current song, or the next ready one (pages start it the instant the current one ends).
  const media = /^\/(video|audio)\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && media) {
    const id = +media[2];
    const item = current && current.id === id ? current : queue.find(q => q.id === id && q.status === 'ready');
    if (!item) { res.writeHead(404); return res.end(); }
    // Audio: the audio-only copy (for playing with the screen off), or the mp4 itself if there isn't one.
    if (media[1] === 'audio' && item.audio && fs.existsSync(item.audio)) return sendFile(req, res, item.audio, 'audio/mp4', item.duration);
    return sendFile(req, res, item.file, 'video/mp4', item.duration);
  }

  res.writeHead(404); res.end();
}).listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
