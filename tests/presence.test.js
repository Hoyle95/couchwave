// ---------- Who is online, joined and left ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const { testServers, song, waitFor, sleep, secs, TIME } = require('./helpers');

async function openEvents(s, as, cookie) {
  cookie = cookie || await s.cookie(as);
  const ev = { ended: false };
  await new Promise((ok, fail) => {
    const req = http.get({ port: s.port, path: '/events', headers: { Cookie: cookie } }, res => {
      res.resume(); res.on('end', () => { ev.ended = true; }); res.on('close', () => { ev.ended = true; }); ok();
    });
    req.on('error', e => { if (!ev.ended) fail(e); });
    ev.close = () => req.destroy();
  });
  return ev;
}

const servers = testServers({ after });
const start = () => servers({ initial: { here: {} } });
const comings = async s => (await s.log()).filter(l => /joined|left/.test(l)).sort();
const saved = (s, ...names) => waitFor(() => { try { const h = JSON.parse(fs.readFileSync(s.statePath, 'utf8')).here || {}; return names.every(n => n in h); } catch { return false; } }, 3000, 'who\'s here to be saved');

describe('joined / left', { concurrency: true }, () => {
  test('opening the page: "joined" and in the online list; reloading, or closing one of two tabs, isn\'t leaving', async () => {
    const s = await start();
    const stop = await s.keepOnline('Alice', 'Bob');
    assert.deepEqual((await s.state('Bob')).users, ['Alice', 'Bob']);
    await s.post('/bye', undefined, { as: 'Bob' }); await sleep(100); await s.state('Bob');
    await s.post('/bye', undefined, { as: 'Alice' });
    await sleep(secs(16));
    assert.deepEqual(await comings(s), ['Alice: joined', 'Bob: joined'], 'no "left" for Bob\'s reload or Alice\'s other tab');
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
    assert.ok(after >= 9 && after < 22, `"left" after ${after.toFixed(1)} (server) seconds`);
    assert.deepEqual((await s.state()).users, ['Alice']);
    stop();
  });

  test('a page in a background tab (instant updates open, checking in rarely) stays online, and its vote counts', async () => {
    const s = await servers({ initial: { here: {}, current: song(1, 'Song A', 'Zed', { duration: 10000 }), queue: [song(2, 'Song B', 'Zed', { duration: 10000 })] } });
    const stop = await s.keepOnline('Alice');
    await s.state('Bob'); const bob = await openEvents(s, 'Bob');
    await sleep(secs(14));
    assert.deepEqual((await s.state()).users, ['Alice', 'Bob'], 'Bob is still online');
    await s.post('/remove', { id: 2, vote: true }, { as: 'Alice' });
    assert.ok(await s.queued(q => q.id === 2), 'Alice alone isn\'t enough to remove Zed\'s song: 1 of 2');
    bob.close();
    await waitFor(async () => !(await s.state()).users.includes('Bob'), secs(14), 'Bob to go offline');
    stop();
  });

  test('logging out: "left" straight away, and the open page stops keeping you online; --logout-everyone stops it too', async () => {
    const s = await start();
    const stop = await s.keepOnline('Alice');
    await s.state('Bob'); const bob = await openEvents(s, 'Bob');
    await s.post('/logout', undefined, { as: 'Bob' });
    assert.ok((await s.log()).includes('Bob: left'), 'straight away');
    assert.ok(await waitFor(() => bob.ended, 3000, 'Bob\'s instant updates to end'));
    assert.deepEqual((await s.state()).users, ['Alice']);
    s.forget('Bob'); await s.state('Bob'); const bob2 = await openEvents(s, 'Bob');
    await s.command('--logout-everyone');
    assert.ok(await waitFor(() => bob2.ended, secs(20), 'the stream to end after --logout-everyone'));
    stop();
  });

  test('logging out on one device while still on another: not "left", and the other stays online', async () => {
    const s = await start();
    const stop = await s.keepOnline('Alice');
    await s.state('Eve'); const laptop = await openEvents(s, 'Eve');
    const phone = `auth=${await s.login('Eve')}; name=Eve`;
    await s.get('/state', { cookie: phone }); const phoneEvents = await openEvents(s, 'Eve', phone);
    await s.req('POST', '/logout', { cookie: phone });
    assert.ok(await waitFor(() => phoneEvents.ended, 3000, 'the phone\'s instant updates to end'));
    await sleep(secs(15));
    assert.equal(laptop.ended, false, 'the laptop\'s instant updates carry on');
    assert.ok((await s.state()).users.includes('Eve'), 'still online');
    assert.deepEqual((await comings(s)).filter(l => l.startsWith('Eve')), ['Eve: joined'], 'no "left", no second "joined"');
    laptop.close(); stop();
  });

  test('a quick restart: nobody is re-announced or logged as leaving', async () => {
    const s = await start();
    await s.state('Alice'); await s.state('Bob');
    await saved(s, 'Alice', 'Bob');
    await s.restart();
    const stop = await s.keepOnline('Alice', 'Bob');
    await sleep(secs(8));
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
    state.log.forEach(e => (e.t -= 3 * 3600 * 1000));
    fs.writeFileSync(s.statePath, JSON.stringify(state));
    await s.start();
    const st = await s.state('Alice');
    const left = st.log.find(e => e.by === 'Alice' && e.text === 'left');
    assert.ok(left && Math.abs(left.t - twoHoursAgo) < 1000, 'Alice left two hours ago, not now');
    assert.ok(st.log.every((e, i) => !i || st.log[i - 1].t <= e.t), 'the log stays in time order');
    assert.equal((await s.log()).at(-1), 'Alice: joined', 'coming back is announced');
  });
});
