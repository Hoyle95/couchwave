// ---------- Setup ----------
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const net = require('net');
const { spawn } = require('child_process');

const VERSION = '0.2.1-beta';
const RELEASES = process.env.COUCHWAVE_RELEASES_URL || 'https://api.github.com/repos/Hoyle95/couchwave/releases?per_page=10';
function versionNumbers(tag) { return (/(\d+)\.(\d+)\.(\d+)/.exec(tag || '') || []).slice(1).map(Number); }
function newer(tag, than) {
  const a = versionNumbers(tag), b = versionNumbers(than);
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const FAKE_TOOLS = process.env.COUCHWAVE_FAKE_TOOLS;
const TIME_SCALE = Number(process.env.COUCHWAVE_TIME_SCALE) > 0 ? Number(process.env.COUCHWAVE_TIME_SCALE) : 1;
const secs = n => n * 1000 * TIME_SCALE;
function run(name, args, limit, what = name) {
  const p = FAKE_TOOLS ? spawn(process.execPath, [path.join(FAKE_TOOLS, name + '.js'), ...args]) : spawn(name, args);
  if (limit) {
    const timer = setTimeout(() => { p.timedOut = true; logOut(`${what} was still going after ${Math.round(limit / secs(60))} minutes: stopped`); killTree(p); }, limit);
    p.on('close', () => clearTimeout(timer));
    p.on('error', () => clearTimeout(timer));
  }
  return p;
}
const TOOL_LIMIT = secs(60 * (Number(process.env.COUCHWAVE_TOOL_MINUTES) || 30));

const WEB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const DL = path.join(DATA, 'downloads');
const STATE = path.join(DATA, 'state.json');
fs.mkdirSync(DL, { recursive: true });

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch (err) { fs.rm(tmp, { force: true }, () => {}); throw err; }
}

// ---------- Accounts ----------
const ACCOUNTS = path.join(DATA, 'accounts.json');
function readAccounts() {
  let text;
  try { text = fs.readFileSync(ACCOUNTS, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  const list = JSON.parse(text);
  if (!list || typeof list !== 'object' || Array.isArray(list)) throw new Error('accounts.json should be a list of accounts');
  return list;
}
const writeAccounts = list => writeAtomic(ACCOUNTS, JSON.stringify(list, null, 1));

const cleanName = name => [...String(name || '').normalize('NFKC').replace(/[\p{Cf}\p{Cc}\p{Cs}]/gu, '').trim().replace(/\s+/g, ' ')].slice(0, 30).join('').trim();
const nameKey = name => String(name).toLowerCase();
const mixedAlphabets = name => [/\p{Script=Latin}/u, /\p{Script=Cyrillic}/u, /\p{Script=Greek}/u].filter(r => r.test(name)).length > 1;

const MIN_OWN_PASSWORD = 4;
const isAccount = a => a && !a.deleted;

// ---------- Admin commands ----------
const KEYFILE = path.join(DATA, 'login-key');
const newLoginKey = () => fs.writeFileSync(KEYFILE, crypto.randomBytes(32).toString('hex'));
if (process.argv.includes('--logout-everyone')) {
  newLoginKey();
  console.log('Done: everyone is logged out and has to enter the password again.');
  process.exit(0);
}

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
    const setPassword = password => {
      if (password.length < MIN_OWN_PASSWORD) {
        console.log(`That's too short: it needs at least ${MIN_OWN_PASSWORD} characters. Nothing was changed.`);
        process.exit(1);
      }
      const now = readAccounts(), salt = crypto.randomBytes(16).toString('hex');
      now[nameKey(name)] = { ...now[nameKey(name)], salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
      writeAccounts(now);
      console.log(`Done: "${acc.name}" has a new password and is logged out everywhere. Send them the new password.`);
      process.exit(0);
    };
    if (process.argv[at + 2] !== undefined) setPassword(String(process.argv[at + 2]));
    askQuietly(`New password for "${acc.name}" (it won't show as you type): `).then(setPassword);
    return;
  }
  process.exit(0);
}

function askQuietly(question) {
  const input = process.stdin;
  process.stdout.write(question);
  input.setEncoding('utf8');
  return new Promise(resolve => {
    let typed = '', finished = false;
    const done = () => { if (finished) return; finished = true; input.off('data', onData); if (input.isTTY) input.setRawMode(false); input.pause(); process.stdout.write('\n'); resolve(typed); };
    const onData = text => {
      for (const c of text) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1);
        else typed += c;
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.on('data', onData);
    input.on('end', done);
    input.resume();
  });
}

// ---------- Removing a song (for whoever runs Couchwave) ----------
const REQUESTS = path.join(DATA, 'requests');
function videoId(url) {
  return (/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url || '') || [])[1];
}
function savedState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; } }
const songLine = (queue, q) => `${queue.indexOf(q) + 1}. ${q.title} (added by ${q.by})`;
function queueList(queue) {
  if (!queue.length) return 'The queue is empty.';
  return queue.slice(0, 50).map(q => songLine(queue, q)).join('\n') + (queue.length > 50 ? `\n…and ${queue.length - 50} more` : '');
}
function findSong(queue, what) {
  if (/^\d+$/.test(what)) {
    const q = queue[Number(what) - 1];
    if (q) return { song: q };
    return { problem: queue.length ? `There's no song ${what}: the queue has ${queue.length}.\n\n${queueList(queue)}` : 'The queue is empty.' };
  }
  const id = videoId(what);
  const found = id ? queue.filter(q => videoId(q.url) === id) : queue.filter(q => String(q.title).toLowerCase().includes(what.toLowerCase()));
  if (found.length === 1) return { song: found[0] };
  if (found.length) return { problem: `${found.length} songs match "${what}". Use its number instead:\n${found.map(q => songLine(queue, q)).join('\n')}` };
  return { problem: `Nothing in the queue matches "${what}".\n\n${queueList(queue)}` };
}
const askYesNo = question => new Promise(resolve => {
  process.stdout.write(question);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', d => { process.stdin.pause(); resolve(/^\s*y/i.test(d)); });
  process.stdin.once('end', () => resolve(false));
  process.stdin.resume();
});

async function removeSongCommand(what) {
  const queue = (s => (Array.isArray(s.queue) ? s.queue.filter(q => q && typeof q === 'object') : []))(savedState());
  if (!what) {
    console.log(`Usage: node server.js --remove-song <queue number, YouTube link or part of the name>\n\n${queueList(queue)}`);
    process.exit(1);
  }
  const { song, problem } = findSong(queue, what);
  if (problem) { console.log(problem); process.exit(1); }
  if (process.stdin.isTTY && !(await askYesNo(`Remove ${songLine(queue, song)}? [y/N] `))) { console.log('Nothing was changed.'); process.exit(1); }
  await askServer({ removeSong: song.id });
  const state = savedState(), at = (Array.isArray(state.queue) ? state.queue : []).findIndex(q => q && q.id === song.id);
  if (at < 0) { console.log('That song isn\'t in the queue any more. Nothing was changed.'); process.exit(1); }
  state.queue.splice(at, 1);
  state.log = [...(Array.isArray(state.log) ? state.log : []), { t: Date.now(), by: 'server', text: `removed "${song.title}" (whoever runs Couchwave did)` }].slice(-200);
  writeAtomic(STATE, JSON.stringify(state));
  console.log(`Done: removed "${song.title}" from the queue.`);
  process.exit(0);
}

const configFile = () => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')) || {}; } catch { return {}; } };
async function askServer(request, keep) {
  const port = Number(configFile().port) || 3000;
  const running = await fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: AbortSignal.timeout(3000) })
    .then(r => r.json()).then(m => m.name === 'Couchwave', () => false);
  if (!running) return;
  fs.mkdirSync(REQUESTS, { recursive: true });
  const file = path.join(REQUESTS, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  writeAtomic(file + '.json', JSON.stringify(request));
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    let reply;
    try { reply = JSON.parse(fs.readFileSync(file + '.reply', 'utf8')); } catch { continue; }
    fs.rmSync(file + '.reply', { force: true });
    if (keep) return reply;
    console.log(reply.text);
    process.exit(reply.ok ? 0 : 1);
  }
  fs.rmSync(file + '.json', { force: true });
  const why = `Couchwave on port ${port} didn't answer within 10 seconds (if it was started from a different folder, run this there)`;
  if (keep) return { ok: false, text: why + '.' };
  console.log(why + '. Nothing was changed.');
  process.exit(1);
}

