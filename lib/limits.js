// ---------- Wrong passwords and new nicknames ----------
const { secs } = require('./common');
const { logOut } = require('./log');

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
const LIMITED = { 'POST /pause': 'control', 'POST /play': 'control', 'POST /seek': 'control', 'POST /like': 'control', 'POST /react': 'react' };
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

Object.assign(exports, { fails, nameFails, newNames, FAIL_MAX, NEW_NAMES_MAX, strikes, tellOnce, LIMITED, tooFast, chatWait });
