// ---------- Logging in, accounts and settings ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');
const { testServers, waitFor, PASSWORD, ownPassword, APP_FILES, ROOT } = require('./helpers');

const start = testServers({ after });
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });
const cookies = r => Object.fromEntries((r.headers['set-cookie'] || []).map(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }));
const asCookie = (auth, name = 'whatever') => `auth=${auth}; name=${encodeURIComponent(name)}`;
const device = async (s, name) => asCookie(cookies(await join(s, { password: PASSWORD, name, own: ownPassword(name) })).auth, name);
const DAY = 24 * 3600 * 1000;
function sign(s, name, extra) {
  const key = fs.readFileSync(path.join(s.dir, 'data', 'login-key'), 'utf8').trim();
  const { salt } = JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'accounts.json'), 'utf8'))[name.toLowerCase()];
  return crypto.createHmac('sha256', key).update(`${PASSWORD}\n${name.toLowerCase()}\n${salt}${extra}`).digest('base64url');
}
const oldLogin = (s, name) => `${Buffer.from(name).toString('base64url')}.${sign(s, name, '')}`;
function loginMadeAt(s, name, t, id = 'test-login') {
  const made = t.toString(36);
  return [Buffer.from(name).toString('base64url'), id, made, sign(s, name, `\n${id}\n${made}`)].join('.');
}

describe('logging in', { concurrency: true }, () => {
test('without the login cookie, nothing works', async () => {
  const s = await start();
  for (const [method, url] of [['GET', '/state'], ['POST', '/chat'], ['POST', '/skip'], ['GET', '/video/1'], ['GET', '/events']]) {
    assert.equal((await s.req(method, url, { cookie: 'name=Alice', body: method === 'POST' ? { text: 'hi' } : undefined })).status, 401, `${method} ${url}`);
  }
  assert.equal((await s.state()).chat.length, 0, 'the chat message was not posted');
});

test('joining: the room password, then a new nickname claims it with its own password', async () => {
  const s = await start();
  assert.equal((await join(s, { password: 'nope', name: 'Alice', own: 'secret1' })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: '' })).status, 400, 'a new nickname needs its own password');
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'abc' })).status, 400, 'at least 4 characters');
  const r = await join(s, { password: PASSWORD, name: '  Alice  ', own: 'secret1' });
  assert.equal(r.status, 204);
  const auth = r.headers['set-cookie'].find(c => c.startsWith('auth='));
  assert.match(auth, /HttpOnly/);
  assert.ok(!auth.includes(PASSWORD) && !auth.includes('secret1'), 'no password in the login cookie');
  assert.equal(cookies(r).name, 'Alice', 'the name cookie (for the page to show), trimmed');
});

test('a taken nickname needs its own password; capitals don\'t matter', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' });
  let r = await join(s, { password: PASSWORD, name: 'Alice', own: 'guess' });
  assert.equal(r.status, 401);
  assert.match(r.text, /taken/);
  assert.equal((await join(s, { password: PASSWORD, name: 'ALICE', own: 'guess' })).status, 401, '"ALICE" is Alice too');
  r = await join(s, { password: PASSWORD, name: 'alice', own: 'secret1' });
  assert.equal(r.status, 204, 'the right password, any capitals');
  assert.equal(cookies(r).name, 'Alice', 'logged in as Alice, spelled as it was claimed');
  const st = (await s.get('/state', { cookie: asCookie(cookies(r).auth, 'alice') })).json;
  assert.deepEqual(st.users, ['Alice']);
});

test('the login cookie decides who you are (the page is told by the server): editing the name cookie or the login cookie gets nowhere', async () => {
  const s = await start();
  const alice = cookies(await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).auth;
  assert.equal((await s.get('/state', { cookie: asCookie(alice, 'Bob') })).json.me, 'Alice', 'the page is told it\'s Alice');
  await s.req('POST', '/chat', { body: { text: 'hi' }, cookie: asCookie(alice, 'Bob') });
  assert.equal((await s.state('Cara')).chat.at(-1).by, 'Alice', 'still Alice');
  await join(s, { password: PASSWORD, name: 'Bob', own: 'bobs-pw' });
  const [, ...rest] = alice.split('.');
  for (const forged of [[Buffer.from('Bob').toString('base64url'), ...rest].join('.'), [Buffer.from('Bob').toString('base64url'), rest.at(-1)].join('.'), 'x' + alice]) {
    assert.equal((await s.get('/state', { cookie: asCookie(forged) })).status, 401, forged);
  }
});

test('nicknames the server uses itself can\'t be taken', async () => {
  const s = await start();
  for (const name of ['server', 'Someone', '__proto__', 'constructor', '   ']) {
    assert.equal((await join(s, { password: PASSWORD, name, own: 'secret1' })).status, 400, JSON.stringify(name));
  }
});

