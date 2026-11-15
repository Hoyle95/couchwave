// Adding songs (links, searches, playlists), downloads, failures and retries, deleting with undo,
// reordering and the fair queue. yt-dlp is a stand-in (fakes/yt-dlp.js): the video id decides what happens.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { Server, song, waitFor } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
// A server with a long song already playing, so added songs stay in the queue.
async function start() {
  const s = new Server({ initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  servers.push(s);
  return s.start();
}
const yt = id => `https://www.youtube.com/watch?v=${id}`;
const inQueue = async (s, pred) => (await s.state()).queue.find(pred);

test('a link: queued, downloaded, and its real title replaces the link', async () => {
  const s = await start();
  assert.equal((await s.post('/add', { url: yt('okay_000001') })).status, 204);
  const q = await waitFor(() => inQueue(s, q => q.status === 'ready'), 5000, 'the download');
  assert.equal(q.title, 'Song okay_000001');
  assert.ok((await s.log()).includes('Alice: added "Song okay_000001"'), 'log shows the title, not the link');
  assert.ok(fs.readdirSync(path.join(s.dir, 'data', 'downloads')).some(f => f.endsWith('.m4a')), 'the audio-only copy was made');
});

test('not a YouTube link, or nothing at all: refused', async () => {
  const s = await start();
  assert.equal((await s.post('/add', { url: 'https://example.com/video' })).status, 400);
  assert.equal((await s.post('/add', { url: '   ' })).status, 400);
  assert.equal((await s.state()).queue.length, 0);
});

test('a song name: queues the top result that isn\'t a livestream', async () => {
  const s = await start();
  await s.post('/add', { url: 'daft punk' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the search');
  assert.equal(q.title, 'daft punk - top result');
  assert.ok((await s.log()).includes('Alice: added "daft punk - top result"'));
  await s.post('/add', { url: 'nothing' });
  await waitFor(async () => (await s.log()).includes('Alice: couldn\'t find anything for "nothing"'), 5000, 'the empty search');
});

test('a playlist: every playable song (private ones skipped), or just the one if asked', async () => {
  const s = await start();
  await s.post('/add', { url: 'https://www.youtube.com/playlist?list=PLtest', playlist: true });
  await waitFor(async () => (await s.state()).queue.length === 3, 5000, '3 songs');
  // (by video, not title: a song that finishes downloading takes the title the download reports)
  assert.deepEqual((await s.state()).queue.map(q => q.url.slice(-11)).sort(), ['plist_00001', 'plist_00003', 'plist_00004'], 'the private one is skipped');
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (3 songs)'));
  await s.post('/add', { url: yt('okay_000002') + '&list=PLtest' }); // playlist: false -> just this song
  await waitFor(async () => (await s.state()).queue.length === 4, 5000, 'one more song');
});

test('an unavailable video fails for good (with a reason); Retry tries again', async () => {
  const s = await start();
  await s.post('/add', { url: yt('fail_perm01') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the failure');
  assert.equal(q.error, 'Unavailable');
  assert.equal(q.retrying, false);
  assert.ok((await s.log()).some(l => /couldn't download .*\(Unavailable\)/.test(l)));
  await s.post('/retry', { id: q.id });
  assert.ok((await s.log()).some(l => /Alice: retried/.test(l)));
  await waitFor(() => inQueue(s, x => x.id === q.id && x.status === 'failed'), 5000, 'failing again');
});

test('YouTube refusing once (403) is retried by itself, quietly', async () => {
  const s = await start();
  await s.post('/add', { url: yt('fail_temp01') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the first failure');
  assert.equal(q.retrying, true, 'shows as retrying');
  assert.equal(q.error, 'Blocked by YouTube (403)');
  assert.ok(!(await s.log()).some(l => /couldn't download/.test(l)), 'not logged yet: it\'ll try again');
});

test('a livestream is refused', async () => {
  const s = await start();
  await s.post('/add', { url: yt('live_000001') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the failure');
  assert.equal(q.error, "Livestreams aren't supported");
});

test('a video whose length YouTube doesn\'t say: measured from the file', async () => {
  const s = new Server(); servers.push(s); await s.start(); // nothing playing: it plays as soon as it's ready
  await s.post('/add', { url: yt('nolen000001') });
  const st = await waitFor(async () => { const x = await s.state(); return x.current && x; }, 5000, 'it to play');
  assert.equal(st.current.duration, 42, 'from ffprobe');
});

test('delete (even mid-download) and undo', async () => {
  const s = await start();
  await s.post('/add', { url: yt('slow_000001') }); // takes 5 seconds
  const q = await waitFor(() => inQueue(s, q => q.status === 'downloading'), 5000, 'the download to start');
  await s.post('/remove', { id: q.id });
  assert.equal((await s.state()).queue.length, 0);
  const st = await s.state();
  const entry = st.log.find(e => e.text === `removed "${q.title}"`);
  assert.equal(entry.undo, q.id, 'the log entry has an Undo button');
  await s.post('/undo', { id: q.id });
  const back = await inQueue(s, x => x.id === q.id);
  assert.ok(back, 'back in the queue');
  assert.ok(['waiting', 'downloading'].includes(back.status), 'downloading again: ' + back.status);
  assert.ok((await s.log()).includes(`Alice: restored "${q.title}"`));
  await waitFor(() => inQueue(s, x => x.id === q.id && x.status === 'ready'), 9000, 'it to finish downloading');
});

test('only whoever added a song can delete it, or undo deleting it', async () => {
  const s = await start();
  await s.post('/add', { url: yt('mine_000001') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the song');
  const r = await s.post('/remove', { id: q.id }, { as: 'Bob' });
  assert.equal(r.status, 403, 'Bob is refused');
  assert.ok(await inQueue(s, x => x.id === q.id), 'still in the queue');
  assert.ok(!(await s.log()).some(l => /removed/.test(l)), 'nothing logged');
  await s.post('/remove', { id: q.id }, { as: 'Alice' });
  assert.equal((await s.state()).queue.length, 0, 'Alice can');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Bob' })).status, 403, 'Bob can\'t bring it back either');
  assert.equal((await s.state()).queue.length, 0);
  await s.post('/undo', { id: q.id }, { as: 'Alice' });
  assert.ok(await inQueue(s, x => x.id === q.id), 'Alice can');
});

test('drag to reorder', async () => {
  const s = await start();
  for (const id of ['okay_000003', 'okay_000004', 'okay_000005']) await s.post('/add', { url: yt(id) }, { as: 'Bob' });
  let ids = (await s.state()).queue.map(q => q.id);
  await s.post('/move', { id: ids[2], to: 0 }, { as: 'Bob' });
  const now = (await s.state()).queue.map(q => q.id);
  assert.deepEqual(now, [ids[2], ids[0], ids[1]]);
  assert.ok((await s.log()).some(l => /Bob: moved .* to #1/.test(l)));
});

test('fair queue: one person\'s pile of songs doesn\'t keep everyone else waiting', async () => {
  const s = await start();
  for (const id of ['fair_000001', 'fair_000002', 'fair_000003']) await s.post('/add', { url: yt(id) }, { as: 'Alice' });
  await s.post('/add', { url: yt('fair_000004') }, { as: 'Bob' });
  const by = (await s.state()).queue.map(q => q.by);
  assert.deepEqual(by, ['Alice', 'Bob', 'Alice', 'Alice'], 'Bob goes second, not last');
});

test('no crashes or warnings from the server', () => {
  for (const s of servers) assert.deepEqual(s.problems(), []);
});