function toolVersion(name, flag) {
  return new Promise(resolve => {
    const p = FAKE_TOOLS ? spawn(process.execPath, [path.join(FAKE_TOOLS, name + '.js'), flag]) : spawn(name, [flag]);
    const timer = setTimeout(() => p.kill(), 10000);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('error', () => { clearTimeout(timer); resolve(`${name}: not found`); });
    p.on('close', code => {
      clearTimeout(timer);
      const first = String(out).trim().split(/\r?\n/)[0];
      resolve(code === 0 && first ? `${name} ${first.replace(/^ff\w+ version /, '').split(' ')[0]}` : `${name}: not found`);
    });
  });
}
async function statusCommand() {
  const reply = await askServer({ status: true }, true), lines = [];
  if (reply) lines.push(reply.text);
  else {
    const s = savedState(), count = v => (Array.isArray(v) ? v.length : 0);
    lines.push(`Couchwave v${VERSION} isn't running.`, `Saved: ${count(s.queue)} song${count(s.queue) === 1 ? '' : 's'} in the queue, ${count(s.history)} in the played history.`);
  }
  try { const st = fs.statfsSync(DATA); lines.push(`Disk: ${(st.bavail * st.bsize / 1024 ** 3).toFixed(1)} GB free`); } catch {}
  const tools = await Promise.all([toolVersion('yt-dlp', '--version'), toolVersion('ffmpeg', '-version'), toolVersion('ffprobe', '-version')]);
  lines.push(`Tools: ${[...tools, `Node.js ${process.versions.node}`].join(', ')}`);
  if (configFile().updateCheck !== false) {
    const newest = await fetch(RELEASES, { headers: { 'User-Agent': 'Couchwave', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).then(list => Array.isArray(list) && list.find(r => r && !r.draft && typeof r.tag_name === 'string'), () => null);
    lines.push(!newest ? 'Newest release: couldn\'t check'
      : newer(newest.tag_name, VERSION) ? `Newest release: ${newest.tag_name}, newer than this one (see docs/INSTALL.md#updating)`
      : `Newest release: ${newest.tag_name} (this is up to date)`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

const CLEARABLE = { history: 'the played history', activity: 'the Activity log', chat: 'the chat' };
const clearedText = what => {
  const names = what.map(w => CLEARABLE[w]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};
async function clearCommand(words) {
  const state = savedState(), count = v => (Array.isArray(v) ? v.length : 0);
  const asked = words.map(w => (w === 'log' ? 'activity' : w));
  const what = asked.includes('all') ? Object.keys(CLEARABLE) : [...new Set(asked)].filter(w => CLEARABLE[w]);
  if (!what.length || asked.some(w => w !== 'all' && !CLEARABLE[w])) {
    console.log('Usage: node server.js --clear <history | activity | chat | all>   (one or more, like: --clear chat activity)\n\n'
      + `Now: ${count(state.history)} songs in the played history, ${count(state.log)} lines in Activity, ${count(state.chat)} chat messages.`);
    process.exit(1);
  }
  if (process.stdin.isTTY && !(await askYesNo(`Clear ${clearedText(what)}? It can't be undone. [y/N] `))) { console.log('Nothing was changed.'); process.exit(1); }
  await askServer({ clear: what });
  if (what.includes('history')) state.history = [];
  if (what.includes('chat')) state.chat = [];
  if (what.includes('activity')) state.log = [];
  state.log = [...(Array.isArray(state.log) ? state.log : []), { t: Date.now(), by: 'server', text: `cleared ${clearedText(what)} (whoever runs Couchwave did)` }].slice(-200);
  writeAtomic(STATE, JSON.stringify(state));
  console.log(`Done: cleared ${clearedText(what)}.`);
  process.exit(0);
}

if (process.argv.includes('--stop')) {
  askServer({ stop: true }, true).then(reply => {
    console.log(reply ? reply.text : 'Couchwave isn\'t running.');
    process.exit(!reply || reply.ok ? 0 : 1);
  });
  return;
}
if (process.argv.includes('--status')) {
  statusCommand();
  return;
}
if (process.argv.includes('--remove-song')) {
  removeSongCommand(process.argv.slice(process.argv.indexOf('--remove-song') + 1).join(' ').trim());
  return;
}
if (process.argv.includes('--clear')) {
  clearCommand(process.argv.slice(process.argv.indexOf('--clear') + 1).map(w => w.toLowerCase().replace(/^-+/, '')));
  return;
}

// ---------- Log file ----------
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
    if (!fs.existsSync(LOGFILE)) return;
    const size = fs.statSync(LOGFILE).size;
    if (size <= LOG_MAX) return;
    const buf = Buffer.alloc(LOG_KEEP), fd = fs.openSync(LOGFILE, 'r');
    fs.readSync(fd, buf, 0, LOG_KEEP, size - LOG_KEEP);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const old = logStream, held = [];
    logStream = { write: l => held.push(l) };
    old.end(() => {
      try { fs.writeFileSync(LOGFILE, `---- ${stamp()}: older lines trimmed, keeping the newest ----\n` + text.slice(text.indexOf('\n') + 1)); } catch {}
      logStream = fs.createWriteStream(LOGFILE, { flags: 'a' });
      for (const l of held) logStream.write(l);
    });
  } catch (err) { logOut('log trim failed: ' + err.message); }
}
trimLog();
setInterval(trimLog, 60 * 60 * 1000);
process.on('uncaughtException', err => {
  try { fs.appendFileSync(LOGFILE, `${stamp()}  CRASH ${err.stack || err}\n`); } catch {}
  process.exit(1);
});

// ---------- Settings ----------
const CONFIG = path.join(__dirname, 'config.json');
const DEFAULTS = { port: 3000, votePercent: 60, maxVideoHours: 3, downloadAhead: 20, downloadsAtOnce: 3, public: false };
if (!fs.existsSync(CONFIG)) {
  const fresh = { password: crypto.randomBytes(6).toString('base64url'), ...DEFAULTS };
  fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`No config.json yet: made one with the password "${fresh.password}" and port ${fresh.port}. Change them in config.json.`);
}
const fatal = msg => { const l = `${stamp()}  ${msg}\n`; try { fs.appendFileSync(LOGFILE, l); } catch {} process.stderr.write(l); process.exit(1); };
let config;
try { config = require(CONFIG); } catch (err) { fatal('config.json is broken: ' + err.message); }
const PASSWORD = String(config.password || '');
const PUBLIC = config.public === true;
if (!PASSWORD && !PUBLIC) fatal('No password set: put one in config.json');
if (PUBLIC) console.log('config.json: "public" is on: there\'s no room password, so anyone who has the address can join');
else if (PASSWORD.length < 8) console.log(`config.json: the room password is short (${PASSWORD.length} characters), so it's easy to guess. Use 8 or more`);
function setting(key, valid, should) {
  if (config[key] == null) return DEFAULTS[key];
  const v = Number(config[key]);
  if (Number.isFinite(v) && valid(v)) return v;
  console.log(`config.json: ${key} should be ${should}, not ${JSON.stringify(config[key])}; using ${DEFAULTS[key]}`);
  return DEFAULTS[key];
}
const PORT = setting('port', p => Number.isInteger(p) && p >= 1 && p <= 65535, 'a whole number from 1 to 65535');
const VOTE_PERCENT = setting('votePercent', p => p > 0 && p <= 100, 'a number from 1 to 100');
const MAX_HOURS = setting('maxVideoHours', h => h > 0, 'a number of hours above 0 (like 3, or 1.5)');
const whole = n => Number.isInteger(n) && n >= 1;
const PREFETCH = setting('downloadAhead', whole, 'a whole number of songs, 1 or more');
const MAX_DOWNLOADS = setting('downloadsAtOnce', whole, 'a whole number, 1 or more');
const MAX_SECONDS = Math.round(MAX_HOURS * 3600);
const MAX_LENGTH_TEXT = (() => {
  const mins = Math.max(1, Math.round(MAX_HOURS * 60)), h = Math.floor(mins / 60), m = mins % 60;
  return [h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
})();
const tooLong = song => song.duration > MAX_SECONDS;
const BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];
function cookieArgs() {
  const v = config.youtubeCookies;
  if (v == null || v === '' || v === false) return [];
  const text = String(v).trim();
  if (BROWSERS.includes(text.toLowerCase())) return ['--cookies-from-browser', text.toLowerCase()];
  const file = path.resolve(__dirname, text);
  if (fs.existsSync(file)) return ['--cookies', file];
  console.log(`config.json: youtubeCookies should be a cookies file that exists (like "data/youtube-cookies.txt") or a browser (${BROWSERS.join(', ')}), not ${JSON.stringify(v)}; downloading without cookies`);
  return [];
}
const COOKIES = cookieArgs();

// ---------- Visitors' addresses ----------
const subnets = list => { const b = new net.BlockList(); for (const [ip, bits] of list) b.addSubnet(ip, bits, net.isIPv6(ip) ? 'ipv6' : 'ipv4'); return b; };
const PRIVATE = [['127.0.0.0', 8], ['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['169.254.0.0', 16], ['100.64.0.0', 10],
  ['::1', 128], ['fc00::', 7], ['fe80::', 10]];
const CLOUDFLARE = subnets([
  ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22], ['103.31.4.0', 22], ['141.101.64.0', 18], ['108.162.192.0', 18],
  ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22], ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
  ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
  ['2400:cb00::', 32], ['2606:4700::', 32], ['2803:f800::', 32], ['2405:b500::', 32], ['2405:8100::', 32], ['2a06:98c0::', 29], ['2c0f:f248::', 32],
]);
const plainIp = ip => String(ip || '').trim().replace(/^\[([^\]]*)\](:\d+)?$/, '$1').replace(/%.*$/, '')
  .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1').replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
const inside = (list, ip) => net.isIP(ip) > 0 && list.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
function trustedProxies() {
  const v = config.trustProxy;
  if (v == null || v === true) return PRIVATE;
  if (v === false) return [];
  const extra = (Array.isArray(v) ? v : [null]).map(e => {
    const [ip, bits, more] = String(e ?? '').split('/').map((x, i) => (i ? x : plainIp(x)));
    const max = net.isIPv6(ip) ? 128 : 32;
    if (!net.isIP(ip) || more !== undefined || (bits !== undefined && !/^\d+$/.test(bits)) || +(bits ?? max) > max) return null;
    return [ip, +(bits ?? max)];
  });
  if (extra.every(Boolean)) return [...PRIVATE, ...extra];
  console.log(`config.json: trustProxy should be true, false, or a list of addresses like ["203.0.113.5", "10.8.0.0/24"], not ${JSON.stringify(v)}; using true`);
  return PRIVATE;
}
const PROXIES = subnets(trustedProxies());
const viaProxy = req => inside(PROXIES, plainIp(req.socket.remoteAddress));
function visitor(req) {
  let ip = plainIp(req.socket.remoteAddress);
  if (inside(PROXIES, ip)) {
    const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(plainIp).filter(Boolean);
    while (hops.length) { ip = hops.pop(); if (!inside(PROXIES, ip)) break; }
  }
  if (inside(CLOUDFLARE, ip)) { const cf = plainIp(req.headers['cf-connecting-ip']); if (net.isIP(cf)) ip = cf; }
  if (!net.isIPv6(ip) || ip === '::1') return ip.slice(0, 64);
  const [head, tail] = ip.split('::'), a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return groups.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':') + '::/64';
}