test('own passwords are kept scrambled, never as typed', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'my-secret-pw' });
  const file = fs.readFileSync(path.join(s.dir, 'data', 'accounts.json'), 'utf8');
  assert.ok(!file.includes('my-secret-pw') && !file.includes(PASSWORD));
  const acc = JSON.parse(file).alice;
  assert.equal(acc.name, 'Alice');
  assert.match(acc.hash, /^[0-9a-f]{64}$/);
});

test('over https:// (a tunnel or proxy on this machine says so), cookies are marked Secure; on plain http they aren\'t', async () => {
  const s = await start();
  const secure = r => (r.headers['set-cookie'] || []).map(c => /;\s*Secure\b/i.test(c));
  const body = { password: PASSWORD, name: 'Alice', own: ownPassword('Alice') };
  let r = await join(s, body);
  assert.equal(r.status, 204);
  assert.deepEqual(secure(r), [false, false], 'plain http: not Secure, or nobody could log in');
  const plain = cookies(r).auth;
  for (const headers of [{ 'X-Forwarded-Proto': 'https' }, { 'CF-Visitor': '{"scheme":"https"}' }]) {
    r = await join(s, body, headers);
    assert.deepEqual(secure(r), [true, true], `via ${Object.keys(headers)[0]}: both cookies Secure`);
  }
  r = await join(s, body, { 'X-Forwarded-Proto': 'http' });
  assert.deepEqual(secure(r), [false, false], 'a proxy saying http: not Secure');
  r = await s.req('GET', '/', { cookie: asCookie(plain, 'Alice'), headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(String(r.headers['set-cookie']), new RegExp(`^auth=${plain};.*HttpOnly; Secure$`), 'the same login, now Secure');
  r = await s.req('GET', '/', { cookie: asCookie(plain, 'Alice') });
  assert.equal(r.headers['set-cookie'], undefined, 'over plain http, left alone');
  r = await s.req('GET', '/', { cookie: asCookie('not-a-login', 'Alice'), headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(r.headers['set-cookie'], undefined, 'nothing handed out for a cookie that isn\'t a login');
  r = await s.req('POST', '/logout', { cookie: asCookie(plain, 'Alice'), headers: { 'X-Forwarded-Proto': 'https' } });
  assert.deepEqual(secure(r), [true], 'logging out over https clears the Secure cookie');
});

test('one nickname on several devices at once; logging out ends that device\'s login only, for good', async () => {
  const s = await start();
  const phone = await device(s, 'Alice'), laptop = await device(s, 'Alice');
  assert.notEqual(phone, laptop, 'each device has its own login');
  for (const c of [phone, laptop]) assert.equal((await s.get('/state', { cookie: c })).status, 200, 'both at once');
  await s.state('Bob');
  const r = await s.req('POST', '/logout', { cookie: phone });
  assert.equal(r.status, 204);
  assert.match(r.headers['set-cookie'][0], /auth=;.*Max-Age=0/);
  assert.equal((await s.get('/state', { cookie: phone })).status, 401, 'a copy of the phone\'s login no longer works');
  assert.equal((await s.get('/state', { cookie: laptop })).status, 200, 'the laptop is still logged in');
  assert.equal((await s.get('/state', { as: 'Bob' })).status, 200, 'Bob is still logged in');
  await s.restart();
  assert.equal((await s.get('/state', { cookie: phone })).status, 401, 'still logged out after a restart');
  assert.equal((await s.get('/state', { cookie: laptop })).status, 200);
});

test('a login lasts a year from when it was last used', async () => {
  const s = await start();
  await device(s, 'Alice');
  const r = await s.get('/state', { cookie: asCookie(loginMadeAt(s, 'Alice', Date.now() - 2 * DAY), 'Alice') });
  assert.equal(r.status, 200);
  const renewed = cookies(r).auth;
  assert.equal(renewed.split('.')[1], 'test-login', 'the same login, renewed');
  assert.ok(parseInt(renewed.split('.')[2], 36) > Date.now() - 60000, 'from now');
  assert.match(r.headers['set-cookie'][0], /Max-Age=31536000/);
  assert.equal(cookies(await s.get('/state', { cookie: asCookie(renewed, 'Alice') })).auth, undefined, 'used again soon: nothing to renew');
  assert.equal((await s.get('/state', { cookie: asCookie(loginMadeAt(s, 'Alice', Date.now() - 366 * DAY), 'Alice') })).status, 401, 'unused for over a year');
});

test('logins from before this update keep working for 30 days, switching to the new kind by themselves', async () => {
  const s = await start();
  await device(s, 'Alice');
  const old = oldLogin(s, 'Alice');
  const r = await s.get('/state', { cookie: asCookie(old, 'Alice') });
  assert.equal(r.status, 200, 'still logged in after updating');
  const fresh = cookies(r).auth;
  assert.equal(fresh.split('.').length, 4, 'switched to the new kind');
  assert.equal((await s.get('/state', { cookie: asCookie(fresh, 'Alice') })).status, 200);
  await s.stop();
  const file = path.join(s.dir, 'data', 'logins.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), oldLoginsUntil: Date.now() - 1000 }));
  await s.start();
  assert.equal((await s.get('/state', { cookie: asCookie(old, 'Alice') })).status, 401, 'after 30 days the old kind stops working');
  assert.equal((await s.get('/state', { cookie: asCookie(fresh, 'Alice') })).status, 200, 'the switched one keeps going');
});

test('a broken logins.json: everyone logs in again, rather than logged-out logins coming back', async () => {
  const s = await start({ expectProblems: /logins\.json/ });
  const alice = await device(s, 'Alice');
  await s.stop();
  fs.writeFileSync(path.join(s.dir, 'data', 'logins.json'), '{ broken');
  await s.start();
  assert.equal((await s.get('/state', { cookie: alice })).status, 401);
  await s.logHas(/Can't read .*logins\.json.*everyone has to log in again/);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: ownPassword('Alice') })).status, 204, 'the password still works');
});

test('--logout-everyone: old logins stop working, the passwords still work', async () => {
  const s = await start();
  assert.equal((await s.get('/state')).status, 200);
  execFileSync(process.execPath, ['server.js', '--logout-everyone'], { cwd: s.dir });
  assert.equal((await s.get('/state')).status, 401, 'old cookie refused (while the server keeps running)');
  s.forget();
  assert.equal((await s.get('/state')).status, 200, 'logging in again works');
});

const admin = (s, ...args) => spawnSync(process.execPath, ['server.js', ...args], { cwd: s.dir, encoding: 'utf8' });

test('--delete-account: logged out at once, and whoever takes the nickname next starts fresh', async () => {
  const s = await start();
  const bobsOld = await s.cookie('Bob');
  await s.post('/face', { face: '🐸' }, { as: 'Bob' });
  await s.post('/chat', { text: 'old message' }, { as: 'Bob' });
  let r = admin(s, '--delete-account', 'bob');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"Bob" is deleted/);
  assert.equal((await s.get('/state', { cookie: bobsOld })).status, 401, 'logged out (while the server keeps running)');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: 'new-owner-pw' })).status, 204, 'the nickname is free');
  s.forget('Bob');
  const st = await s.state('Cara');
  assert.equal(st.faces.Bob, undefined, 'the new Bob doesn\'t get the old one\'s picture');
  assert.equal(st.chat.at(-1).text, 'old message', 'chat history stays');
  r = admin(s, '--delete-account', 'nobody');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No account "nobody". Accounts: .*Bob/);
});

