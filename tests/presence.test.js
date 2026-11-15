// Who's online, and "joined" / "left" in the activity log (closing the page, reloading, logging out,
// restarts, and the server having been off for a while). Timings are the server's (see secs() in helpers.js).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { testServers, waitFor, sleep, secs, TIME } = require('./helpers');

const servers = testServers({ after });
// A saved "here" (even empty) means no quiet period after startup: arrivals are announced straight away.
const start = () => servers({ initial: { here: {} } });
const comings = async s => (await s.log()).filter(l => /joined|left/.test(l)).sort(); // (who checks in first varies)
const saved = (s, ...names) => waitFor(() => { try { const h = JSON.parse(fs.readFileSync(s.statePath, 'utf8')).here || {}; return names.every(n => n in h); } catch { return false; } }, 3000, 'who\'s here to be saved');

// Each test has its own server, so they run at the same time (most of the time is spent waiting).
describe('joined / left', { concurrency: true }, () => {
  test('opening the page: "joined" and in the online list; reloading isn\'t logged', async () => {
    const s = await start();
    const stop = await s.keepOnline('Alice', 'Bob');
    assert.deepEqual((await s.state('Bob')).users, ['Alice', 'Bob']);
    await s.post('/bye', undefined, { as: 'Bob' }); await sleep(secs(2)); await s.state('Bob'); // a reload: back a moment later
    await sleep(secs(16)); // longer than "left" takes after closing a page
    assert.deepEqual(await comings(s), ['Alice: joined', 'Bob: joined'], 'no "left" for the reload');
    stop();
  });

  test('closing the page: "left" after about 10 seconds', async () => {
    const s = await start();
    await s.state('Cara');
    const stop = await s.keepOnline('Alice');
    const closedAt = Date.now();
    await s.post('/bye', undefined, { as: 'Cara' });
    await waitFor(async () => (await s.log()).includes('Cara: left'), secs(20), 'Cara: left');
    const after = (Date.now() - closedAt) / 1000 / TIME;
    assert.ok(after >= 9 && after < 17, `"left" after ${after.toFixed(1)} (server) seconds`);
    assert.deepEqual((await s.state()).users, ['Alice']);
    stop();
  });

  test('closing one of two tabs isn\'t leaving', async () => {
    const s = await start();
    const stop = await s.keepOnline('Alice'); // the other tab is still checking in
    await s.post('/bye', undefined, { as: 'Alice' });
    await sleep(secs(16));
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
    await saved(s, 'Alice', 'Bob');
    await s.restart();
    const stop = await s.keepOnline('Alice', 'Bob');
    await sleep(secs(8)); // several of the server's checks for who's left
    assert.deepEqual(await comings(s), ['Alice: joined', 'Bob: joined']);
    stop();
  });

  test('server off for 2 hours: "left" at the time they were last seen, and "joined" when they come back', async () => {
    const s = await start();
    await s.state('Alice'); await s.state('Bob');
    await saved(s, 'Alice', 'Bob');
    await s.stop();
    const state = JSON.parse(fs.readFileSync(s.statePath, 'utf8'));
    assert.equal(typeof state.here.Alice, 'number', 'saved with when each was last seen');
    const twoHoursAgo = Date.now() - 2 * 3600 * 1000;
    state.here = { Alice: twoHoursAgo, Bob: twoHoursAgo + 5000 };
    state.log.forEach(e => (e.t -= 3 * 3600 * 1000)); // the joins were before that
    fs.writeFileSync(s.statePath, JSON.stringify(state));
    await s.start();
    const st = await s.state('Alice');
    const left = st.log.find(e => e.by === 'Alice' && e.text === 'left');
    assert.ok(left && Math.abs(left.t - twoHoursAgo) < 1000, 'Alice left two hours ago, not now');
    assert.ok(st.log.every((e, i) => !i || st.log[i - 1].t <= e.t), 'the log stays in time order');
    assert.equal((await s.log()).at(-1), 'Alice: joined', 'coming back is announced');
  });
});
