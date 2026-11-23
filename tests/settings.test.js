// ---------- config.json ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, PASSWORD, testEnv, appCopy, run, freePort } = require('./helpers');

const start = testServers({ after });
const join = (s, body, headers) => s.req('POST', '/login', { body, cookie: '', headers });

describe('settings', { concurrency: true }, () => {
test('the first start: config.json is made (a random room password, every setting at its default), and a welcome says where to open it and the password, once', async () => {
  const copy = appCopy(), log = path.join(copy.dir, 'data', 'server.log');
  const startIt = () => require('child_process').spawn(process.execPath, ['-r', path.join(__dirname, 'fakes', 'any-port.js'), 'server.js'],
    { cwd: copy.dir, env: testEnv() });
  const logged = () => { try { return fs.readFileSync(log, 'utf8'); } catch { return ''; } };
  let server = startIt();
  try {
    const file = path.join(copy.dir, 'config.json');
    await waitFor(() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; } }, 5000, 'config.json to be made');
    const { password, ...rest } = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.match(password, /^[\w-]{8}$/, 'a random room password');
    assert.deepEqual(rest, { port: 3000, votePercent: 60, maxVideoHours: 3, downloadAhead: 20, downloadsAtOnce: 3, public: false });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only whoever runs Couchwave can read it');
    await waitFor(() => /To let friends in from the internet/.test(logged()), 5000, 'the welcome');
    for (const line of [/Welcome to Couchwave! It's running\./, /  Open it: +http:\/\/localhost:3000\n/, new RegExp(`  Room password: +${password} +\\(in config\\.json\\)`),
      /  To let friends in from the internet, see docs\/INSTALL\.md#letting-friends-in/]) assert.match(logged(), line);
    server.kill(); await sleep(500);
    server = startIt();
    await waitFor(() => (logged().match(/Running on/g) || []).length === 2, 5000, 'the second start');
    await sleep(300);
    assert.equal((logged().match(/Welcome to Couchwave/g) || []).length, 1, 'not again on later starts');
  } finally { server.kill(); await sleep(300); copy.clean(); }
});

test('the room password and port come from config.json only, never the environment; a short one gets a warning', async () => {
  const s = await start({ env: { PORT: '65000', YTP_PASSWORD: 'from-the-environment' } });
  assert.equal((await join(s, { password: 'from-the-environment', name: 'Alice', own: 'secret1' })).status, 401);
  assert.equal((await join(s, { password: PASSWORD, name: 'Alice', own: 'secret1' })).status, 204);
  const short = await start({ config: { password: 'abc' } });
  await short.logHas(/the room password is short \(3 characters\), so it's easy to guess/);
});

test('config.json and the data folder: only whoever runs Couchwave can read them (Linux and Mac), even if anyone could before', { skip: process.platform === 'win32' && 'Windows has no such permissions' }, async () => {
  const s = await start();
  await s.stop();
  fs.chmodSync(path.join(s.dir, 'config.json'), 0o644);
  fs.chmodSync(path.join(s.dir, 'data'), 0o755);
  await s.start();
  assert.equal(fs.statSync(path.join(s.dir, 'config.json')).mode & 0o777, 0o600, 'config.json (the room password)');
  assert.equal(fs.statSync(path.join(s.dir, 'data')).mode & 0o777, 0o700, 'the data folder (accounts, logins, the log, backups)');
  assert.equal((await s.state()).me, 'Alice', 'and it still works');
  const touched = () => fs.statSync(path.join(s.dir, 'config.json')).ctimeMs, before = touched();
  assert.equal((await s.command('--status')).status, 0);
  assert.equal(touched(), before, 'once private, config.json is left alone (node --watch would see any change as a reason to restart)');
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
  await waitFor(async () => (await s.log()).includes(`Alice: tried to add ${yt('long_000004')}, but it's longer than 3 hours`), 5000, 'maxVideoHours: 3');
  for (const trustProxy of [['not an address'], ['10.0.0.0/33'], 0]) {
    const t = await start({ config: { trustProxy } });
    await t.logHas(/trustProxy should be true, false, or a list of addresses/);
  }
});

test('"public": only exactly true opens the room: no room password (the join screen hides its box), but nicknames keep theirs', async () => {
  const normal = await start();
  assert.equal((await normal.get('/room', { cookie: '' })).json.public, false);
  assert.equal((await join(normal, { name: 'Alice', own: 'secret1' })).status, 401, 'normally the room password is needed');
  const yes = await start({ config: { public: 'yes' } });
  assert.equal((await yes.get('/room', { cookie: '' })).json.public, false, '"yes" doesn\'t open the room by mistake');
  assert.equal((await join(yes, { name: 'Alice', own: 'secret1' })).status, 401);
  const s = await start({ config: { public: true, password: '' } });
  assert.equal((await s.get('/room', { cookie: '' })).json.public, true);
  assert.equal((await join(s, { name: 'Alice', own: 'secret1' })).status, 204, 'in, with no room password');
  assert.equal((await join(s, { password: 'anything', name: 'Bob', own: 'secret2' })).status, 204);
  assert.equal((await join(s, { name: 'alice', own: 'guess' })).status, 401, 'Alice\'s nickname still needs her password');
  await s.logHas(/"public" is on: there's no room password/);
});

test('a port that\'s already in use: it says so plainly (is Couchwave already running?) and stops', async () => {
  const first = await start(), copy = appCopy();
  try {
    fs.writeFileSync(path.join(copy.dir, 'config.json'), JSON.stringify({ password: PASSWORD, port: first.port }));
    assert.equal((await run(copy.dir, [], { timeout: 20000 })).status, 1);
    assert.match(fs.readFileSync(path.join(copy.dir, 'data', 'server.log'), 'utf8'),
      new RegExp(`Can't start: port ${first.port} is already in use\\. Is Couchwave already running\\? Close it, or set another "port" in config\\.json`));
    assert.equal((await first.get('/manifest.json', { cookie: '' })).status, 200, 'the one already running carries on');
  } finally { copy.clean(); }
});

test('a mistake in config.json: it says what is wrong and how to fix it, instead of a bare error', async () => {
  const copy = appCopy();
  try {
    fs.writeFileSync(path.join(copy.dir, 'config.json'), '{\n  "password": "long-enough-pw",\n  "klipyKey": abc123"\n}\n');
    const r = await run(copy.dir, [], { timeout: 15000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /config\.json has a mistake in it, so Couchwave can't start \(Unexpected token .*\)\. Text needs "quotes" around it, and every setting but the last needs a comma after it: see docs\/INSTALL\.md#settings\. Fix it and save it/);
    assert.ok(!r.stderr.includes(copy.dir), 'without the long path to it');
  } finally { copy.clean(); }
});

test('COUCHWAVE_CONFIG (what the Docker image uses): settings live in that file instead, so the data folder holds everything', async () => {
  const copy = appCopy(), inData = path.join(copy.dir, 'data', 'config.json'), port = await freePort();
  fs.mkdirSync(path.join(copy.dir, 'data'), { recursive: true });
  fs.writeFileSync(inData, JSON.stringify({ password: PASSWORD, port }));
  const server = require('child_process').spawn(process.execPath, ['server.js'], { cwd: copy.dir, env: testEnv({ COUCHWAVE_CONFIG: inData }) });
  try {
    await waitFor(() => fetch(`http://127.0.0.1:${port}/health`).then(r => r.ok, () => false), 8000, 'it to start, on the port in that file');
    assert.ok(!fs.existsSync(path.join(copy.dir, 'config.json')), 'no config.json made next to server.js');
    const status = await run(copy.dir, ['--status'], { env: { COUCHWAVE_CONFIG: inData } });
    assert.match(status.stdout, new RegExp(`is running on port ${port}`), 'the commands read it too');
  } finally { server.kill(); await sleep(300); copy.clean(); }
});
});
