// Logging in and out, the wrong-password limit, and --logout-everyone.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { Server, PASSWORD } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
const start = async () => { const s = new Server(); servers.push(s); return s.start(); };

test('without the login cookie, nothing works', async () => {
  const s = await start();
  for (const [method, url] of [['GET', '/state'], ['POST', '/chat'], ['POST', '/skip'], ['GET', '/video/1'], ['GET', '/events']]) {
    assert.equal((await s.req(method, url, { cookie: 'name=Alice', body: method === 'POST' ? { text: 'hi' } : undefined })).status, 401, `${method} ${url}`);
  }
  assert.equal((await s.state()).chat.length, 0, 'the chat message was not posted');
});

test('wrong password: refused. Right password: a login cookie that isn\'t the password', async () => {
  const s = await start();
  assert.equal((await s.req('POST', '/login', { body: { password: 'nope' }, cookie: '' })).status, 401);
  const r = await s.req('POST', '/login', { body: { password: PASSWORD }, cookie: '' });
  assert.equal(r.status, 204);
  const cookie = r.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.ok(!cookie.includes(PASSWORD), 'the password itself is not in the cookie');
});

test('logging out ends that login', async () => {
  const s = await start();
  const r = await s.post('/logout');
  assert.equal(r.status, 204);
  assert.match(r.headers['set-cookie'][0], /auth=;.*Max-Age=0/);
});

test('--logout-everyone: old logins stop working, the password still works', async () => {
  const s = await start();
  assert.equal((await s.get('/state')).status, 200);
  execFileSync(process.execPath, ['server.js', '--logout-everyone'], { cwd: s.dir });
  assert.equal((await s.get('/state')).status, 401, 'old cookie refused (while the server keeps running)');
  s.auth = await s.login();
  assert.equal((await s.get('/state')).status, 200, 'logging in again works');
});

test('20 wrong passwords: that address is locked out, other visitors aren\'t', async () => {
  const s = await start();
  // Through a tunnel every request comes from localhost, so the real visitor is in a header.
  const as = ip => ({ cookie: '', headers: { 'CF-Connecting-IP': ip } });
  for (let i = 0; i < 20; i++) assert.equal((await s.req('POST', '/login', { body: { password: 'wrong' }, ...as('1.2.3.4') })).status, 401);
  assert.equal((await s.req('POST', '/login', { body: { password: 'wrong' }, ...as('1.2.3.4') })).status, 429);
  assert.equal((await s.req('POST', '/login', { body: { password: PASSWORD }, ...as('1.2.3.4') })).status, 429, 'even the right password, for now');
  assert.equal((await s.req('POST', '/login', { body: { password: PASSWORD }, ...as('5.6.7.8') })).status, 204, 'someone else can still log in');
});