test('--delete-account while the server is off works too', async () => {
  const s = await start();
  const caras = await s.cookie('Cara');
  await s.post('/face', { face: '🦊' }, { as: 'Cara' });
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('🦊'), 3000, 'Cara\'s picture to be saved');
  await s.stop();
  assert.equal(admin(s, '--delete-account', 'Cara').status, 0);
  await s.start();
  assert.equal((await s.get('/state', { cookie: caras })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'cara', own: 'someone-new' })).status, 204);
  assert.equal((await s.state('Alice')).faces.Cara, undefined, 'starts fresh');
  assert.equal(admin(s, '--delete-account', 'Zoe').status, 1, 'deleting a deleted (or unknown) account says so');
});

test('--set-password: for a forgotten password. Old logins and password stop working, the account is kept', async () => {
  const s = await start();
  const bobsOld = await s.cookie('Bob');
  await s.post('/face', { face: '🐸' }, { as: 'Bob' });
  assert.equal(admin(s, '--set-password', 'Bob', 'abc').status, 1, 'too short');
  const r = admin(s, '--set-password', 'BOB', 'brand-new-pw');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /"Bob" has a new password/);
  assert.equal((await s.get('/state', { cookie: bobsOld })).status, 401, 'logged out everywhere');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: ownPassword('Bob') })).status, 401, 'the old password doesn\'t work');
  const back = await join(s, { password: PASSWORD, name: 'Bob', own: 'brand-new-pw' });
  assert.equal(back.status, 204, 'the new one does');
  assert.equal((await s.state('Alice')).faces.Bob, '🐸', 'picture kept');
  assert.equal(admin(s, '--set-password', 'nobody', 'whatever').status, 1);
  const asked = spawnSync(process.execPath, ['server.js', '--set-password', 'Bob'], { cwd: s.dir, encoding: 'utf8', input: 'typed-new-pw\n' });
  assert.equal(asked.status, 0, asked.stdout + asked.stderr);
  assert.match(asked.stdout, /^New password for "Bob" \(it won't show as you type\): /, 'without the password, it asks (so it stays out of the command history)');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: 'typed-new-pw' })).status, 204, 'the typed one works');
  const short = spawnSync(process.execPath, ['server.js', '--set-password', 'Bob'], { cwd: s.dir, encoding: 'utf8', input: 'abc\n' });
  assert.equal(short.status, 1);
  assert.match(short.stdout, /too short.*Nothing was changed/);
});