// ---------- Logins ----------
let keyCache = { mtime: -1, key: '' };
function loginKey() {
  if (!fs.existsSync(KEYFILE)) newLoginKey();
  const mtime = fs.statSync(KEYFILE).mtimeMs;
  if (mtime !== keyCache.mtime) keyCache = { mtime, key: fs.readFileSync(KEYFILE, 'utf8').trim() };
  return keyCache.key;
}
const same = (a, b) => { a = Buffer.from(String(a ?? '')); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const AUTH_COOKIE = 'auth=%s; Path=/; Max-Age=%d; SameSite=Lax; HttpOnly';
const NAME_COOKIE = 'name=%s; Path=/; Max-Age=31536000; SameSite=Lax';
const viaHttps = req => viaProxy(req) && (
  String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https' ||
  /"scheme"\s*:\s*"https"/.test(String(req.headers['cf-visitor'] || '')));
const cookie = (req, template, value, maxAge = 31536000) =>
  template.replace('%s', value).replace('%d', maxAge) + (viaHttps(req) ? '; Secure' : '');

let accCache = { mtime: -2, list: {}, broken: null };
function accounts() {
  let mtime = -1;
  try { mtime = fs.statSync(ACCOUNTS).mtimeMs; } catch {}
  if (mtime !== accCache.mtime) {
    try { accCache = { mtime, list: readAccounts(), broken: null }; }
    catch (err) {
      if (accCache.broken !== err.message) console.error(`Can't read ${ACCOUNTS}: ${err.message}`);
      accCache.broken = err.message;
    }
  }
  return accCache.list;
}
function addAccount(acc) {
  const list = readAccounts(), key = nameKey(acc.name);
  if (Object.hasOwn(list, key) && isAccount(list[key])) return false;
  list[key] = acc;
  writeAccounts(list);
  let mtime = -1;
  try { mtime = fs.statSync(ACCOUNTS).mtimeMs; } catch {}
  accCache = { mtime, list, broken: null };
  return true;
}
const account = name => { const list = accounts(), key = nameKey(name); return !RESERVED.has(key) && Object.hasOwn(list, key) && isAccount(list[key]) ? list[key] : null; };
const wasDeleted = name => { const list = accounts(), key = nameKey(name); return Object.hasOwn(list, key) && !!list[key].deleted; };
const RESERVED = new Set(['server', 'someone', 'dj', '__proto__', 'constructor', 'prototype']);
const CHECKS_AT_ONCE = 2, CHECKS_WAITING = 50;
let checking = 0;
const waitingChecks = [];
function scramble(password, salt) {
  return new Promise((ok, fail) => {
    const go = () => {
      checking++;
      crypto.scrypt(String(password), salt, 32, (err, key) => {
        checking--;
        if (waitingChecks.length) waitingChecks.shift()();
        if (err) fail(err); else ok(key.toString('hex'));
      });
    };
    if (checking < CHECKS_AT_ONCE) go();
    else if (waitingChecks.length < CHECKS_WAITING) waitingChecks.push(go);
    else fail(Object.assign(new Error('too many logins at once'), { busy: true }));
  });
}

const DAY = 24 * 3600 * 1000, LOGIN_LIFE = 365 * DAY, RENEW_AFTER = DAY, OLD_LOGINS_FOR = 30 * DAY;
const LOGINS = path.join(DATA, 'logins.json');
let logins = { oldLoginsUntil: 0, loggedOut: {} };
function saveLogins() {
  const now = Date.now();
  for (const [id, until] of Object.entries(logins.loggedOut)) if (!(until > now)) delete logins.loggedOut[id];
  try { writeAtomic(LOGINS, JSON.stringify(logins)); } catch (err) { console.error('saving logins failed:', err.message); }
}
try {
  const saved = JSON.parse(fs.readFileSync(LOGINS, 'utf8'));
  logins = { oldLoginsUntil: Number(saved.oldLoginsUntil) || 0, loggedOut: saved.loggedOut && typeof saved.loggedOut === 'object' ? saved.loggedOut : {} };
} catch (err) {
  if (err.code !== 'ENOENT') { console.error(`Can't read ${LOGINS} (${err.message}): everyone has to log in again`); newLoginKey(); }
  logins.oldLoginsUntil = Date.now() + OLD_LOGINS_FOR;
  saveLogins();
}
const signed = (acc, extra) => crypto.createHmac('sha256', loginKey()).update(`${PASSWORD}\n${nameKey(acc.name)}\n${acc.salt}${extra}`).digest('base64url');
function newLogin(acc, id = crypto.randomBytes(16).toString('base64url')) {
  const made = Date.now().toString(36);
  return [Buffer.from(acc.name).toString('base64url'), id, made, signed(acc, `\n${id}\n${made}`)].join('.');
}
function loggedIn(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 && parts.length !== 4) return null;
  const acc = account(Buffer.from(parts[0], 'base64url').toString());
  if (!acc) return null;
  if (parts.length === 2) return Date.now() < logins.oldLoginsUntil && same(parts[1], signed(acc, '')) ? { acc, old: true } : null;
  const [, id, made, mac] = parts;
  if (!same(mac, signed(acc, `\n${id}\n${made}`)) || !(Date.now() - parseInt(made, 36) < LOGIN_LIFE) || Object.hasOwn(logins.loggedOut, id)) return null;
  return { acc, id, made: parseInt(made, 36), token };
}
const renewed = login => (login.old ? newLogin(login.acc) : Date.now() - login.made > RENEW_AFTER ? newLogin(login.acc, login.id) : null);
function endLogin(login) {
  if (!login.id) return;
  logins.loggedOut[login.id] = Date.now() + LOGIN_LIFE;
  saveLogins();
}

const fails = new Map(), nameFails = new Map(), newNames = new Map();
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 20, NEW_NAMES_WINDOW = 60 * 60 * 1000, NEW_NAMES_MAX = 10;
const windowOf = map => (map === newNames ? NEW_NAMES_WINDOW : FAIL_WINDOW);
function strikes(map, key) {
  let f = map.get(key);
  if (!f || Date.now() - f.since > windowOf(map)) { f = { n: 0, since: Date.now() }; map.set(key, f); }
  return f;
}
function tellOnce(f, text) { if (!f.told) { f.told = true; logOut(text); } }
setInterval(() => { for (const map of [fails, nameFails, newNames]) for (const [k, f] of map) if (Date.now() - f.since > windowOf(map)) map.delete(k); }, 60 * 1000);

// ---------- Speed limits ----------
const LIMITS = { chat: [8, secs(10)], add: [10, secs(60)], control: [30, secs(60)], react: [60, secs(10)] };
const LIMITED = { 'POST /pause': 'control', 'POST /play': 'control', 'POST /seek': 'control', 'POST /react': 'react' };
const recent = new Map();
function tooFast(kind, who) {
  const [max, windowMs] = LIMITS[kind], key = `${kind}\n${who}`, now = Date.now();
  const times = (recent.get(key) || []).filter(t => now - t < windowMs);
  const over = times.length >= max;
  if (!over) times.push(now);
  recent.set(key, times);
  return over;
}
const COOLDOWN_FIRST = secs(30), COOLDOWN_LONGEST = secs(300), COOLDOWN_FORGIVEN = secs(600);
const cooldowns = new Map();
function chatWait(who) {
  const now = Date.now(), last = cooldowns.get(who);
  if (last && now < last.until) return last.until - now;
  if (!tooFast('chat', who)) return 0;
  const length = last && now - last.until < COOLDOWN_FORGIVEN ? Math.min(last.length * 2, COOLDOWN_LONGEST) : COOLDOWN_FIRST;
  cooldowns.set(who, { until: now + length, length });
  recent.delete(`chat\n${who}`);
  return length;
}
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of recent) if (times.every(t => now - t >= LIMITS[key.split('\n')[0]][1])) recent.delete(key);
  for (const [who, c] of cooldowns) if (now - c.until > COOLDOWN_FORGIVEN) cooldowns.delete(who);
}, 60 * 1000);

