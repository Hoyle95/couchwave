// ---------- Folders and files ----------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DL = path.join(DATA, 'downloads');
const STATE = path.join(DATA, 'state.json');
const REQUESTS = path.join(DATA, 'requests');
const CONFIG = process.env.COUCHWAVE_CONFIG ? path.resolve(process.env.COUCHWAVE_CONFIG) : path.join(ROOT, 'config.json');
fs.mkdirSync(DL, { recursive: true });

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); }
  catch (err) { fs.rm(tmp, { force: true }, () => {}); throw err; }
}
const configFile = () => { try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')) || {}; } catch { return {}; } };
const portOf = config => { const p = Number(config.port); return config.port != null && Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 3000; };
const RUNNING = path.join(DATA, 'server.pid');
function runningPid() {
  let pid;
  try { pid = Number(fs.readFileSync(RUNNING, 'utf8')); } catch { return 0; }
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return 0;
  try { process.kill(pid, 0); return pid; } catch (err) { return err.code === 'EPERM' ? pid : 0; }
}
function markRunning() {
  try { fs.writeFileSync(RUNNING, String(process.pid)); } catch { return; }
  process.on('exit', () => { try { if (fs.readFileSync(RUNNING, 'utf8') === String(process.pid)) fs.rmSync(RUNNING); } catch {} });
}
function savedState() { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; } }

const IN_CONTAINER = fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
const HOW_TO_UPDATE = IN_CONTAINER ? 'pull the new image (docker compose pull, then docker compose up -d)' : 'update with node server.js --update (or update.cmd on Windows)';

// ---------- New versions ----------
const RELEASES = process.env.COUCHWAVE_RELEASES_URL || 'https://api.github.com/repos/Hoyle95/couchwave/releases?per_page=10';
function versionNumbers(tag) { return (/(\d+)\.(\d+)\.(\d+)/.exec(tag || '') || []).slice(1).map(Number); }
function newer(tag, than) {
  const a = versionNumbers(tag), b = versionNumbers(than);
  if (a.length < 3 || b.length < 3) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}
const newestOf = list => (Array.isArray(list) && list.find(r => r && !r.draft && typeof r.tag_name === 'string')) || null;

// ---------- Time ----------
const FAKE_TOOLS = process.env.COUCHWAVE_FAKE_TOOLS;
const TIME_SCALE = Number(process.env.COUCHWAVE_TIME_SCALE) > 0 ? Number(process.env.COUCHWAVE_TIME_SCALE) : 1;
const secs = n => n * 1000 * TIME_SCALE;
const fmt = t => {
  t = Math.floor(t || 0);
  const ss = String(t % 60).padStart(2, '0');
  return t >= 3600 ? `${Math.floor(t / 3600)}:${String(Math.floor(t / 60) % 60).padStart(2, '0')}:${ss}` : `${Math.floor(t / 60)}:${ss}`;
};

// ---------- YouTube links ----------
function videoId(url) {
  return (/^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(url || '') || [])[1];
}
const watchUrl = id => `https://www.youtube.com/watch?v=${id}`;

// ---------- Clearing ----------
const CLEARABLE = { history: 'the played history', activity: 'the Activity log', chat: 'the chat' };
const clearedText = what => {
  const names = what.map(w => CLEARABLE[w]);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
};

Object.assign(exports, {
  ROOT, WEB, DATA, DL, STATE, REQUESTS, CONFIG, IN_CONTAINER, HOW_TO_UPDATE, writeAtomic, configFile, savedState, portOf, runningPid, markRunning,
  VERSION: '', RELEASES, newer, newestOf, FAKE_TOOLS, TIME_SCALE, secs, fmt, videoId, watchUrl, CLEARABLE, clearedText,
});