test('look-alike nicknames: invisible characters, other widths and mixed alphabets don\'t make a second "Alice"', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' });
  for (const name of ['Alice​', '​Alice', 'Ａｌｉｃｅ', 'Al­ice']) {
    const r = await join(s, { password: PASSWORD, name, own: 'other-pw' });
    assert.equal(r.status, 401, JSON.stringify(name) + ' is Alice, so it needs her password');
  }
  assert.equal((await join(s, { password: PASSWORD, name: 'Ａｌｉｃｅ', own: 'secret1' })).status, 204, '...and with it, it\'s her');
  const r = await join(s, { password: PASSWORD, name: 'Аlice', own: 'other-pw' });
  assert.equal(r.status, 400, 'a Cyrillic letter among Latin ones');
  assert.equal((await join(s, { password: PASSWORD, name: 'Алиса', own: 'other-pw' })).status, 204, 'one alphabet is fine');
});

test('a long nickname is cut to 30 letters without breaking an emoji in half, so it can still log in', async () => {
  const s = await start();
  for (const [typed, kept] of [['a'.repeat(29) + '🎧🎧', 'a'.repeat(29) + '🎧'], ['Zed\uD83D', 'Zed']]) {
    const r = await join(s, { password: PASSWORD, name: typed, own: 'secret1' });
    assert.equal(r.status, 204, JSON.stringify(typed));
    assert.equal(cookies(r).name, kept);
    assert.equal((await s.get('/state', { cookie: asCookie(cookies(r).auth, kept) })).json.me, kept, 'logged in as it');
  }
});

test('two people claiming the same new nickname at once: only one gets it', async () => {
  const s = await start();
  const [a, b] = await Promise.all([
    join(s, { password: PASSWORD, name: 'Zed', own: 'first-pw' }, { 'X-Forwarded-For': '1.1.1.1' }),
    join(s, { password: PASSWORD, name: 'zed', own: 'second-pw' }, { 'X-Forwarded-For': '2.2.2.2' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [204, 401], `${a.status} ${a.text} / ${b.status} ${b.text}`);
  const winner = a.status === 204 ? 'first-pw' : 'second-pw';
  assert.equal((await join(s, { password: PASSWORD, name: 'Zed', own: winner })).status, 204, 'the winner\'s password works');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'accounts.json'), 'utf8'))).filter(k => k === 'zed').length, 1);
});

test('a broken or locked accounts file pauses logins, instead of letting anyone take any nickname', async () => {
  const s = await start({ expectProblems: /Can't read .*accounts\.json/ });
  const alice = cookies(await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).auth;
  const file = path.join(s.dir, 'data', 'accounts.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.slice(0, 20));
  assert.equal((await s.get('/state', { cookie: asCookie(alice) })).status, 200, 'logged-in people carry on (the last good copy)');
  let r = await join(s, { password: PASSWORD, name: 'Bob', own: 'bobs-pw' });
  assert.equal(r.status, 503, 'no new nicknames meanwhile');
  assert.match(r.text, /accounts file/);
  assert.equal(fs.readFileSync(file, 'utf8'), good.slice(0, 20), 'the file is left alone (nothing wiped)');
  await s.restart();
  assert.equal((await s.get('/state', { cookie: asCookie(alice) })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'new-pw' })).status, 503, 'Alice can\'t be claimed by someone else');
  fs.writeFileSync(file, good);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).status, 204, 'fixed: back to normal');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: 'bobs-pw' })).status, 204);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort(), ['alice', 'bob'], 'Alice\'s account survived');
  assert.match(fs.readFileSync(path.join(s.dir, 'data', 'server.log'), 'utf8'), /Can't read .*accounts\.json/, 'the problem is in the server log');
});

test('the admin commands tidy up the name the same way joining does', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Big   Al', own: 'secret1' });
  assert.match(admin(s, '--set-password', ' big  al ', 'new-pw-1').stdout, /"Big Al" has a new password/);
  assert.match(admin(s, '--delete-account', '  big al  ').stdout, /"Big Al" is deleted/);
});

});
