// ---------- Login cookies ----------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, writeAtomic } = require('./common');
const { PASSWORD } = require('./settings');
const { nameKey, account, newLoginKey, loginKey } = require('./accounts');
const { viaHttps } = require('./addresses');

const same = (a, b) => { a = Buffer.from(String(a ?? '')); b = Buffer.from(String(b)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const AUTH_COOKIE = 'auth=%s; Path=/; Max-Age=%d; SameSite=Lax; HttpOnly';
const NAME_COOKIE = 'name=%s; Path=/; Max-Age=31536000; SameSite=Lax';
const cookie = (req, template, value, maxAge = 31536000) =>
  template.replace('%s', value).replace('%d', maxAge) + (viaHttps(req) ? '; Secure' : '');
function parseCookies(header) {
  return Object.fromEntries((header || '').split(';').map(c => {
    const i = c.indexOf('=');
    try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return ['', '']; }
  }));
}

// ---------- Logins on each device ----------
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

Object.assign(exports, { same, AUTH_COOKIE, NAME_COOKIE, cookie, parseCookies, newLogin, loggedIn, renewed, endLogin });
