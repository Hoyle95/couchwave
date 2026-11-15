// Logging in: the room password, nicknames with their own passwords, the login cookie, logging out,
// the wrong-password limit, --logout-everyone, --delete-account and --set-password.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { testServers, waitFor, PASSWORD, ownPassword } = require('./helpers');

const start = testServers({ after });
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });
const cookies = r => Object.fromEntries((r.headers['set-cookie'] || []).map(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }));
const asCookie = (auth, name = 'whatever') => `auth=${auth}; name=${encodeURIComponent(name)}`;

// Each test has its own server, so they run at the same time.
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

test('claiming a name someone already had before accounts keeps its spelling (and their picture and songs)', async () => {
  const s = await start({ initial: { colors: { LVJ: '#26549e' }, faces: { LVJ: '🐸' }, queue: [], current: null } });
  const r = await join(s, { password: PASSWORD, name: 'lvj', own: 'secret1' });
  assert.equal(r.status, 204);
  assert.equal(cookies(r).name, 'LVJ');
  const st = (await s.get('/state', { cookie: asCookie(cookies(r).auth) })).json;
  assert.deepEqual(st.users, ['LVJ']);
  assert.equal(st.faces.LVJ, '🐸');
});

test('the login cookie decides who you are: editing the name cookie or the login cookie gets nowhere', async () => {
  const s = await start();
  const alice = cookies(await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).auth;
  await s.req('POST', '/chat', { body: { text: 'hi' }, cookie: asCookie(alice, 'Bob') }); // name cookie says Bob
  assert.equal((await s.state('Cara')).chat.at(-1).by, 'Alice', 'still Alice');
  const [, sig] = alice.split('.');
  const forged = Buffer.from('Bob').toString('base64url') + '.' + sig; // Bob's name with Alice's signature
  await join(s, { password: PASSWORD, name: 'Bob', own: 'bobs-pw' });
  assert.equal((await s.get('/state', { cookie: asCookie(forged) })).status, 401, 'a made-up login cookie');
  assert.equal((await s.get('/state', { cookie: asCookie('x' + alice) })).status, 401, 'a changed one');
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

test('logging out ends that login only', async () => {
  const s = await start();
  await s.state('Bob');
  const r = await s.post('/logout');
  assert.equal(r.status, 204);
  assert.match(r.headers['set-cookie'][0], /auth=;.*Max-Age=0/);
  assert.equal((await s.get('/state', { cookie: await s.cookie('Alice') })).status, 200, 'the cookie itself still checks out (the browser deletes it)');
  assert.equal((await s.get('/state', { as: 'Bob' })).status, 200, 'Bob is still logged in');
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
});

test('the page is told who you are by the server, not by the name cookie', async () => {
  const s = await start();
  const alice = cookies(await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).auth;
  const st = (await s.get('/state', { cookie: asCookie(alice, 'Bob') })).json;
  assert.equal(st.me, 'Alice');
});

test('look-alike nicknames: invisible characters, other widths and mixed alphabets don\'t make a second "Alice"', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' });
  for (const name of ['Alice​', '​Alice', 'Ａｌｉｃｅ', 'Al­ice']) { // zero-width space, full-width letters, soft hyphen
    const r = await join(s, { password: PASSWORD, name, own: 'other-pw' });
    assert.equal(r.status, 401, JSON.stringify(name) + ' is Alice, so it needs her password');
  }
  assert.equal((await join(s, { password: PASSWORD, name: 'Ａｌｉｃｅ', own: 'secret1' })).status, 204, '...and with it, it\'s her');
  const r = await join(s, { password: PASSWORD, name: 'Аlice', own: 'other-pw' }); // Cyrillic А
  assert.equal(r.status, 400, 'a Cyrillic letter among Latin ones');
  assert.equal((await join(s, { password: PASSWORD, name: 'Алиса', own: 'other-pw' })).status, 204, 'one alphabet is fine');
});

test('two people claiming the same new nickname at once: only one gets it', async () => {
  const s = await start();
  const [a, b] = await Promise.all([
    join(s, { password: PASSWORD, name: 'Zed', own: 'first-pw' }, { 'CF-Connecting-IP': '1.1.1.1' }),
    join(s, { password: PASSWORD, name: 'zed', own: 'second-pw' }, { 'CF-Connecting-IP': '2.2.2.2' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [204, 401], `${a.status} ${a.text} / ${b.status} ${b.text}`);
  const winner = a.status === 204 ? 'first-pw' : 'second-pw';
  assert.equal((await join(s, { password: PASSWORD, name: 'Zed', own: winner })).status, 204, 'the winner\'s password works');
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(s.dir, 'data', 'accounts.json'), 'utf8'))).filter(k => k === 'zed').length, 1);
});

