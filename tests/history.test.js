// ---------- History ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { testServers, song, yt, waitFor } = require('./helpers');

const servers = testServers({ after });
const start = initial => servers({ initial });

describe('history', { concurrency: true }, () => {
test('each song that plays goes in, newest first: link, title, who asked for it, when, and how long it is', async () => {
  const s = await start({ queue: [song(1, 'First', 'Alice', { duration: 1, url: yt('first000001') }), song(2, 'Second', 'Bob', { duration: 100, url: yt('second00002') })] });
  const before = Date.now();
  const st = await waitFor(async () => { const x = await s.state(); return x.history.length === 2 && x; }, 8000, 'both to have played');
  assert.deepEqual(st.history.map(h => [h.title, h.by, h.url, h.duration]), [['Second', 'Bob', yt('second00002'), 100], ['First', 'Alice', yt('first000001'), 1]]);
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
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('"Newest"'), 3000, 'it to be saved');
  await s.restart();
  st = await s.state();
  assert.equal(st.history.length, 100);
  assert.equal(st.history[0].title, 'Newest');
});

});
