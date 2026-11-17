// ---------- config.json ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, PASSWORD, APP_FILES, ROOT } = require('./helpers');

const start = testServers({ after });
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });

describe('settings', { concurrency: true }, () => {
test('no config.json: one is made, with a random room password and every setting at its default', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'couchwave-fresh-'));
  for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  const server = require('child_process').spawn(process.execPath, ['-r', path.join(__dirname, 'fakes', 'any-port.js'), 'server.js'],
    { cwd: dir, env: { ...process.env, COUCHWAVE_FAKE_TOOLS: path.join(__dirname, 'fakes') } });
  try {
    const file = path.join(dir, 'config.json');
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; } }, 5000, 'config.json to be made');
    const { password, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(password, /^[\w-]{8}$/, 'a random room password');
    assert.deepEqual(rest, { port: 3000, votePercent: 60, maxVideoHours: 3, downloadAhead: 20, downloadsAtOnce: 3, public: false });
  } finally {
    server.kill();
    await new Promise(r => setTimeout(r, 300));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('the room password and port come from config.json only, never the environment; a short one gets a warning', async () => {
  const s = await start({ env: { PORT: '65000', YTP_PASSWORD: 'from-the-environment' } });
  assert.equal((await join(s, { password: 'from-the-environment', name: 'Alice', own: 'secret1' })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).status, 204);
  const short = await start({ config: { password: 'abc' } });
  await short.logHas(/the room password is short \(3 characters\), so it's easy to guess/);
});

test('settings that don\'t make sense fall back to their defaults, and the log says so', async () => {
  const s = await start({
    config: { votePercent: 'lots', maxVideoHours: -2, downloadAhead: 2.5, downloadsAtOnce: 'lots', trustProxy: 'yes' },
    initial: { current: song(1, 'Song A', 'Zed', { duration: 100000 }) },
  });
  for (const line of [
    /votePercent should be a number from 1 to 100, not "lots"; using 60/,
    /maxVideoHours should be a number of hours above 0 \(like 3, or 1\.5\), not -2; using 3/,
    /downloadAhead should be a whole number of songs, 1 or more, not 2\.5; using 20/,
    /downloadsAtOnce should be a whole number, 1 or more, not "lots"; using 3/,
    /trustProxy should be true, false, or a list of addresses like .*, not "yes"; using true/,
  ]) await s.logHas(line);
  for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n);
  assert.equal((await s.state()).skip.need, 2, 'votePercent: 60% of 3');
  await s.post('/add', { url: yt('long_000004') });
  const q = await waitFor(async () => (await s.state()).queue.find(x => x.status === 'failed'), 5000, 'the too-long video to fail');
  assert.equal(q.error, 'Longer than 3 hours', 'maxVideoHours: 3');
  for (const trustProxy of [['not an address'], ['10.0.0.0/33'], 0]) {
    const t = await start({ config: { trustProxy } });
    await t.logHas(/trustProxy should be true, false, or a list of addresses/);
  }
});

test('"public": only exactly true opens the room: no room password (the join screen hides its box), but nicknames keep theirs', async () => {
  const normal = await start();
  assert.deepEqual((await normal.get('/room', { cookie: '' })).json, { public: false });
  assert.equal((await join(normal, { name: 'Alice', own: 'secret1' })).status, 401, 'normally the room password is needed');
  const yes = await start({ config: { public: 'yes' } });
  assert.deepEqual((await yes.get('/room', { cookie: '' })).json, { public: false }, '"yes" doesn\'t open the room by mistake');
  assert.equal((await join(yes, { name: 'Alice', own: 'secret1' })).status, 401);
  const s = await start({ config: { public: true, password: '' } });
  assert.deepEqual((await s.get('/room', { cookie: '' })).json, { public: true });
  assert.equal((await join(s, { name: 'Alice', own: 'secret1' })).status, 204, 'in, with no room password');
  assert.equal((await join(s, { password: 'anything', name: 'Bob', own: 'secret2' })).status, 204);
  assert.equal((await join(s, { name: 'alice', own: 'guess' })).status, 401, 'Alice\'s nickname still needs her password');
  await s.logHas(/"public" is on: there's no room password/);
});
});
