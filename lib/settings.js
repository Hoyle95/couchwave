// ---------- Settings ----------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ROOT, CONFIG } = require('./common');
const { fatal } = require('./log');

const DEFAULTS = { port: 3000, votePercent: 60, maxVideoHours: 3, downloadAhead: 20, downloadsAtOnce: 3, public: false };
if (!fs.existsSync(CONFIG)) {
  const fresh = { password: crypto.randomBytes(6).toString('base64url'), ...DEFAULTS };
  fs.writeFileSync(CONFIG, JSON.stringify(fresh, null, 2) + '\n');
  console.log(`No config.json yet: made one with the password "${fresh.password}" and port ${fresh.port}. Change them in config.json.`);
}
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
const whole = n => Number.isInteger(n) && n >= 1;
const PORT = setting('port', p => Number.isInteger(p) && p >= 1 && p <= 65535, 'a whole number from 1 to 65535');
const VOTE_PERCENT = setting('votePercent', p => p > 0 && p <= 100, 'a number from 1 to 100');
const MAX_HOURS = setting('maxVideoHours', h => h > 0, 'a number of hours above 0 (like 3, or 1.5)');
const PREFETCH = setting('downloadAhead', whole, 'a whole number of songs, 1 or more');
const MAX_DOWNLOADS = setting('downloadsAtOnce', whole, 'a whole number, 1 or more');
const MAX_SECONDS = Math.round(MAX_HOURS * 3600);
const MAX_LENGTH_TEXT = (() => {
  const mins = Math.max(1, Math.round(MAX_HOURS * 60)), h = Math.floor(mins / 60), m = mins % 60;
  return [h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} minute${m === 1 ? '' : 's'}`].filter(Boolean).join(' ');
})();
const tooLong = song => song.duration > MAX_SECONDS;

// ---------- YouTube cookies ----------
const BROWSERS = ['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'];
function cookieArgs() {
  const v = config.youtubeCookies;
  if (v == null || v === '' || v === false) return [];
  const text = String(v).trim();
  if (BROWSERS.includes(text.toLowerCase())) return ['--cookies-from-browser', text.toLowerCase()];
  const file = path.resolve(ROOT, text);
  if (fs.existsSync(file)) return ['--cookies', file];
  console.log(`config.json: youtubeCookies should be a cookies file that exists (like "data/youtube-cookies.txt") or a browser (${BROWSERS.join(', ')}), not ${JSON.stringify(v)}; downloading without cookies`);
  return [];
}
const COOKIES = cookieArgs();

Object.assign(exports, {
  config, PASSWORD, PUBLIC, PORT, VOTE_PERCENT, PREFETCH, MAX_DOWNLOADS, MAX_SECONDS, MAX_LENGTH_TEXT, tooLong, COOKIES,
});
