// Who's online, and "joined" / "left" in the activity log (closing the page, reloading, logging out,
// restarts, and the server having been off for a while).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { Server, waitFor, sleep } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
async function start() {
  // A saved "here" (even empty) means no quiet period after startup: arrivals are announced straight away.
  const s = new Server({ initial: { here: {} } });
  servers.push(s);
  return s.start();
}

// Each test has its own server, so they run at the same time (most of the time is spent waiting).
describe('joined / left', { concurrency: true }, () => {
test('opening the page: "joined" and in the online list; reloading isn\'t logged', async () => {
  const s = await start();
  await s.state('Alice'); await s.state('Bob');
  const st = await s.state('Bob');
  assert.deepEqual(st.users, ['Alice', 'Bob']);
  const stop = s.keepOnline('Alice', 'Bob');
  await s.post('/bye', undefined, { as: 'Bob' }); await sleep(1500); await s.state('Bob'); // reload (takes a second or two)
  await sleep(14000);
  const log = await s.log();
  assert.deepEqual(log.filter(l => /joined|left/.test(l)), ['Alice: joined', 'Bob: joined'], 'no "left" for the reload');
  stop();
});

test('closing the page: "left" after about 10 seconds', async () => {
  const s = await start();
  await s.state('Alice'); await s.state('Cara');
  const stop = s.keepOnline('Alice');
  const closedAt = Date.now();
  await s.post('/bye', undefined, { as: 'Cara' });
  await waitFor(async () => (await s.log()).includes('Cara: left'), 20000, 'Cara: left');
  const secs = (Date.now() - closedAt) / 1000;
  assert.ok(secs >= 9 && secs < 17, `"left" after ${secs.toFixed(1)}s`);
  assert.deepEqual((await s.state()).users, ['Alice']);
  stop();
});

test('closing one of two tabs isn\'t leaving', async () => {
  const s = await start();
  const stop = s.keepOnline('Alice'); // the other tab is still checking in
  await s.state('Alice');
  await s.post('/bye', undefined, { as: 'Alice' });
  await sleep(14000);
  assert.ok(!(await s.log()).includes('Alice: left'));
  stop();
});

test('logging out: "left" straight away', async () => {
  const s = await start();
  await s.state('Dan');
  await s.post('/logout', undefined, { as: 'Dan' });
  assert.ok((await s.log()).includes('Dan: left'));
});

test('a quick restart: nobody is re-announced or logged as leaving', async () => {
  const s = await start();
  await s.state('Alice'); await s.state('Bob');
  await sleep(1200); // saved
  await s.restart();
  const stop = s.keepOnline('Alice', 'Bob');
  await sleep(6000);
  assert.deepEqual((await s.log()).filter(l => /joined|left/.test(l)), ['Alice: joined', 'Bob: joined']);
  stop();
});

test('server off for 2 hours: "left" at the time they were last seen, and "joined" when they come back', async () => {
  const s = await start();
  await s.state('Alice'); await s.state('Bob');
  await sleep(1200);
  await s.stop();
  const saved = JSON.parse(fs.readFileSync(s.statePath, 'utf8'));
  assert.equal(typeof saved.here.Alice, 'number', 'saved with when each was last seen');
  const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
  saved.here = { Alice: twoHoursAgo, Bob: twoHoursAgo + 5000 };
  saved.log.forEach(e => (e.t -= 3 * 3600 * 1000)); // the joins were before that
  fs.writeFileSync(s.statePath, JSON.stringify(saved));
  await s.start();
  const st = await s.state('Alice');
  const left = st.log.find(e => e.by === 'Alice' && e.text === 'left');
  assert.ok(left && Math.abs(left.t - twoHoursAgo) < 1000, 'Alice left two hours ago, not now');
  assert.ok(st.log.every((e, i) => !i || st.log[i - 1].t <= e.t), 'the log stays in time order');
  assert.equal((await s.log()).at(-1), 'Alice: joined', 'coming back is announced');
});

});

test('no crashes or warnings from the server', () => {
  for (const s of servers) assert.deepEqual(s.problems(), []);
});
