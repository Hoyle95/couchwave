// History: the songs played, newest first, the last 100, kept across restarts, sent only when it changed.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { Server, song, waitFor } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
async function start(initial) { const s = new Server({ initial }); servers.push(s); return s.start(); }
const yt = id => `https://www.youtube.com/watch?v=${id}`;

test('each song that plays goes in, newest first: link, title, who asked for it and when', async () => {
  const s = await start({ queue: [song(1, 'First', 'Alice', { duration: 1, url: yt('first000001') }), song(2, 'Second', 'Bob', { duration: 100, url: yt('second00002') })] });
  const before = Date.now();
  const st = await waitFor(async () => { const x = await s.state(); return x.history.length === 2 && x; }, 8000, 'both to have played');
  assert.deepEqual(st.history.map(h => [h.title, h.by, h.url]), [['Second', 'Bob', yt('second00002')], ['First', 'Alice', yt('first000001')]]);
  assert.ok(st.history.every(h => h.t >= before - 1000 && h.t <= Date.now()), 'when each started');
  assert.ok(st.history[0].t >= st.history[1].t);
});

test('only the last 100 are kept, and they survive a restart', async () => {
  const old = Array.from({ length: 100 }, (_, i) => ({ url: yt(('old' + i).padEnd(11, '0')), title: `Old ${i}`, by: 'Zed', t: Date.now() - (i + 1) * 60000 }));
  const s = await start({ history: old, queue: [song(1, 'Newest', 'Alice', { duration: 100, url: yt('newest00001') })] });
  let st = await waitFor(async () => { const x = await s.state(); return x.history[0]?.title === 'Newest' && x; }, 6000, 'the new song to play');
  assert.equal(st.history.length, 100);
  assert.equal(st.history[1].title, 'Old 0');
  assert.equal(st.history.at(-1).title, 'Old 98', 'the oldest one dropped off');
  await new Promise(r => setTimeout(r, 1200)); // saved
  await s.restart();
  st = await s.state();
  assert.equal(st.history.length, 100);
  assert.equal(st.history[0].title, 'Newest');
});

test('sent to pages only when it changed (most checks stay small)', async () => {
  const s = await start({ queue: [] });
  const first = (await s.get('/state')).json;
  assert.ok(Array.isArray(first.history), 'the first check gets it');
  const again = (await s.get(`/state?log=${first.logRev}&chat=${first.chatRev}&history=${first.historyRev}`)).json;
  assert.equal(again.history, undefined);
});

test('no crashes or warnings from the server', () => {
  for (const s of servers) assert.deepEqual(s.problems(), []);
});
