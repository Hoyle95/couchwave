// ---------- Vote to skip ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { testServers, song, waitFor, sleep, secs } = require('./helpers');

const servers = testServers({ after });
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
    assert.ok((await s.log()).includes(': "Song A" was skipped (2 of 3 voted)'), 'logged with nobody\'s name (it was a group effort), not as Bob\'s, the deciding vote');
  });

  test('voting twice counts once, a vote can be taken back, and votes for an old song do nothing', async () => {
    const s = await start();
    await vote(s, 'Alice', 1); await vote(s, 'Alice', 1);
    assert.deepEqual((await s.state()).skip.voters, ['Alice']);
    await vote(s, 'Alice', 1, false);
    assert.deepEqual((await s.state()).skip.voters, []);
    await vote(s, 'Alice', 999);
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
    await vote(s, 'Bob', 2);
    assert.equal(await title(s), 'Song B');
    assert.deepEqual((await s.state()).skip.voters, ['Bob']);
  });

  test('votes to remove a queued song carry over as votes to skip it once it plays', async () => {
    const s = await start();
    await s.post('/remove', { id: 2 }, { as: 'Alice' });
    assert.deepEqual((await s.state()).queue.find(q => q.id === 2).removeVoters, ['Alice']);
    await vote(s, 'Bob', 1); await vote(s, 'Cara', 1);
    let st = await s.state();
    assert.equal(st.current.title, 'Song B');
    assert.deepEqual(st.skip.voters, ['Alice'], 'Alice\'s vote to remove is now a vote to skip ("1 out of 3")');
    await vote(s, 'Alice', 2, false);
    assert.deepEqual((await s.state()).skip.voters, []);
    await s.post('/remove', { id: 3 }, { as: 'Alice' });
    await vote(s, 'Bob', 2); await vote(s, 'Cara', 2);
    await waitFor(async () => (await title(s)) === 'Song C');
    await vote(s, 'Bob', 3);
    assert.ok(await waitFor(async () => (await s.state()).current?.title !== 'Song C'), 'skipped with the carried-over vote');
  });

  test('someone reloading doesn\'t tip the vote; someone leaving does', async () => {
    const s = await start();
    s.stopOnline(); const stopAB = await s.keepOnline('Alice', 'Bob');
    await s.post('/bye', undefined, { as: 'Cara' });
    await vote(s, 'Alice', 1);
    await s.post('/bye', undefined, { as: 'Bob' }); await sleep(secs(2)); await s.state('Bob');
    await sleep(secs(2));
    assert.equal(await title(s), 'Song A', 'Bob reloading didn\'t skip it');
    await waitFor(async () => (await s.state()).users.length === 2, secs(15), 'Cara to drop off the online list');
    assert.equal(await title(s), 'Song A', '1 of 2 still not enough');
    stopAB(); const stopA = await s.keepOnline('Alice');
    await s.post('/bye', undefined, { as: 'Bob' });
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
      for (const p of people.slice(0, n)) await s.state(p);
      needs.push((await s.state('P1')).skip.need);
    }
    assert.deepEqual(needs, [1, 2, 2, 3, 3, 4, 5, 5, 6]);
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
    await s.logHas(/votePercent should be a number from 1 to 100, not "lots"; using 60/);
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
