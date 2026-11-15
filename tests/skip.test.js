// Vote to skip (and how many votes it takes, which removing someone else's song shares): votePercent of the
// people online (config.json, 60 by default), votes per song, taking a vote back, the song's owner skipping
// without a vote, and votes surviving a restart. Timings are the server's (secs() in helpers.js).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { testServers, song, waitFor, sleep, secs } = require('./helpers');

const servers = testServers({ after });
// Zed's songs playing and queued, so Alice / Bob / Cara are never the owner (unless a test says so);
// Alice, Bob and Cara online. config: extra config.json settings (votePercent).
async function start(extra = {}, config) {
  const s = await servers({ config, initial: {
    current: song(1, 'Song A', 'Zed', { duration: 10000 }),
    queue: [song(2, 'Song B', 'Zed', { duration: 10000 }), song(3, 'Song C', 'Zed', { duration: 10000 })], ...extra,
  } });
  s.stopOnline = await s.keepOnline('Alice', 'Bob', 'Cara');
  return s;
}
const title = async s => (await s.state()).current.title;
const vote = (s, as, id, v = true) => s.post('/skip', { id, vote: v }, { as });

// Each test has its own server, so they run at the same time.
describe('vote to skip', { concurrency: true }, () => {
  test('the count everyone sees, and 2 of 3 skips', async () => {
    const s = await start();
    let st = await s.state();
    assert.deepEqual(st.skip, { voters: [], need: 2 }, '3 online: needs 2');
    await vote(s, 'Alice', 1);
    st = await s.state('Bob');
    assert.deepEqual(st.skip.voters, ['Alice'], 'Bob sees Alice\'s vote (the button shows "1 out of 3")');
    assert.equal(st.current.title, 'Song A', '1 of 3 isn\'t enough');
    await vote(s, 'Bob', 1);
    assert.equal(await title(s), 'Song B', '2 of 3 skips');
    assert.deepEqual((await s.state()).skip.voters, [], 'the new song starts with no votes');
    assert.ok((await s.log()).includes('Bob: skipped "Song A" (2 of 3 voted)'));
  });

  test('voting twice counts once, a vote can be taken back, and votes for an old song do nothing', async () => {
    const s = await start();
    await vote(s, 'Alice', 1); await vote(s, 'Alice', 1); // e.g. the lock-screen "next" pressed twice
    assert.deepEqual((await s.state()).skip.voters, ['Alice']);
    await vote(s, 'Alice', 1, false);
    assert.deepEqual((await s.state()).skip.voters, []);
    await vote(s, 'Alice', 999); // the song that just ended
    assert.deepEqual((await s.state()).skip.voters, []);
  });

  test('a page from before votes said which song (no id) still works: it switches your vote', async () => {
    const s = await start();
    await s.post('/skip', {}, { as: 'Alice' });
    assert.deepEqual((await s.state()).skip.voters, ['Alice']);
    await s.post('/skip', {}, { as: 'Alice' });
    assert.deepEqual((await s.state()).skip.voters, []);
  });

  test('on your own, one click skips', async () => {
    const s = await servers({ initial: { current: song(1, 'Song A', 'Zed', { duration: 10000 }), queue: [song(2, 'Song B', 'Zed')] } });
    assert.equal((await s.state()).skip.need, 1);
    await vote(s, 'Alice', 1);
    assert.equal(await title(s), 'Song B');
    assert.ok((await s.log()).includes('Alice: skipped "Song A"'));
  });

  test('whoever added the song skips it straight away, without a vote', async () => {
    const s = await start({ current: song(1, 'Bob\'s song', 'Bob', { duration: 10000 }) });
    await vote(s, 'Bob', 1);
    assert.equal(await title(s), 'Song B', 'skipped with 1 of 3');
    assert.ok((await s.log()).includes('Bob: skipped their song "Bob\'s song"'));
    await vote(s, 'Bob', 2); // ...but not someone else's song: that's a vote again
    assert.equal(await title(s), 'Song B');
    assert.deepEqual((await s.state()).skip.voters, ['Bob']);
  });

  test('someone reloading doesn\'t tip the vote; someone leaving does', async () => {
    const s = await start();
    s.stopOnline(); const stopAB = await s.keepOnline('Alice', 'Bob');
    await s.post('/bye', undefined, { as: 'Cara' }); // Cara closes the page for good
    await vote(s, 'Alice', 1); // 1 of 3
    // Bob reloads: gone for longer than the server's 1-second check, back well within "online"
    await s.post('/bye', undefined, { as: 'Bob' }); await sleep(secs(2)); await s.state('Bob');
    await sleep(secs(2));
    assert.equal(await title(s), 'Song A', 'Bob reloading didn\'t skip it');
    await waitFor(async () => (await s.state()).users.length === 2, secs(15), 'Cara to drop off the online list');
    assert.equal(await title(s), 'Song A', '1 of 2 still not enough');
    stopAB(); const stopA = await s.keepOnline('Alice');
    await s.post('/bye', undefined, { as: 'Bob' }); // Bob closes for good: 1 of 1
    await waitFor(async () => (await title(s)) === 'Song B', secs(20), 'Alice\'s vote to win once Bob has gone');
    stopA();
  });

  test('votes survive a restart (e.g. saving config.json restarts the server)', async () => {
    const s = await start();
    await vote(s, 'Alice', 1);
    s.stopOnline();
    await s.restart();
    for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n);
    assert.deepEqual((await s.state()).skip.voters, ['Alice']);
  });

  test('votes needed: 60% of the people online by default, rounded up (2 of 3, 3 of 4, 5 of 7, 6 of 9)', async () => {
    const s = await servers({ initial: { current: song(1, 'Song A', 'Zed', { duration: 10000 }) } });
    const people = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'], needs = [];
    for (let n = 1; n <= people.length; n++) {
      for (const p of people.slice(0, n)) await s.state(p); // n people online
      needs.push((await s.state('P1')).skip.need);
    }
    assert.deepEqual(needs, [1, 2, 2, 3, 3, 4, 5, 5, 6]); // ("more than half" would be 4 of 7 and 5 of 9)
  });

  test('votePercent 100 in config.json: everyone online has to vote, to skip and to remove someone else\'s song', async () => {
    const s = await start({}, { votePercent: 100 });
    assert.equal((await s.state()).skip.need, 3);
    await vote(s, 'Alice', 1); await vote(s, 'Bob', 1);
    assert.equal(await title(s), 'Song A', '2 of 3 isn\'t enough');
    await vote(s, 'Cara', 1);
    assert.equal(await title(s), 'Song B', '3 of 3 skips');
    for (const who of ['Alice', 'Bob']) await s.post('/remove', { id: 3, vote: true }, { as: who });
    assert.ok((await s.state()).queue.some(q => q.id === 3), 'remove: 2 of 3 isn\'t enough either');
    await s.post('/remove', { id: 3, vote: true }, { as: 'Cara' });
    assert.ok(!(await s.state()).queue.some(q => q.id === 3), '3 of 3 removes it');
  });

  test('votePercent 30: one vote of 3 is enough', async () => {
    const s = await start({}, { votePercent: 30 });
    assert.equal((await s.state()).skip.need, 1);
    await vote(s, 'Alice', 1);
    assert.equal(await title(s), 'Song B');
  });

  test('a votePercent that isn\'t 1 to 100 falls back to 60, and the log says so', async () => {
    const s = await start({}, { votePercent: 'lots' });
    assert.equal((await s.state()).skip.need, 2, '60% of 3');
    assert.match(fs.readFileSync(s.logFile, 'utf8'), /votePercent should be a number from 1 to 100, not "lots"; using 60/);
  });

  test('the DJ isn\'t counted: 2 people online and the DJ on still need 2 votes, not 3 of 3', async () => {
    const s = await servers({ initial: { current: song(1, 'Song A', 'Zed', { duration: 10000 }) } });
    const stop = await s.keepOnline('Alice', 'Bob');
    await s.post('/chat', { text: '!dj on' }, { as: 'Bob' });
    const st = await s.state();
    assert.equal(st.dj, true);
    assert.deepEqual(st.users, ['Alice', 'Bob']);
    assert.equal(st.skip.need, 2);
    stop();
  });
});
