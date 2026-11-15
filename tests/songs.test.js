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

// (a found song's video id, from the stand-in yt-dlp: "1" + the words + 0s, see fakes/yt-dlp.js)
const found = (q, words) => q && q.url && q.url.endsWith(('1' + words.replace(/\W/g, '') + '0000000000').slice(0, 11));

test('a song name: queues the top result that isn\'t a livestream; nothing found: says so', async () => {
  const s = await start();
  await s.post('/add', { url: 'daft punk' });
  await waitFor(() => inQueue(s, q => found(q, 'daft punk')), 5000, 'the search');
  assert.ok((await s.log()).some(l => /^Alice: added "(daft punk - top result|Song 1daftpunk00)"$/.test(l)));
  await s.post('/add', { url: 'nothing' });
  await waitFor(async () => (await s.log()).includes('Alice: couldn\'t find anything for "nothing"'), 5000, 'the empty search');
  assert.equal((await s.state()).queue.length, 1, 'its "Searching" stand-in is gone');
});

test('a song name shows "Searching" in the queue straight away, and keeps its place (the order asked)', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow one' }); // takes 1.5s to search
  await s.post('/add', { url: 'fast two' }); // finds straight away
  let q = (await s.state()).queue;
  assert.equal(q[0].title, 'Searching for "slow one"…');
  assert.equal(q[0].status, 'searching');
  assert.equal(q[0].url, null, 'no link yet');
  await waitFor(async () => (await s.state()).queue.every(x => x.status !== 'searching'), 5000, 'both searches');
  q = (await s.state()).queue;
  assert.ok(found(q[0], 'slow one') && found(q[1], 'fast two'), 'in the order asked, though "fast two" was found first: ' + q.map(x => x.url).join(', '));
});

test('a song name: the result whose title matches best, not just YouTube\'s first', async () => {
  const s = await start();
  await s.post('/add', { url: 'a-ha Take On Me' }); // YouTube puts another a-ha song first
  const q = await waitFor(() => inQueue(s, x => x.status !== 'searching'), 5000, 'the search');
  assert.ok(q.url.endsWith('aha_take001'), 'Take On Me, not The Sun Always Shines on T.V.: ' + q.url);
});

test('a "Searching" stand-in can be deleted (and undone) like any song', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow gone' });
  const q = await inQueue(s, () => true);
  await s.post('/remove', { id: q.id });
  await new Promise(r => setTimeout(r, 2500)); // the search finishes meanwhile
  assert.equal((await s.state()).queue.length, 0, 'it doesn\'t come back by itself');
  await s.post('/undo', { id: q.id });
  await waitFor(() => inQueue(s, x => x.id === q.id && found(x, 'slow gone')), 5000, 'undo: back, as the song found');
});

test('a search cut short by a restart starts again', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow restart' });
  await new Promise(r => setTimeout(r, 300)); // saved
  await s.restart();
  const q = (await s.state()).queue[0];
  assert.equal(q.status, 'searching');
  await waitFor(() => inQueue(s, x => found(x, 'slow restart')), 6000, 'the search to finish after the restart');
});

test('titles with characters from outside English come through right (UTF-8)', async () => {
  const s = await start();
  await s.post('/add', { url: yt('uni_0000001') });
  const q = await waitFor(() => inQueue(s, x => x.status === 'ready'), 5000, 'the download');
  assert.equal(q.title, 'Café – Déjà Vu 🎵');
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

test('your own song: removed straight away, and only you (or the deciding voter) can undo it', async () => {
  const s = await start();
  await s.post('/add', { url: yt('mine_000001') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the song');
  await s.post('/remove', { id: q.id }, { as: 'Alice' });
  assert.equal((await s.state()).queue.length, 0, 'gone');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Bob' })).status, 403, 'Bob can\'t bring it back');
  await s.post('/undo', { id: q.id }, { as: 'Alice' });
  assert.ok(await inQueue(s, x => x.id === q.id), 'Alice can');
});

test('anyone else\'s song: a vote to remove it, shown to everyone; more than half of the people online removes it', async () => {
  const s = await start();
  for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n); // 3 people online: 2 votes needed
  const stop = s.keepOnline('Alice', 'Bob', 'Cara');
  await s.post('/add', { url: yt('vote_000001') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the song');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  let x = await inQueue(s, y => y.id === q.id);
  assert.ok(x, '1 vote of 3: still there');
  assert.deepEqual(x.removeVoters, ['Bob'], 'everyone sees who voted');
  assert.deepEqual((await inQueue(s, y => y.id === q.id)).removeVoters, ['Bob']);
  await s.post('/remove', { id: q.id, vote: false }, { as: 'Bob' });
  assert.deepEqual((await inQueue(s, y => y.id === q.id)).removeVoters, [], 'a vote can be taken back');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Cara' });
  assert.ok(!(await inQueue(s, y => y.id === q.id)), '2 of 3: removed');
  assert.ok((await s.log()).some(l => /^Cara: removed ".+" \(2 of 3 voted\)$/.test(l)), 'the log says how many voted');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Bob' })).status, 403, 'Bob (not the deciding vote) can\'t undo');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Cara' })).status, 204, 'Cara (the deciding vote) can');
  x = await inQueue(s, y => y.id === q.id);
  assert.ok(x, 'back');
  assert.deepEqual(x.removeVoters, [], 'with no votes');
  stop();
});

test('votes to remove survive a restart', async () => {
  const s = await start();
  for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n);
  await s.post('/add', { url: yt('vote_000002') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the song');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  await s.restart();
  for (const n of ['Alice', 'Bob', 'Cara']) await s.state(n);
  assert.deepEqual((await inQueue(s, y => y.id === q.id)).removeVoters, ['Bob']);
});

test('the queue can\'t be reordered by hand', async () => {
  const s = await start();
  for (const id of ['okay_000003', 'okay_000004', 'okay_000005']) await s.post('/add', { url: yt(id) }, { as: 'Bob' });
  const ids = (await s.state()).queue.map(q => q.id);
  assert.equal((await s.post('/move', { id: ids[2], to: 0 }, { as: 'Bob' })).status, 404, 'there\'s no way to move a song');
  assert.deepEqual((await s.state()).queue.map(q => q.id), ids, 'still in the order they were added');
  assert.ok(!(await s.log()).some(l => /moved/.test(l)));
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