// ---------- State ----------
let nextId = 1;
let queue = [];
let current = null;
let startedAt = 0;
let paused = false;
let pausedAt = 0;
let log = [];
let chat = [];
let history = [];
const HISTORY_MAX = 100;
let colors = {};
let faces = {};
let wasHere = null;
let savedSkip = null;
let savedRemove = null;
let playlistJobs = [];
let newestTold = '';
let reactions = [];
let reactId = Date.now();
let logRev = Date.now(), chatRev = Date.now(), historyRev = Date.now();
const running = new Map();
const trash = new Map();
const UNDO_MS = secs(600);

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
queue = listOf(saved.queue); current = objectOf(saved.current);
log = listOf(saved.log); chat = listOf(saved.chat); history = listOf(saved.history); playlistJobs = listOf(saved.playlists);
colors = objectOf(saved.colors) || {}; faces = objectOf(saved.faces) || {};
startedAt = Number(saved.startedAt) || 0; paused = saved.paused === true; pausedAt = Number(saved.pausedAt) || 0;
newestTold = typeof saved.newestTold === 'string' ? saved.newestTold : '';
wasHere = objectOf(saved.here); savedSkip = objectOf(saved.skip); savedRemove = objectOf(saved.removeVotes);
for (const e of listOf(saved.trash)) {
  if (objectOf(e.item) && typeof e.t === 'number' && typeof e.by === 'string') trash.set(e.item.id, { item: e.item, index: Number(e.index) || 0, t: e.t, by: e.by });
}
const trashed = () => [...trash.values()].map(e => e.item);
nextId = Math.max(Number.isInteger(saved.nextId) ? saved.nextId : 1, ...[current, ...queue, ...trashed()].filter(Boolean).map(q => (Number(q.id) || 0) + 1));
for (const item of [current, ...queue, ...trashed()]) {
  if (!item) continue;
  for (const k of ['file', 'audio', 'out']) if (item[k]) item[k] = path.join(DL, path.basename(item[k]));
}

// ---------- Saving ----------
let dirty = false, savedAt = 0;
function save() {
  dirty = false;
  savedAt = Date.now();
  try {
    const herePlus = Object.fromEntries([...here].map(n => [n, seen[n] || 0]));
    const skip = current ? { song: current.id, voters: [...skipVotes] } : null;
    const removeVotesSaved = Object.fromEntries([...removeVotes].map(([id, votes]) => [id, [...votes]]));
    writeAtomic(STATE, JSON.stringify({ nextId, queue, current, startedAt, paused, pausedAt, log, chat, history, colors, faces, here: herePlus, skip, removeVotes: removeVotesSaved, playlists: playlistJobs, trash: [...trash.values()], newestTold }));
  } catch (err) {
    dirty = true;
    console.error('save failed:', err.message);
  }
  nudge();
}

// ---------- Instant updates ----------
const listeners = new Set();
const STREAMS_EACH = 10;
let nudgeTimer = null;
function nudge() {
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => { nudgeTimer = null; for (const res of listeners) res.write('data: changed\n\n'); }, 30);
}
setInterval(() => { for (const res of listeners) res.write(': still here\n\n'); }, 25000);

// ---------- Presence ----------
const seen = {};

const here = new Set();
const LEAVE_AFTER = secs(60), CLOSED_AFTER = secs(10);
const ONLINE_FOR = secs(10);
const closed = {};
let quietUntil = Date.now() + secs(15);
function checkIn(who) { seen[who] = Date.now(); arrived(who); }
function arrived(who) {
  if (here.has(who)) return;
  here.add(who);
  dirty = true;
  if (Date.now() > quietUntil) addLog(who, 'joined');
}
function departed(who, t) { delete closed[who]; if (here.delete(who)) { addLog(who, 'left', undefined, t); dirty = true; } }
const gone = (who, now) => now - (seen[who] || 0) > LEAVE_AFTER || (closed[who] > (seen[who] || 0) && now - closed[who] > CLOSED_AFTER);
function streamsSeen() {
  const now = Date.now();
  for (const res of listeners) {
    if (loggedIn(res.auth)?.acc.name !== res.who) { listeners.delete(res); res.end(); continue; }
    seen[res.who] = now;
  }
}
setInterval(() => {
  streamsSeen();
  const now = Date.now();
  for (const who of here) if (gone(who, now)) departed(who);
  if (here.size && now - savedAt > secs(30)) dirty = true;
}, secs(5));
const online = () => { const now = Date.now(); return Object.keys(seen).filter(n => now - seen[n] < ONLINE_FOR); };

if (wasHere && typeof wasHere === 'object') {
  quietUntil = 0;
  const now = Date.now();
  for (const [who, t] of Object.entries(wasHere)) {
    if (typeof t !== 'number' || who === '__proto__' || who === 'constructor' || who === 'prototype') continue;
    here.add(who);
    seen[who] = Math.min(t, now);
    if (now - seen[who] > LEAVE_AFTER) departed(who, seen[who]);
  }
}

// ---------- Activity log ----------
const fmt = t => Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');

function addChat(by, text) {
  chat.push({ t: Date.now(), by, text });
  if (chat.length > 200) chat.shift();
  chatRev++;
}

function addLog(by, text, id, t = Date.now()) {
  let i = log.length;
  while (i > 0 && log[i - 1].t > t) i--;
  const entry = { t, by, text, id };
  log.splice(i, 0, entry);
  if (log.length > 200) log.shift();
  logRev++;
  return entry;
}

function logLook(who, text) {
  const last = log[log.length - 1], kind = text.split(' ').slice(0, 3).join(' ');
  if (last && last.by === who && last.text.startsWith(kind) && Date.now() - last.t < 60000) { last.t = Date.now(); last.text = text; logRev++; }
  else addLog(who, text);
}

// ---------- Queue ----------
const PLAYLIST_MAX = 100;
let dj = null;
const DJ_NAME = 'DJ';
const isDjSong = item => !!item && item.by === DJ_NAME;

function fairIndex(who) {
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

function addSong(url, title, who) {
  const item = { id: nextId++, url, title, by: who, status: 'waiting' };
  queue.splice(fairIndex(who), 0, item);
  return item;
}

const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;
const alreadyHere = id => !!id && [current, ...queue].find(q => q && videoId(q.url) === id);
const songName = item => (/^https?:\/\//.test(item.title) ? 'That song' : `"${item.title}"`);
const alreadyText = item => (item === current ? 'is playing right now' : 'is already in the queue');

function listSongs(target, max, cb) {
  const p = run('yt-dlp', [
    '--encoding', 'utf-8',
    '--flat-playlist', '--yes-playlist', '--playlist-end', String(max),
    '--print', '%(id)s\t%(duration)s\t%(title)s\t%(playlist_title)s', ...COOKIES, '--', target,
  ], secs(120), `yt-dlp reading ${target}`);
  let stdout = '', finished = false;
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => logOut(d));
  const finish = () => {
    if (finished) return;
    finished = true;
    const songs = [];
    for (const line of stdout.split('\n')) {
      const [id, duration, title, playlist] = line.trim().split('\t');
      if (!/^[\w-]{11}$/.test(id || '') || /^\[(Private|Deleted|Unavailable) video\]$/.test(title)) continue;
      songs.push({ id, duration: parseFloat(duration) || 0, title: title || id, playlist: playlist && playlist !== 'NA' ? playlist : '' });
    }
    cb(songs);
  };
  p.on('error', finish);
  p.on('close', finish);
}

function addPlaylist(link, who) {
  const job = { id: `playlist-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`, link, who };
  playlistJobs.push(job);
  addLog(who, 'is adding a playlist…', job.id);
  readPlaylist(job);
}

function readPlaylist(job) {
  const { link, who } = job;
  listSongs(link, PLAYLIST_MAX, all => {
    playlistJobs = playlistJobs.filter(j => j !== job);
    const entry = log.find(e => e.id === job.id);
    const songs = all.filter(s => !tooLong(s)), skipped = all.length - songs.length;
    let n = 0, twice = 0;
    for (const s of songs) {
      if (alreadyHere(s.id)) { twice++; continue; }
      addSong(watchUrl(s.id), s.title, who);
      n++;
    }
    const name = all.length && all[0].playlist;
    const out = [skipped && `${skipped} longer than ${MAX_LENGTH_TEXT}`, twice && `${twice} already in the queue`].filter(Boolean);
    const left = out.length ? `, ${out.join(' and ')} left out` : '';
    if (entry) entry.text = all.length ? `added playlist${name ? ` "${name}"` : ''} (${n} song${n === 1 ? '' : 's'}${left})` : `couldn't read the playlist ${link}`;
    logRev++;
    dirty = true;
    pump();
  });
}

function addSearch(query, who) {
  const item = addSong(null, `Searching for "${query}"…`, who);
  Object.assign(item, { status: 'searching', query });
  addLog(who, `is searching for "${query}"…`, item.id);
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
  listSongs(`ytsearch3:${item.query}`, 3, songs => {
    const s = bestMatch(item.query, songs);
    const entry = log.find(e => e.id === item.id && /^is searching/.test(e.text));
    const twin = s && alreadyHere(s.id);
    if (s && !twin) {
      Object.assign(item, { url: watchUrl(s.id), title: s.title, status: 'waiting' });
      if (entry) entry.text = `added "${s.title}"`;
    } else {
      const i = queue.indexOf(item);
      if (i >= 0) queue.splice(i, 1);
      trash.delete(item.id);
      if (entry) entry.text = twin ? `searched for "${item.query}": "${s.title}" ${alreadyText(twin)}`
        : songs.some(tooLong) ? `couldn't find anything shorter than ${MAX_LENGTH_TEXT} for "${item.query}"`
        : `couldn't find anything for "${item.query}"`;
    }
    delete item.query;
    logRev++;
    dirty = true;
    pump();
  });
}

// ---------- Downloads ----------
function cleanup() {
  const keep = [current, ...queue, ...trashed()].filter(Boolean)
    .map(q => (q.status === 'downloading' ? q.out : q.file))
    .filter(Boolean).map(f => path.basename(f, '.mp4'));
  for (const f of fs.readdirSync(DL)) {
    if (!keep.some(k => f.startsWith(k))) fs.rm(path.join(DL, f), { force: true }, () => {});
  }
}

const MIN_FREE = 2 * 1024 ** 3;
let diskFull = false;
function freeSpace() {
  if (process.env.COUCHWAVE_FAKE_FREE_DISK) return Number(process.env.COUCHWAVE_FAKE_FREE_DISK);
  try { const s = fs.statfsSync(DL); return s.bavail * s.bsize; } catch { return Infinity; }
}
function roomOnDisk() {
  const full = freeSpace() < MIN_FREE;
  if (full !== diskFull) {
    diskFull = full;
    const text = full ? 'paused downloads: this computer has less than 2 GB of disk space left' : 'downloads are back on: there is enough disk space again';
    addLog('server', text);
    logOut(text);
    dirty = true;
  }
  return !full;
}

function pump() {
  if (!roomOnDisk()) return;
  for (const [i, q] of queue.slice(0, PREFETCH).entries()) {
    if (q.status !== 'waiting') continue;
    if (running.size >= MAX_DOWNLOADS) {
      const lowest = [...running.keys()].map(id => queue.find(x => x.id === id)).filter(Boolean)
        .sort((a, b) => queue.indexOf(b) - queue.indexOf(a))[0];
      if (!lowest || queue.indexOf(lowest) < i) break;
      stopDownload(lowest);
    }
    download(q);
  }
}

function killTree(proc) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F']).on('error', () => proc.kill());
  else proc.kill();
}