test('a broken or locked accounts file pauses logins, instead of letting anyone take any nickname', async () => {
  const s = await start({ expectProblems: /Can't read .*accounts\.json/ }); // the error this test causes on purpose
  const alice = cookies(await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).auth;
  const file = path.join(s.dir, 'data', 'accounts.json');
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.slice(0, 20)); // e.g. a bad hand edit
  assert.equal((await s.get('/state', { cookie: asCookie(alice) })).status, 200, 'logged-in people carry on (the last good copy)');
  let r = await join(s, { password: PASSWORD, name: 'Bob', own: 'bobs-pw' });
  assert.equal(r.status, 503, 'no new nicknames meanwhile');
  assert.match(r.text, /accounts file/);
  assert.equal(fs.readFileSync(file, 'utf8'), good.slice(0, 20), 'the file is left alone (nothing wiped)');
  // Started with it broken: nobody gets in, nobody can claim anything
  await s.restart();
  assert.equal((await s.get('/state', { cookie: asCookie(alice) })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'new-pw' })).status, 503, 'Alice can\'t be claimed by someone else');
  fs.writeFileSync(file, good); // fixed
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

test('many wrong guesses sent all at once still count towards the limit', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' });
  const from = { 'CF-Connecting-IP': '9.9.9.9' };
  await Promise.all(Array.from({ length: 25 }, (_, i) => join(s, { password: PASSWORD, name: 'Alice', own: 'guess' + i }, from)));
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' }, from)).status, 429);
});

test('normally, the room password is needed (and the join screen shows its box)', async () => {
  const s = await start();
  assert.deepEqual((await s.get('/room', { cookie: '' })).json, { public: false });
  assert.equal((await join(s, { name: 'Alice', own: 'secret1' })).status, 401, 'no room password: refused');
});

test('"public": true in config.json: no room password (not even set), but nicknames still have their own', async () => {
  const s = await start({ config: { public: true, password: '' } });
  assert.deepEqual((await s.get('/room', { cookie: '' })).json, { public: true }, 'the join screen hides the room password box');
  assert.equal((await join(s, { name: 'Alice', own: 'secret1' })).status, 204, 'in, with no room password');
  assert.equal((await join(s, { password: 'anything', name: 'Bob', own: 'secret2' })).status, 204);
  assert.equal((await join(s, { name: 'alice', own: 'guess' })).status, 401, 'Alice\'s nickname still needs her password');
  assert.match(fs.readFileSync(s.logFile, 'utf8'), /"public" is on: there's no room password/, 'the log says so');
});

test('"public" only turns on with exactly true ("yes" doesn\'t open the room by mistake)', async () => {
  const s = await start({ config: { public: 'yes' } });
  assert.deepEqual((await s.get('/room', { cookie: '' })).json, { public: false });
  assert.equal((await join(s, { name: 'Alice', own: 'secret1' })).status, 401);
});

test('20 wrong passwords (room or own): that address is locked out, other visitors aren\'t', async () => {
  const s = await start();
  await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' });
  // Through a tunnel every request comes from localhost, so the real visitor is in a header.
  const from = ip => ({ 'CF-Connecting-IP': ip });
  for (let i = 0; i < 10; i++) assert.equal((await join(s, { password: 'wrong', name: 'Eve', own: 'xxxx' }, from('1.2.3.4'))).status, 401);
  for (let i = 0; i < 10; i++) assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'guess' + i }, from('1.2.3.4'))).status, 401, 'guessing Alice\'s password');
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' }, from('1.2.3.4'))).status, 429, 'locked out, even with the right passwords');
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' }, from('5.6.7.8'))).status, 204, 'Alice herself, elsewhere, can still log in');
});
});
