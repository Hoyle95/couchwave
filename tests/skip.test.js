// Vote to skip: more than half of the people online, votes per song, taking a vote back, the song's owner
// skipping without a vote, and votes surviving a restart.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { Server, song, waitFor, sleep } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
// Zed's songs playing and queued, so Alice / Bob / Cara are never the owner (unless a test says so).
async function start(extra = {}) {
  const s = new Server({ initial: {
    current: song(1, 'Song A', 'Zed', { duration: 10000 }),
    queue: [song(2, 'Song B', 'Zed', { duration: 10000 }), song(3, 'Song C', 'Zed', { duration: 10000 })], ...extra,
  } });
  servers.push(s);
  await s.start();
  for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n);
  s.stopOnline = s.keepOnline('Alice', 'Bob', 'Cara');
  return s;
}
const title = async s => (await s.state()).current.title;
const vote = (s, as, id, v = true) => s.post('/skip', { id, vote: v }, { as });

// Each test has its own server, so they run at the same time (most of the time is spent waiting).
describe('vote to skip', { concurrency: true }, () => {
test('the count everyone sees, and more than half skips', async () => {
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
  s.stopOnline();
});

test('voting twice counts once, a vote can be taken back, and votes for an old song do nothing', async () => {
  const s = await start();
  await vote(s, 'Alice', 1); await vote(s, 'Alice', 1); // e.g. the lock-screen "next" pressed twice
  assert.deepEqual((await s.state()).skip.voters, ['Alice']);
  await vote(s, 'Alice', 1, false);
  assert.deepEqual((await s.state()).skip.voters, []);
  await vote(s, 'Alice', 999); // the song that just ended
  assert.deepEqual((await s.state()).skip.voters, []);
  s.stopOnline();
});

test('a page from before votes said which song (no id) still works: it switches your vote', async () => {
  const s = await start();
  await s.post('/skip', {}, { as: 'Alice' });
  assert.deepEqual((await s.state()).skip.voters, ['Alice']);
  await s.post('/skip', {}, { as: 'Alice' });
  assert.deepEqual((await s.state()).skip.voters, []);
  s.stopOnline();
});

test('on your own, one click skips', async () => {
  const s = new Server({ initial: { current: song(1, 'Song A', 'Zed', { duration: 10000 }), queue: [song(2, 'Song B', 'Zed')] } });
  servers.push(s); await s.start();
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
  // ...but not someone else's song: that's a vote again
  await vote(s, 'Bob', 2);
  assert.equal(await title(s), 'Song B');
  assert.deepEqual((await s.state()).skip.voters, ['Bob']);
  s.stopOnline();
});

test('someone reloading doesn\'t tip the vote; someone leaving does', async () => {
  const s = await start();
  s.stopOnline(); const stopAB = s.keepOnline('Alice', 'Bob');
  await s.post('/bye', undefined, { as: 'Cara' }); // Cara closes the page for good
  await vote(s, 'Alice', 1); // 1 of 3
  await s.post('/bye', undefined, { as: 'Bob' }); await sleep(1500); await s.state('Bob'); // Bob reloads (a reload takes a second or two)
  await sleep(2000);
  assert.equal(await title(s), 'Song A', 'Bob reloading didn\'t skip it');
  // Cara drops off the online list after 10s: 1 of 2 isn't a majority. Then Bob closes for good: 1 of 1.
  await sleep(9000);
  assert.equal(await title(s), 'Song A', '1 of 2 still not enough');
  stopAB(); const stopA = s.keepOnline('Alice');
  await s.post('/bye', undefined, { as: 'Bob' });
  await waitFor(async () => (await title(s)) === 'Song B', 15000, 'Alice\'s vote to win once Bob has gone');
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

});

test('no crashes or warnings from the server', () => {
  for (const s of servers) assert.deepEqual(s.problems(), []);
});
