// Logging in: the room password, nicknames with their own passwords, the login cookie, logging out,
// the wrong-password limit, --logout-everyone and --forget-name.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { Server, PASSWORD, ownPassword } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
const start = async () => { const s = new Server(); servers.push(s); return s.start(); };
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });
const cookies = r => Object.fromEntries((r.headers['set-cookie'] || []).map(c => { const [kv] = c.split(';'); const i = kv.indexOf('='); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }));
const asCookie = (auth, name = 'whatever') => `auth=${auth}; name=${encodeURIComponent(name)}`;

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
  const s = new Server({ initial: { colors: { LVJ: '#26549e' }, faces: { LVJ: '🐸' }, queue: [], current: null } });
  servers.push(s); await s.start();
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

test('--forget-name: frees a nickname (a forgotten password); its old logins stop working', async () => {
  const s = await start();
  const bobsOld = await s.cookie('Bob');
  assert.equal((await s.get('/state', { cookie: bobsOld })).status, 200);
  const out = execFileSync(process.execPath, ['server.js', '--forget-name', 'bob'], { cwd: s.dir, encoding: 'utf8' });
  assert.match(out, /"Bob" is free/);
  assert.equal((await s.get('/state', { cookie: bobsOld })).status, 401, 'logged out (while the server keeps running)');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: 'new-password' })).status, 204, 'claimed again with a new password');
  assert.equal((await join(s, { password: PASSWORD, name: 'Bob', own: ownPassword('Bob') })).status, 401, 'the old password doesn\'t work');
  const r = spawnSync(process.execPath, ['server.js', '--forget-name', 'nobody'], { cwd: s.dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No nickname "nobody". Taken nicknames: .*Bob/);
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