function stopDownload(item) {
  const proc = running.get(item.id);
  if (proc) killTree(proc);
  running.delete(item.id);
  item.out = null;
  item.status = 'waiting';
  dirty = true;
}

function failReason(err) {
  const msg = ((err.match(/ERROR: .*/g) || []).pop() || '').replace(/^ERROR: (\[\w+\] [\w-]+: )?/, '');
  if (/confirm your age|age.restricted|inappropriate/i.test(msg)) return ['Age-restricted', true];
  if (/private video/i.test(msg)) return ['Private video', true];
  if (/unavailable|has been removed|not available|does not exist|terminated/i.test(msg)) return ['Unavailable', true];
  if (/members.only|join this channel/i.test(msg)) return ['Members only', true];
  if (/HTTP Error 403/i.test(msg)) return ['Blocked by YouTube (403)', false];
  if (/HTTP Error 429|too many requests/i.test(msg)) return ['YouTube rate limit', false];
  if (/not a bot|please sign in|protect our community/i.test(msg)) return ['YouTube bot check', false];
  return [msg.slice(0, 80) || 'Download error', false];
}

function failed(item, reason, permanent) {
  item.status = 'failed';
  item.error = reason;
  item.tries = (item.tries || 0) + 1;
  const patient = /bot check|rate limit/.test(reason);
  if (!permanent && item.tries <= 2) { item.retryAt = Date.now() + (patient ? secs(item.tries === 1 ? 60 : 300) : 10000 * item.tries); return; }
  item.retryAt = null;
  if (isDjSong(item) && queue.includes(item)) return removeFromQueue(item, DJ_NAME, `dropped "${item.title}": it couldn't be downloaded (${reason})`);
  addLog(item.by, `couldn't download "${item.title}" (${reason})`);
}

function probeDuration(file, cb) {
  const p = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], TOOL_LIMIT);
  let out = '', fin = false;
  const end = () => { if (fin) return; fin = true; cb(parseFloat(out) || 0); };
  p.stdout.on('data', d => (out += d));
  p.on('error', end);
  p.on('close', end);
}

const TARGET_LUFS = -14;
const MEASURE = ['-map', '0:a:0', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'];
function gainFrom(ffmpegOutput) {
  const lufs = parseFloat((/I:\s+(-?[\d.]+) LUFS/.exec(ffmpegOutput) || [])[1]);
  return Number.isFinite(lufs) ? Math.max(0.1, Math.min(1, Math.round(10 ** ((TARGET_LUFS - lufs) / 20) * 1000) / 1000)) : 1;
}
function measureLoudness(item) {
  const file = item.audio || item.file;
  if (!file || item.gain != null) return;
  const p = run('ffmpeg', ['-hide_banner', '-nostats', '-i', file, ...MEASURE], TOOL_LIMIT);
  let err = '', fin = false;
  p.stderr.on('data', d => (err = (err + d).slice(-8000)));
  const end = () => { if (fin) return; fin = true; item.gain = gainFrom(err); dirty = true; };
  p.on('error', end);
  p.on('close', end);
}

const STALL_AFTER = secs(300);
function download(item) {
  const out = path.join(DL, `${item.id}-${Date.now()}.mp4`);
  item.out = out;
  item.status = 'downloading';
  dirty = true;
  const p = run('yt-dlp', [
    '--encoding', 'utf-8',
    '--no-playlist', '--playlist-items', '1',
    '--no-progress', '--match-filter', '!is_live',
    '--break-match-filters', `duration <=? ${MAX_SECONDS}`,
    '-S', 'res:720,vcodec:h264,acodec:m4a', '--merge-output-format', 'mp4',
    '-o', out, '--print', 'after_move:%(duration)s|%(title)s', ...COOKIES, '--', item.url,
  ]);
  running.set(item.id, p);
  const prefix = path.basename(out, '.mp4');
  let stdout = '', stderr = '', done = false, size = -1, grewAt = Date.now(), stalled = false;
  const watch = setInterval(() => {
    let now = 0;
    try { for (const f of fs.readdirSync(DL)) if (f.startsWith(prefix)) now += fs.statSync(path.join(DL, f)).size; } catch {}
    if (now !== size) { size = now; grewAt = Date.now(); return; }
    if (Date.now() - grewAt < STALL_AFTER) return;
    stalled = true;
    clearInterval(watch);
    logOut(`downloading ${item.url} stalled (nothing new for ${Math.round(STALL_AFTER / secs(60))} minutes): stopped`);
    killTree(p);
  }, secs(15));
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => (stdout += d));
  p.stderr.on('data', d => { logOut(d); stderr = (stderr + d).slice(-4000); });
  const finish = code => {
    clearInterval(watch);
    if (done) return;
    done = true;
    if (item.removed || item.out !== out) return pump();
    running.delete(item.id);
    dirty = true;
    const line = stdout.trim().split('\n').pop() || '';
    const i = line.indexOf('|');
    if (code !== 0 || i < 0) {
      if (stalled) failed(item, 'Download stalled', false);
      else if (code === 0) failed(item, "Livestreams aren't supported", true);
      else if (code === 101) failed(item, `Longer than ${MAX_LENGTH_TEXT}`, true);
      else failed(item, ...failReason(stderr));
      return pump();
    }
    item.error = null; item.tries = 0;
    item.duration = parseFloat(line.slice(0, i)) || 0;
    item.title = line.slice(i + 1);
    const entry = log.find(e => e.id === item.id);
    if (entry) { entry.text = `added "${item.title}"`; logRev++; }
    item.file = out;
    const audio = out.replace(/\.mp4$/, '.m4a');
    const ffmpeg = (args, done) => {
      const f = run('ffmpeg', args, TOOL_LIMIT);
      let err = '', fin = false;
      f.stderr.on('data', d => (err = (err + d).slice(-8000)));
      const end = code => { if (fin) return; fin = true; if (code !== 0) logOut(err); done(code === 0, err, f.timedOut); };
      f.on('error', () => end(-1));
      f.on('close', end);
    };
    let fDone = false;
    const ready = ok => {
      if (fDone) return;
      fDone = true;
      if (item.out !== out) return;
      if (ok) item.audio = audio;
      const isReady = () => {
        if (item.out !== out) return;
        if (!item.duration) { failed(item, "Couldn't read the video length", true); return pump(); }
        if (tooLong(item)) {
          fs.rm(out, () => {}); if (item.audio) fs.rm(item.audio, () => {});
          delete item.file; delete item.audio;
          failed(item, `Longer than ${MAX_LENGTH_TEXT}`, true); return pump();
        }
        item.status = 'ready';
        dirty = true;
        measureLoudness(item);
        pump();
      };
      if (item.duration) isReady();
      else probeDuration(out, d => { item.duration = d; isReady(); });
    };
    ffmpeg(['-y', '-hide_banner', '-nostats', '-i', out, '-map', '0:a:0', '-c:a', 'copy', audio, ...MEASURE], (ok, err, timedOut) => {
      if (ok) { item.gain = gainFrom(err); return ready(true); }
      if (timedOut) { item.gain = 1; return ready(false); }
      ffmpeg(['-y', '-loglevel', 'error', '-i', out, '-vn', '-c:a', 'copy', audio], ready);
    });
    pump();
  };
  p.on('error', () => finish(-1));
  p.on('close', finish);
}

