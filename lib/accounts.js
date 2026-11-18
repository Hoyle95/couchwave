// ---------- Accounts ----------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA, writeAtomic } = require('./common');

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
const RESERVED = new Set(['server', 'someone', 'dj', '__proto__', 'constructor', 'prototype']);

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
const accountsBroken = () => !!accCache.broken;
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

// ---------- The login key ----------
const KEYFILE = path.join(DATA, 'login-key');
const newLoginKey = () => fs.writeFileSync(KEYFILE, crypto.randomBytes(32).toString('hex'));
let keyCache = { mtime: -1, key: '' };
function loginKey() {
  if (!fs.existsSync(KEYFILE)) newLoginKey();
  const mtime = fs.statSync(KEYFILE).mtimeMs;
  if (mtime !== keyCache.mtime) keyCache = { mtime, key: fs.readFileSync(KEYFILE, 'utf8').trim() };
  return keyCache.key;
}

// ---------- Checking passwords ----------
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

Object.assign(exports, {
  ACCOUNTS, readAccounts, writeAccounts, cleanName, nameKey, mixedAlphabets, MIN_OWN_PASSWORD, isAccount, RESERVED,
  accountsBroken, addAccount, account, wasDeleted, newLoginKey, loginKey, scramble,
});