// ---------- Vote to skip ----------
const skipVotes = new Set();
if (savedSkip && current && savedSkip.song === current.id && Array.isArray(savedSkip.voters)) {
  for (const n of savedSkip.voters) if (typeof n === 'string') skipVotes.add(n);
}
const votesNeeded = people => Math.max(1, Math.ceil(people * VOTE_PERCENT / 100 - 1e-9));
function checkSkip() {
  if (!current) return;
  const people = online(), voters = people.filter(n => skipVotes.has(n));
  if (!voters.length || voters.length < votesNeeded(people.length)) return;
  if (people.length === 1) addLog(voters[0], `skipped "${current.title}"`);
  else addLog('', `"${current.title}" was skipped (${voters.length} of ${people.length} voted)`);
  advance();
}

// ---------- Vote to remove ----------
const removeVotes = new Map();
if (savedRemove && typeof savedRemove === 'object') {
  for (const [id, names] of Object.entries(savedRemove)) {
    if (Array.isArray(names) && queue.some(q => q.id === +id)) removeVotes.set(+id, new Set(names.filter(n => typeof n === 'string')));
  }
}
function removeFromQueue(item, who, text, undoable) {
  const i = queue.indexOf(item);
  if (i < 0) return;
  queue.splice(i, 1);
  item.removed = true;
  removeVotes.delete(item.id);
  if (running.has(item.id)) stopDownload(item);
  const entry = addLog(who, text);
  if (undoable) { trash.set(item.id, { item, index: i, t: Date.now(), by: who }); entry.undo = item.id; }
  dirty = true;
  pump();
}
function checkRemoves() {
  const people = online();
  for (const [id, votes] of removeVotes) {
    const item = queue.find(q => q.id === id);
    if (!item) { removeVotes.delete(id); continue; }
    const voters = people.filter(n => votes.has(n));
    if (!voters.length || voters.length < votesNeeded(people.length)) continue;
    const last = [...votes].filter(n => voters.includes(n)).pop();
    removeFromQueue(item, last, people.length === 1 ? `removed "${item.title}"` : `removed "${item.title}" (${voters.length} of ${people.length} voted)`);
  }
}

// ---------- Playback ----------
const GRACE = 2;
const elapsed = () => (paused ? pausedAt : (Date.now() - startedAt) / 1000);

const nextUp = () => queue.find(q => q.status === 'ready');

function advance(headStart = 0) {
  if (current) { fs.rm(current.file, () => {}); if (current.audio) fs.rm(current.audio, () => {}); }
  current = null;
  paused = false;
  skipVotes.clear();
  const idx = queue.findIndex(q => q.status === 'ready');
  if (idx >= 0) {
    current = queue.splice(idx, 1)[0];
    for (const n of removeVotes.get(current.id) || []) if (n !== current.by) skipVotes.add(n);
    removeVotes.delete(current.id);
    startedAt = Date.now() - headStart * 1000;
    history.unshift({ url: current.url, title: current.title, by: current.by, t: Date.now() });
    history.length = Math.min(history.length, HISTORY_MAX);
    historyRev++;
  }
  dirty = true;
  pump();
}

setInterval(() => {
  checkSkip();
  checkRemoves();
  if (!current) { if (nextUp()) advance(); }
  else if (!paused && elapsed() > current.duration + GRACE) advance(Math.min(elapsed() - current.duration, GRACE + 1));
  for (const [id, { t }] of trash) if (Date.now() - t > UNDO_MS) { trash.delete(id); logRev++; dirty = true; }
  const due = queue.filter(q => q.status === 'failed' && q.retryAt && Date.now() >= q.retryAt);
  for (const q of due) { q.status = 'waiting'; q.retryAt = null; dirty = true; }
  if (due.length) pump();
  handleRequests();
  if (dirty) save();
}, secs(1));

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
    const reply = request.stop ? stopRequest() : request.status ? statusRequest()
      : Array.isArray(request.clear) ? clearRequest(request.clear) : removeRequest(request.removeSong);
    try { writeAtomic(file.replace(/\.json$/, '.reply'), JSON.stringify(reply)); } catch {}
  }
}

function removeRequest(id) {
  const song = queue.find(q => q.id === id);
  if (!song) return { ok: false, text: "That song isn't in the queue any more (it may have just started playing). Nothing was changed." };
  removeFromQueue(song, 'server', `removed "${song.title}" (whoever runs Couchwave did)`);
  return { ok: true, text: `Done: removed "${song.title}" from the queue.` };
}

function clearRequest(asked) {
  const what = Object.keys(CLEARABLE).filter(w => asked.includes(w));
  if (!what.length) return { ok: false, text: 'Nothing to clear. Nothing was changed.' };
  if (what.includes('history')) { history = []; historyRev++; }
  if (what.includes('chat')) { chat = []; chatRev++; }
  if (what.includes('activity')) { log = []; logRev++; }
  addLog('server', `cleared ${clearedText(what)} (whoever runs Couchwave did)`);
  dirty = true;
  return { ok: true, text: `Done: cleared ${clearedText(what)}.` };
}

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
    save();
    try { fs.writeFileSync(STOP_FILE, 'stopped by node server.js --stop\n'); } catch {}
    for (const p of running.values()) killTree(p);
    logOut('stopped by node server.js --stop');
    if (process.env.WATCH_REPORT_DEPENDENCIES) { try { process.kill(process.ppid); } catch {} }
    setTimeout(() => process.exit(0), 200);
  }, 200);
  return { ok: true, text: 'Done: Couchwave has stopped, and everything is saved. To start it again: start.cmd (or Start-ScheduledTask Couchwave) on Windows, or node server.js.' };
}

function statusRequest() {
  const users = online().sort((a, b) => a.localeCompare(b)), counts = {};
  for (const q of queue) counts[q.status] = (counts[q.status] || 0) + 1;
  const kinds = Object.entries(counts).map(([status, n]) => `${n} ${status}`).join(', ');
  const at = current ? `${fmt(Math.min(elapsed(), current.duration || 0))} of ${fmt(current.duration || 0)}${paused ? ', paused' : ''}` : '';
  return { ok: true, text: [
    `Couchwave v${VERSION} is running on port ${PORT}.`,
    `Online now: ${users.join(', ') || 'nobody'}`,
    `Playing: ${current ? `"${current.title}" (added by ${current.by}), ${at}` : 'nothing'}`,
    `Queue: ${queue.length} song${queue.length === 1 ? '' : 's'}${kinds ? ` (${kinds})` : ''}${diskFull ? '. Downloads are paused: the disk is nearly full' : ''}`,
    `The DJ is ${dj && dj.isOn() ? 'on' : 'off'}.`,
  ].join('\n') };
}

// ---------- Startup ----------
for (const job of playlistJobs) readPlaylist(job);
for (const e of log) {
  if (e.text === 'is adding a playlist…' && !playlistJobs.some(j => j.id === e.id)) { e.text = 'didn\'t finish adding a playlist (Couchwave restarted): add it again'; logRev++; }
}
for (const q of [...queue, ...trashed()]) {
  if (q.status === 'downloading') q.status = 'waiting';
  if (q.status === 'searching' && q.query) search(q);
}
for (const q of [current, ...queue]) if (q && q.status === 'ready') measureLoudness(q);
pump();
cleanup();
setInterval(() => { cleanup(); pump(); }, 60 * 1000);

// ---------- The DJ ----------
dj = require('./dj')({
  dataDir: DATA,
  writeAtomic,
  faces,
  queue: () => queue,
  current: () => current,
  history: () => history,
  mix: id => new Promise(ok => listSongs(`https://www.youtube.com/watch?v=${id}&list=RD${id}`, 30, ok)),
  addSong: (url, title, by, logText) => { addSong(url, title, by); addLog(by, logText); pump(); dirty = true; },
  log: (who, text) => { addLog(who, text); dirty = true; },
  say: (by, text) => { addChat(by, text); dirty = true; },
});

// ---------- Checking the tools ----------
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
    addLog('server', text);
    dirty = true;
  };
  p.on('error', () => end(-1));
  p.on('close', end);
}
{
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18 || (major === 18 && minor < 11)) {
    const text = `Couchwave needs Node.js 18.11 or newer, and this is ${process.versions.node}: some things won't work. Install a newer Node.js (see docs/INSTALL.md)`;
    logOut(text);
    addLog('server', text);
  }
}

// ---------- Keeping yt-dlp up to date ----------
let toldCantUpdate = false;
function updateYtdlp() {
  if (running.size) return setTimeout(updateYtdlp, secs(300));
  const p = run('yt-dlp', ['-U'], secs(300));
  let out = '', fin = false;
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const end = () => {
    if (fin) return;
    fin = true;
    const updated = /Updated yt-dlp to:?\s*(?:\S*@)?([\d.]+)/i.exec(out);
    if (updated) { addLog('server', `updated yt-dlp to ${updated[1]}`); dirty = true; }
    logOut('yt-dlp update check: ' + (out.trim().split('\n').pop() || 'no output'));
    if (!updated && !toldCantUpdate && /installed yt-dlp .*use that to update/i.test(out)) {
      toldCantUpdate = true;
      const how = /pip|pypi/i.test(out) ? 'with pip' : 'with a package manager';
      const text = `yt-dlp can't update itself here (it was installed ${how}), so it will go out of date and YouTube downloads will start failing. Update it the same way it was installed, or install it as in docs/INSTALL.md`;
      logOut(text);
      addLog('server', text);
      dirty = true;
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
      const newest = Array.isArray(list) && list.find(r => r && !r.draft && typeof r.tag_name === 'string');
      if (!newest || !newer(newest.tag_name, VERSION) || newestTold === newest.tag_name) return;
      newestTold = newest.tag_name;
      dirty = true;
      const text = `a newer Couchwave is out: ${newest.tag_name.slice(0, 40)} (this is v${VERSION}). Whoever runs it can update: see docs/INSTALL.md#updating`;
      logOut(text);
      addLog('server', text);
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
      save();
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

// ---------- What pages see ----------
const pub = i => i && { id: i.id, url: i.url, title: i.title, by: i.by, duration: i.duration, gain: i.gain ?? 1 };

function state(q) {
  const now = Date.now();
  for (const n in seen) if (now - seen[n] > 3600000) delete seen[n];
  const users = online().sort((a, b) => a.localeCompare(b));
  const s = {
    current: pub(current),
    elapsed: current ? elapsed() : 0,
    paused,
    next: pub(nextUp()),
    queue: queue.map(({ id, url, title, by, status, error, retryAt }) => ({ id, url, title, by, status, error, retrying: !!retryAt, held: diskFull && status === 'waiting',
      removeVoters: removeVotes.has(id) ? users.filter(n => removeVotes.get(id).has(n)) : [] })),
    colors, faces,
    reactions: reactions.filter(r => now - r.t < secs(6)),
    users,
    skip: { voters: users.filter(n => skipVotes.has(n)), need: votesNeeded(users.length) },
    dj: !!(dj && dj.isOn()),
    logRev, chatRev, historyRev,
  };
  if (q.get('log') !== String(logRev)) s.log = log.map(({ t, by, text, undo }) => ({ t, by, text, undo: trash.has(undo) ? undo : undefined }));
  if (q.get('chat') !== String(chatRev)) s.chat = chat;
  if (q.get('history') !== String(historyRev)) s.history = history;
  return s;
}

// ---------- Sending files ----------
const PACE_BURST = 20, PACE_SPEEDUP = 3, PACE_MIN = 256 * 1024;

async function paced(stream, res, rate, burst) {
  let credit = burst, last = Date.now();
  res.on('close', () => stream.destroy());
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

function sendFile(req, res, file, type, duration) {
  if (!file) { res.writeHead(404); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err) { res.writeHead(404); return res.end(); }
    const size = st.size;
    const bitrate = duration > 0 ? size / duration : 0;
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
    if (!m[1]) { start = Math.max(0, size - +m[2]); end = size - 1; }
    else { start = +m[1]; end = m[2] ? Math.min(+m[2], size - 1) : size - 1; }
    if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    res.writeHead(206, {
      'Content-Type': type, 'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
    });
    send({ start, end });
  });
}

const STATIC_TYPES = {
  '.html': ['text/html; charset=utf-8', 'no-cache'], '.css': ['text/css; charset=utf-8', 'no-cache'],
  '.js': ['text/javascript; charset=utf-8', 'no-cache'],
  '.png': ['image/png', 'max-age=86400'], '.woff2': ['font/woff2', 'max-age=2592000'],
};
const packed = new Map();
const encodingFor = req => { const a = String(req.headers['accept-encoding'] || ''); return /\bbr\b/.test(a) ? 'br' : /\bgzip\b/.test(a) ? 'gzip' : null; };
function sendStatic(req, res, name, headers = {}) {
  const [type, cache] = STATIC_TYPES[path.extname(name)];
  const file = path.join(WEB, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const base = { 'Content-Type': type, 'Cache-Control': cache, ETag: etag, Vary: 'Accept-Encoding', ...headers };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); return res.end(); }
    if (!type.startsWith('text/')) {
      res.writeHead(200, { ...base, 'Content-Length': st.size });
      return fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
    }
    const send = p => {
      const enc = encodingFor(req), body = enc ? p[enc] : p.raw;
      res.writeHead(200, { ...base, 'Content-Length': body.length, ...(enc ? { 'Content-Encoding': enc } : {}) });
      res.end(body);
    };
    const p = packed.get(name);
    if (p && p.etag === etag) return send(p);
    fs.readFile(file, (err, raw) => {
      if (err) { res.writeHead(404); return res.end(); }
      const fresh = { etag, raw, gzip: zlib.gzipSync(raw, { level: 9 }), br: zlib.brotliCompressSync(raw) };
      packed.set(name, fresh);
      send(fresh);
    });
  });
}

const MANIFEST = JSON.stringify({
  name: 'Couchwave', short_name: 'Couchwave', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0c0c11', theme_color: '#0c0c11',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

// ---------- Security headers ----------
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'", "img-src 'self' data: https://i.ytimg.com", "media-src 'self' blob:",
  "connect-src 'self'", "font-src 'self'", "manifest-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
};

// ---------- Requests ----------
function sendJson(req, res, obj) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding' };
  let body = Buffer.from(JSON.stringify(obj));
  if (body.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  res.writeHead(200, { ...headers, 'Content-Length': body.length });
  res.end(body);
}

function done(res) { save(); res.writeHead(204); res.end(); }

function readJson(req, max, cb) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', d => { body += d; if (body.length > max) req.destroy(); });
  req.on('end', () => {
    let data;
    try { data = JSON.parse(body); } catch {}
    try { cb(data && typeof data === 'object' && !Array.isArray(data) ? data : {}); } catch (err) { req.failed(err); }
  });
}

function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map(c => {
    const i = c.indexOf('=');
    try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return ['', '']; }
  }));
}

// ---------- Plain http from the internet ----------
const PRIVATE_NETS = subnets(PRIVATE);
let warnedPlainAt = 0;
function plainFromInternet(req) {
  const peer = plainIp(req.socket.remoteAddress);
  if (!net.isIP(peer) || inside(PRIVATE_NETS, peer) || inside(PROXIES, peer) || inside(CLOUDFLARE, peer)) return;
  if (Date.now() - warnedPlainAt < 24 * 3600 * 1000) return;
  warnedPlainAt = Date.now();
  logOut(`someone (${peer}) reached Couchwave straight from the internet over plain http, so passwords and logins travel unencrypted. Put it behind Cloudflare Tunnel or Caddy for https: see docs/INSTALL.md#letting-friends-in`);
}

// ---------- Routes ----------
http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  req.on('error', () => {});
  req.failed = err => {
    console.error(`${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  };
  try { route(req, res, url); } catch (err) { req.failed(err); }
}).on('error', err => fatal(err.code === 'EADDRINUSE'
  ? `Can't start: port ${PORT} is already in use. Is Couchwave already running? Close it, or set another "port" in config.json`
  : `Can't start: ${err.message}`)).listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));

function route(req, res, url) {
  const route = req.method + ' ' + url.pathname;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (viaHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  plainFromInternet(req);
  if (req.method === 'POST' && /^(cross-site|same-site)$/.test(String(req.headers['sec-fetch-site'] || ''))) {
    res.writeHead(403); return res.end('Only Couchwave\'s own page can do that');
  }

  if (route === 'GET /') {
    const login = loggedIn(parseCookies(req.headers.cookie).auth), fresh = login && renewed(login);
    const headers = login && (fresh || viaHttps(req)) ? { 'Set-Cookie': cookie(req, AUTH_COOKIE, fresh || login.token) } : {};
    return sendStatic(req, res, 'index.html', headers);
  }

  if (route === 'GET /room') return sendJson(req, res, { public: PUBLIC });

  if (route === 'GET /manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(MANIFEST);
  }
  const asset = /^\/((?:css\/[\w-]+\.css)|(?:js\/[\w-]+\.js)|(?:icons\/[\w-]+\.png)|(?:fonts\/[\w-]+\.woff2))$/.exec(url.pathname);
  if (req.method === 'GET' && asset) return sendStatic(req, res, asset[1]);

  if (route === 'POST /login') {
    const ip = visitor(req);
    if (strikes(fails, ip).n >= FAIL_MAX) { res.writeHead(429); return res.end('Too many wrong passwords, try again later'); }
    return readJson(req, 2000, async ({ password, name, own }) => {
      const say = (status, msg) => {
        res.writeHead(status); res.end(msg);
        if (counted && g.n >= FAIL_MAX) tellOnce(g, `logins: ${ip} got a password wrong ${FAIL_MAX} times in 15 minutes, so it waits 15 minutes before trying again`);
        if (nameStrike && nameStrike.n >= FAIL_MAX) tellOnce(nameStrike, `logins: ${FAIL_MAX} wrong passwords for "${nameStrike.name}" in 15 minutes, so new logins with it wait 15 minutes (devices already logged in carry on)`);
      };
      const g = strikes(fails, ip);
      g.n++;
      let counted = true, nameStrike = null, newStrike = null;
      const newRight = () => { if (newStrike) { newStrike.n = Math.max(0, newStrike.n - 1); newStrike = null; } };
      const right = () => { if (counted) { counted = false; g.n = Math.max(0, g.n - 1); } };
      const nameRight = () => { if (nameStrike) { nameStrike.n = Math.max(0, nameStrike.n - 1); nameStrike = null; } };
      try {
        if (!PUBLIC && !same(password, PASSWORD)) return say(401, 'Wrong room password');
        name = cleanName(name);
        if (!name || RESERVED.has(nameKey(name))) { right(); return say(400, 'Pick a different nickname'); }
        if (mixedAlphabets(name)) { right(); return say(400, 'Use letters from one alphabet in your nickname'); }
        own = String(own || '');
        let acc = account(name);
        if (accCache.broken) { right(); return say(503, 'Logins are paused: the server can\'t read its accounts file. Try again in a moment'); }
        if (acc) {
          const f = strikes(nameFails, nameKey(acc.name));
          if (f.n >= FAIL_MAX) { right(); return say(429, `Too many wrong passwords for "${acc.name}". Try again in a few minutes`); }
          f.n++; f.name = acc.name; nameStrike = f;
          if (!same(await scramble(own, acc.salt), acc.hash)) return say(401, `"${acc.name}" is taken. If it's yours, that's not its password`);
          nameRight();
        } else {
          right();
          if (own.length < MIN_OWN_PASSWORD) return say(400, `Choose a password for your nickname (at least ${MIN_OWN_PASSWORD} characters)`);
          const from = ip === '127.0.0.1' || ip === '::1' ? null : strikes(newNames, ip);
          if (from && from.n >= NEW_NAMES_MAX) {
            tellOnce(from, `logins: ${NEW_NAMES_MAX} new nicknames from ${ip} in the last hour, so it waits before making more`);
            return say(429, 'Lots of new nicknames have been made from here in the last hour. Try again later, or ask whoever runs Couchwave');
          }
          if (from) { from.n++; newStrike = from; }
          if (wasDeleted(name)) {
            for (const list of [colors, faces]) for (const n of Object.keys(list)) if (nameKey(n) === nameKey(name)) delete list[n];
            dirty = true;
          }
          const salt = crypto.randomBytes(16).toString('hex');
          acc = { name, salt, hash: await scramble(own, salt), created: Date.now() };
          let added;
          try { added = addAccount(acc); }
          catch (err) { newRight(); console.error('saving accounts failed:', err.message); return say(503, 'Couldn\'t save your nickname. Try again in a moment'); }
          if (!added) { newRight(); return say(401, `"${name}" was just taken by someone else`); }
        }
        right();
        res.writeHead(204, { 'Set-Cookie': [
          cookie(req, AUTH_COOKIE, newLogin(acc)),
          cookie(req, NAME_COOKIE, encodeURIComponent(acc.name)),
        ] });
        res.end();
      } catch (err) {
        right(); nameRight(); newRight();
        if (err.busy) { if (!res.headersSent) say(503, 'Lots of people are logging in right now. Try again in a moment'); return; }
        console.error('login failed:', err.message);
        if (!res.headersSent) say(500, 'Something went wrong. Try again');
      }
    });
  }
  if (route === 'POST /logout') {
    const login = loggedIn(parseCookies(req.headers.cookie).auth);
    if (login) {
      const who = login.acc.name;
      endLogin(login);
      for (const r of listeners) if (!loggedIn(r.auth)) { listeners.delete(r); r.end(); }
      if (![...listeners].some(r => r.who === who)) { delete seen[who]; departed(who); }
    }
    res.writeHead(204, { 'Set-Cookie': cookie(req, AUTH_COOKIE, '', 0) });
    return res.end();
  }

  const login = loggedIn(parseCookies(req.headers.cookie).auth);
  if (!login) { res.writeHead(401); return res.end('Not logged in'); }
  const fresh = renewed(login);
  if (fresh) res.setHeader('Set-Cookie', cookie(req, AUTH_COOKIE, fresh));
  const who = login.acc.name;
  const limited = LIMITED[route];
  if (limited && tooFast(limited, who)) { res.writeHead(429); return res.end('Slow down a little'); }

  switch (route) {
    case 'GET /state':
      checkIn(who);
      return sendJson(req, res, { ...state(url.searchParams), me: who });

    case 'GET /events':
      if ([...listeners].filter(r => r.who === who).length >= STREAMS_EACH) { res.writeHead(429); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      res.who = who; res.auth = fresh || parseCookies(req.headers.cookie).auth;
      seen[who] = Date.now();
      listeners.add(res);
      req.on('close', () => { if (listeners.delete(res)) seen[who] = Date.now(); });
      return;

    case 'POST /bye':
      if (here.has(who)) closed[who] = Date.now();
      res.writeHead(204); return res.end();

    case 'POST /add':
      return readJson(req, 2000, ({ url: link, playlist }) => {
        link = String(link || '').trim();
        const say = (status, msg) => { res.writeHead(status); res.end(msg); };
        if (!link) return say(400, 'Paste a YouTube link or type a song name');
        const isLink = /^https?:\/\//i.test(link), wholePlaylist = playlist === true && /[?&]list=/.test(link);
        if (isLink && !/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(link)) return say(400, 'Not a YouTube link');
        const id = isLink && !wholePlaylist && videoId(link), twin = alreadyHere(id);
        if (twin) return say(409, `${songName(twin)} ${alreadyText(twin)}`);
        if (tooFast('add', who)) return say(429, 'Slow down a little: you\'ve added a lot of songs. Try again in a minute');
        if (!isLink) { addSearch(link.slice(0, 150), who); return done(res); }
        if (wholePlaylist) { addPlaylist(link, who); return done(res); }
        const item = addSong(id ? watchUrl(id) : link, link, who);
        addLog(who, `added ${link}`, item.id);
        pump();
        done(res);
      });

    case 'POST /skip':
      return readJson(req, 200, ({ id, vote }) => {
        checkIn(who);
        if (current && id === current.id) {
          if (vote !== false && current.by === who) {
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

    case 'POST /seek':
      return readJson(req, 200, ({ t }) => {
        checkIn(who);
        const people = online(), alone = people.length === 1 && people[0] === who;
        const ownerAway = current && !isDjSong(current) && !people.includes(current.by);
        if (current && current.by !== who && !ownerAway && !alone) {
          res.writeHead(403);
          return res.end(isDjSong(current) ? 'The DJ\'s songs can only be moved when you\'re the only one here'
            : `Only ${current.by} can move their song while they're here`);
        }
        if (current) {
          t = Math.max(0, Math.min(Number(t) || 0, current.duration));
          if (paused) pausedAt = t; else startedAt = Date.now() - t * 1000;
          addLog(who, `jumped to ${fmt(t)}`);
        }
        done(res);
      });

    case 'POST /remove':
      return readJson(req, 200, ({ id, vote }) => {
        const item = queue.find(q => q.id === id);
        if (item) {
          checkIn(who);
          if (item.by === who) removeFromQueue(item, who, `removed "${item.title}"`, true);
          else {
            const votes = removeVotes.get(item.id) || new Set();
            if (vote === false) votes.delete(who); else votes.add(who);
            if (votes.size) removeVotes.set(item.id, votes); else removeVotes.delete(item.id);
            checkRemoves();
          }
        }
        done(res);
      });

    case 'POST /undo':
      return readJson(req, 200, ({ id }) => {
        const entry = trash.get(id);
        if (entry && entry.by !== who) { res.writeHead(403); return res.end('Only whoever deleted a song can bring it back'); }
        const twin = entry && alreadyHere(videoId(entry.item.url));
        if (twin) { res.writeHead(409); return res.end(`${songName(twin)} ${alreadyText(twin)}`); }
        if (entry) {
          const { item, index } = entry;
          trash.delete(id);
          item.removed = false;
          if (item.status !== 'failed' && item.status !== 'searching' && !(item.status === 'ready' && item.file && fs.existsSync(item.file))) {
            Object.assign(item, { status: 'waiting', out: null, file: null, audio: null });
          }
          queue.splice(Math.min(index, queue.length), 0, item);
          addLog(who, `restored "${item.title}"`);
          pump();
        }
        done(res);
      });

    case 'POST /retry':
      return readJson(req, 200, ({ id }) => {
        const item = queue.find(q => q.id === id && q.status === 'failed');
        if (item) { Object.assign(item, { status: 'waiting', tries: 0, error: null, retryAt: null }); addLog(who, `retried "${item.title}"`); pump(); }
        done(res);
      });

    case 'POST /chat':
      return readJson(req, 2000, ({ text }) => {
        text = String(text || '').trim().slice(0, 500);
        const wait = text ? chatWait(who) : 0;
        if (wait) {
          const s = Math.ceil(wait / 1000);
          res.writeHead(429, { 'Retry-After': s });
          return res.end(`Slow down: you can chat again in ${s} second${s === 1 ? '' : 's'}`);
        }
        if (text && dj && dj.command(who, text)) return done(res);
        if (text) addChat(who, text);
        done(res);
      });

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

    case 'POST /react':
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

  const media = /^\/(video|audio)\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && media) {
    const id = +media[2];
    const item = current && current.id === id ? current : queue.find(q => q.id === id && q.status === 'ready');
    if (!item) { res.writeHead(404); return res.end(); }
    if (media[1] === 'audio' && item.audio && fs.existsSync(item.audio)) return sendFile(req, res, item.audio, 'audio/mp4', item.duration);
    return sendFile(req, res, item.file, 'video/mp4', item.duration);
  }

  res.writeHead(404); res.end();
}