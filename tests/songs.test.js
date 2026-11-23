// ---------- Adding, downloading and removing songs ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, secs } = require('./helpers');

const servers = testServers({ after });
const playing = { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) };
const start = (config) => servers({ config, initial: playing });
const inQueue = async (s, pred) => (await s.state()).queue.find(pred);
const found = (q, words) => q && q.url && q.url.endsWith(('1' + words.replace(/\W/g, '') + '0000000000').slice(0, 11));
const downloaded = s => fs.readdirSync(path.join(s.dir, 'data', 'downloads')).filter(f => !f.startsWith('test-'));
const saved = (s, text) => waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes(text), 3000, `"${text}" to be saved`);

describe('songs', { concurrency: true }, () => {
test('a link: queued, downloaded, and its real title (in any language) replaces the link', async () => {
  const s = await start();
  assert.equal((await s.post('/add', { url: yt('okay_000001') })).status, 204);
  const q = await waitFor(() => inQueue(s, q => q.status === 'ready'), 5000, 'the download');
  assert.equal(q.title, 'Song okay_000001');
  assert.ok((await s.log()).includes('Alice: added "Song okay_000001"'), 'log shows the title, not the link');
  assert.ok(downloaded(s).some(f => f.endsWith('.m4a')), 'the audio-only copy was made');
  await s.post('/add', { url: yt('uni_0000001') });
  const u = await waitFor(() => inQueue(s, x => x.url === yt('uni_0000001') && x.status === 'ready'), 5000, 'the second download');
  assert.equal(u.title, 'Café – Déjà Vu 🎵', 'UTF-8 comes through right');
});

test('not a YouTube link, a cut-off one, or nothing at all: refused, and nothing in Activity', async () => {
  const s = await start();
  assert.equal((await s.post('/add', { url: 'https://example.com/video' })).status, 400);
  assert.equal((await s.post('/add', { url: '   ' })).status, 400);
  for (const url of ['https://www.youtube.com/watch?v=R8wM-EaYVd', 'https://youtu.be/R8wM-Ea', 'https://youtube.com/shorts/abc123']) {
    const r = await s.post('/add', { url });
    assert.deepEqual([r.status, r.text], [400, 'That link looks cut off. Copy the whole link from YouTube again'], url);
  }
  assert.equal((await s.state()).queue.length, 0);
  assert.ok(!(await s.log()).some(l => /added/.test(l)));
});

test('a song name: the result that matches best (not just YouTube\'s first, never a livestream or one already queued); nothing found says so', async () => {
  const s = await start();
  await s.post('/add', { url: 'daft punk' });
  await waitFor(() => inQueue(s, q => found(q, 'daft punk')), 5000, 'the search');
  assert.ok((await s.log()).some(l => /^Alice: added "(daft punk - top result|Song 1daftpunk00)"$/.test(l)));
  await s.post('/add', { url: 'a-ha Take On Me' });
  const q = await waitFor(() => inQueue(s, x => x.by === 'Alice' && x.url?.includes('aha_')), 5000, 'the second search');
  assert.ok(q.url.endsWith('aha_take001'), 'Take On Me, not The Sun Always Shines on T.V.: ' + q.url);
  await s.post('/add', { url: 'nothing' });
  await waitFor(async () => (await s.log()).includes('Alice: couldn\'t find anything for "nothing"'), 5000, 'the empty search');
  assert.equal((await s.state()).queue.length, 2, 'its "Searching" stand-in is gone');
  await s.post('/add', { url: yt('1dupesong00') }, { as: 'Bob' });
  await s.post('/add', { url: 'dupe song' });
  await waitFor(async () => (await s.log()).some(l => /searched for "dupe song"/.test(l)), 5000, 'the search for a song already queued');
  assert.equal((await s.state()).queue.filter(x => x.url === yt('1dupesong00')).length, 1, 'not added twice');
  assert.ok((await s.log()).includes('Alice: searched for "dupe song": "dupe song - top result" is already in the queue'));
});

test('a song name shows "Searching" in the queue straight away, and keeps its place (the order asked)', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow one' });
  await s.post('/add', { url: 'fast two' });
  let q = (await s.state()).queue;
  assert.deepEqual([q[0].title, q[0].status, q[0].url], ['Searching for "slow one"…', 'searching', null], 'no link yet');
  await waitFor(async () => (await s.state()).queue.every(x => x.status !== 'searching'), 5000, 'both searches');
  q = (await s.state()).queue;
  assert.ok(found(q[0], 'slow one') && found(q[1], 'fast two'), 'in the order asked, though "fast two" was found first: ' + q.map(x => x.url).join(', '));
});

test('lots of searches and playlists at once: YouTube is read 3 at a time, the rest wait their turn; a full queue (500 songs) takes no more', async () => {
  const s = await start();
  for (let i = 0; i < 7; i++) await s.post('/add', { url: `slow search ${i}` }, { as: i < 4 ? 'Alice' : 'Bob' });
  await waitFor(async () => (await s.state()).queue.every(x => x.status !== 'searching'), 10000, 'all seven searches');
  const already = fs.readFileSync(path.join(s.dir, 'list-reads.log'), 'utf8').trim().split('\n').map(Number);
  assert.equal(already.length, 7);
  assert.ok(Math.max(...already) <= 2, `at most 3 at once (how many were already reading as each started: ${already})`);
  const full = await servers({ initial: { ...playing, queue: Array.from({ length: 499 }, (_, i) => ({ id: i + 2, url: yt(`full_${String(i).padStart(6, '0')}`), title: `Queued ${i}`, by: 'Bob', status: 'failed', error: 'Unavailable' })) } });
  assert.equal((await full.post('/add', { url: yt('plist_00001') + '&list=PLtest', playlist: true })).status, 204);
  await waitFor(async () => (await full.log()).includes('Alice: added playlist "Test Playlist" (1 song, 1 longer than 3 hours and 2 more than the queue has room for (500 songs) left out)'), 5000, 'the playlist, as far as it fits');
  const r = await full.post('/add', { url: yt('okay_000009') });
  assert.deepEqual([r.status, r.text], [409, 'The queue is full (500 songs). Add more once some have played']);
});

test('searches cut short by a restart start again; a "Searching" stand-in that was deleted stays deleted (Activity says what it found, not that it was added), but can still be undone', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow restart' });
  await s.post('/add', { url: 'slow gone' });
  const gone = await inQueue(s, x => /slow gone/.test(x.title));
  await s.post('/remove', { id: gone.id });
  await saved(s, '"trash":[{');
  await s.restart();
  assert.equal((await s.state()).queue[0].status, 'searching', 'still searching after the restart');
  await waitFor(() => inQueue(s, x => found(x, 'slow restart')), 6000, 'the search to finish after the restart');
  await waitFor(async () => (await s.log()).includes('Alice: searched for "slow gone" and found "slow gone - top result"'), 6000, 'the deleted one\'s search to finish too');
  assert.ok(!(await s.log()).includes('Alice: added "slow gone - top result"'), 'not "added": it isn\'t in the queue');
  assert.ok(!(await inQueue(s, x => x.id === gone.id)), 'it doesn\'t come back by itself');
  await s.post('/undo', { id: gone.id });
  await waitFor(() => inQueue(s, x => x.id === gone.id && found(x, 'slow gone')), 5000, 'undo: back, as the song found');
});

test('a playlist: every playable song (private ones, too-long ones and ones already queued or playing left out, and counted), or just the one if asked', async () => {
  const s = await start();
  await s.post('/add', { url: 'https://www.youtube.com/playlist?list=PLtest', playlist: true });
  await waitFor(async () => (await s.state()).queue.length === 3, 5000, '3 songs');
  assert.deepEqual((await s.state()).queue.map(q => q.url.slice(-11)).sort(), ['plist_00001', 'plist_00003', 'plist_00004'], 'the private one and the 4-hour one are skipped');
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (3 songs, 1 longer than 3 hours left out)'));
  await s.post('/add', { url: yt('okay_000002') + '&list=PLtest' });
  await waitFor(async () => (await s.state()).queue.length === 4, 5000, 'just the one song');

  const t = await servers({ initial: { current: song(1, 'Playlist song 1', 'Zed', { duration: 100000, url: yt('plist_00001') }) } });
  await t.post('/add', { url: yt('plist_00003') }, { as: 'Bob' });
  await t.post('/add', { url: 'https://www.youtube.com/playlist?list=PLtest', playlist: true });
  await waitFor(async () => (await t.log()).some(l => /added playlist/.test(l)), 5000, 'the playlist');
  assert.deepEqual((await t.state()).queue.filter(q => q.by === 'Alice').map(q => q.url), [yt('plist_00004')]);
  assert.ok((await t.log()).includes('Alice: added playlist "Test Playlist" (1 song, 1 longer than 3 hours and 2 already in the queue left out)'));
});

test('a big playlist: the first 100 songs, fitted in fairly around other people\'s, and only the top of the queue downloads', async () => {
  const s = await start();
  await s.post('/add', { url: yt('bobs_000001') }, { as: 'Bob' });
  await s.post('/add', { url: 'https://www.youtube.com/watch?v=bigp_000001&list=PLbig&index=1', playlist: true });
  await waitFor(async () => (await s.log()).some(l => /added playlist/.test(l)), 5000, 'the playlist');
  assert.ok((await s.log()).includes('Alice: added playlist "Big Playlist" (100 songs)'), 'the first 100 of 150');
  await s.post('/add', { url: yt('bobs_000002') }, { as: 'Bob' });
  let q = (await s.state()).queue;
  assert.equal(q.filter(x => x.by === 'Alice').length, 100);
  assert.equal(q.findIndex(x => x.url === yt('bobs_000002')), 3, 'Bob\'s next song goes 4th, not after all 100');
  q = await waitFor(async () => { const q = (await s.state()).queue; return q.filter(x => x.status === 'ready').length >= 20 && q; }, 10000, 'the top 20 to download');
  assert.ok(q.slice(21).every(x => x.status === 'waiting'), 'the rest wait until they move up (the 21st may be one that downloaded before Bob\'s song pushed it down)');
});

test('a playlist still being read when Couchwave restarts is read again afterwards; one stuck from an older version says it didn\'t finish', async () => {
  const s = await start();
  await s.post('/add', { url: 'https://www.youtube.com/playlist?list=PLslow', playlist: true });
  await s.restart();
  await waitFor(async () => (await s.log()).some(l => /added playlist/.test(l)), 8000, 'the playlist, after the restart');
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (3 songs, 1 longer than 3 hours left out)'));
  assert.equal((await s.state()).queue.length, 3);
  const old = await servers({ initial: { log: [{ t: Date.now() - 60000, by: 'Alice', text: 'is adding a playlist…' }] } });
  assert.ok((await old.log()).includes('Alice: didn\'t finish adding a playlist (Couchwave restarted): add it again'));
});

test('a download that fails says why; YouTube\'s hiccups are retried by themselves (quietly), the rest wait for Retry', async () => {
  const s = await start();
  const cases = [
    ['fail_perm01', 'Unavailable', false], ['fail_priv01', 'Private video', false], ['fail_age001', 'Age-restricted', false],
    ['fail_memb01', 'Members only', false], ['live_000001', 'Livestreams aren\'t supported', false],
    ['fail_temp01', 'Blocked by YouTube (403)', true],
  ];
  for (const [id] of cases) await s.post('/add', { url: yt(id) });
  const q = await waitFor(async () => {
    const q = (await s.state()).queue;
    return cases.every(([id]) => q.find(x => x.url === yt(id))?.status === 'failed') && q;
  }, 8000, 'every one to fail');
  for (const [id, error, retrying] of cases) {
    const x = q.find(y => y.url === yt(id));
    assert.deepEqual([x.error, x.retrying], [error, retrying], id);
  }
  const log = await s.log();
  assert.ok(log.some(l => /couldn't download .*\(Unavailable\)/.test(l)), 'failing for good is logged');
  assert.ok(!log.some(l => /couldn't download .*\((Blocked|YouTube)/.test(l)), 'the hiccups aren\'t: they\'ll try again');
  const perm = q.find(x => x.url === yt('fail_perm01'));
  await s.post('/retry', { id: perm.id });
  assert.ok((await s.log()).some(l => /^Alice: retried "/.test(l)));
  await waitFor(() => inQueue(s, x => x.id === perm.id && x.status === 'failed'), 5000, 'failing again');
});

test('YouTube pushing back (rate limit or bot check) pauses downloads for the whole room; then one song at a time tries, taking turns, until one works and the rest follow', async () => {
  const s = await servers({ config: { downloadsAtOnce: 3 }, initial: playing, env: { COUCHWAVE_TIME_SCALE: '0.01' } });
  const blocked = path.join(s.dir, 'youtube-pushes-back'), PAUSE = 60 * 1000 * 0.01, songs = ['slow_push01', 'slow_push02', 'slow_push03'];
  const tries = () => { try { return fs.readFileSync(path.join(s.dir, 'download-tries.log'), 'utf8').trim().split('\n').map(l => l.split('\t')).map(([id, t]) => ({ id, t: +t })); } catch { return []; } };
  fs.writeFileSync(blocked, 'rate');
  for (const id of songs) await s.post('/add', { url: yt(id) });
  await waitFor(() => tries().length >= 3, 8000, 'all three to try (together: each takes a moment)');
  const q = await waitFor(async () => { const q = (await s.state()).queue; return q.every(x => x.error) && q.some(x => x.status === 'failed') && q; }, 3000, 'all three to fail');
  assert.deepEqual(q.map(x => x.error), songs.map(() => 'YouTube rate limit'));
  assert.ok(q.filter(x => x.status === 'failed').every(x => x.retrying && x.retryIn >= 0), 'the page is told when each tries again');
  assert.ok((await s.log()).includes('server: YouTube asked Couchwave to slow down (YouTube rate limit), so downloads wait a minute, then go one at a time until one works'), 'Activity says why');
  fs.writeFileSync(blocked, 'bot');
  await waitFor(() => tries().length >= 5, 12000, 'two more tries');
  const t = tries();
  assert.deepEqual(t.slice(3, 5).map(x => x.id), ['slow_push01', 'slow_push02'], 'after each pause, one song tries, taking turns');
  assert.ok(t[3].t - t[2].t >= PAUSE * 0.9 && t[4].t - t[3].t >= PAUSE * 1.8, `the pause doubles each time: ${t.map(x => x.t - t[0].t)}`);
  await waitFor(async () => (await s.state()).queue.some(x => x.error === 'YouTube bot check'), 12000, 'a try that met the bot check');
  fs.rmSync(blocked);
  const unblocked = tries().length;
  await waitFor(async () => (await s.state()).queue.every(x => x.status === 'ready'), 12000, 'all three to download once one works');
  const after = tries().slice(unblocked);
  assert.ok(after[1].t - after[0].t >= 40, `on its own: the others start once it has worked (${after.map(x => x.t - after[0].t)})`);
  assert.ok((await s.log()).includes('server: downloads are back to normal: YouTube is answering again'), 'and Activity says when it\'s over');
});

test('longer than maxVideoHours (3 by default, any number of hours in config.json): taken out before downloading, and Activity says why', async () => {
  const s = await start();
  await s.post('/add', { url: yt('long_000001') });
  await waitFor(async () => (await s.log()).includes(`Alice: tried to add ${yt('long_000001')}, but it's longer than 3 hours`), 5000, 'Activity to say why');
  assert.equal(await inQueue(s, q => q.url.endsWith('long_000001')), undefined, 'not in the queue');
  assert.deepEqual(downloaded(s), [], 'nothing downloaded');
  await s.post('/add', { url: yt('okay_000003') });
  await waitFor(() => inQueue(s, x => x.url.endsWith('okay_000003') && x.status === 'ready'), 5000, 'a normal song to download');
  for (const [maxVideoHours, text] of [[1.5, '1 hour 30 minutes'], [0.3, '18 minutes'], [1, '1 hour'], [3.75, '3 hours 45 minutes']]) {
    const t = await start({ maxVideoHours });
    await t.post('/add', { url: yt('long_000002') });
    await waitFor(async () => (await t.log()).includes(`Alice: tried to add ${yt('long_000002')}, but it's longer than ${text}`), 5000, `maxVideoHours ${maxVideoHours}`);
  }
  const big = await start({ maxVideoHours: 5 });
  await big.post('/add', { url: yt('long_000003') });
  await waitFor(() => inQueue(big, q => q.status === 'ready'), 5000, 'a 4-hour video to download with maxVideoHours 5');
});

test('a song name: results longer than maxVideoHours are passed over; if they all are, it says so', async () => {
  const s = await start();
  await s.post('/add', { url: 'long song' });
  const q = await waitFor(() => inQueue(s, q => q.url), 5000, 'the result');
  assert.equal(q.url.slice(-11), '2longsong00', 'the second result: the first is too long');
  const t = await start({ maxVideoHours: 0.01 });
  await t.post('/add', { url: 'long song' });
  await waitFor(async () => (await t.log()).includes('Alice: couldn\'t find anything shorter than 1 minute for "long song"'), 5000, 'the log to say so');
});

test('a video whose length YouTube doesn\'t say: measured from the file, and taken out (files and all) if it turns out too long', async () => {
  const s = await servers();
  await s.post('/add', { url: yt('nolen000001') });
  const st = await waitFor(async () => { const x = await s.state(); return x.current && x; }, 5000, 'it to play');
  assert.equal(st.current.duration, 42, 'from ffprobe');
  const t = await start({ maxVideoHours: 0.01 });
  await t.post('/add', { url: yt('nolen000002') });
  await waitFor(async () => (await t.log()).includes('Alice: tried to add "Song nolen000002", but it\'s longer than 1 minute'), 5000, 'Activity to say why');
  assert.equal(await inQueue(t, q => q.url.endsWith('nolen000002')), undefined, 'not in the queue');
  await waitFor(() => downloaded(t).length === 0, 3000, 'its files deleted');
});

test('a too-long song left failed in the queue by an older Couchwave: taken out when it starts', async () => {
  const s = await servers({ initial: { ...playing,
    queue: [song(2, 'Old long one', 'Bob', { status: 'failed', error: 'Longer than 3 hours', file: undefined }), song(3, 'Fine one', 'Bob')] } });
  assert.deepEqual((await s.state()).queue.map(q => q.title), ['Fine one']);
  assert.ok((await s.log()).includes('Bob: tried to add "Old long one", but it\'s longer than 3 hours'));
});

test('downloadsAtOnce in config.json: how many download at the same time (the rest wait, in queue order)', async () => {
  const s = await start({ downloadsAtOnce: 1 });
  for (const id of ['slow_000001', 'slow_000002', 'slow_000003']) await s.post('/add', { url: yt(id) });
  let most = 0, sawWaiting = false;
  await waitFor(async () => {
    const q = (await s.state()).queue;
    most = Math.max(most, downloaded(s).filter(f => f.endsWith('.part')).length);
    sawWaiting ||= q.some(x => x.status === 'waiting');
    return q.length === 3 && q.every(x => x.status === 'ready');
  }, 9000, 'all three to download');
  assert.equal(most, 1, 'never more than one at a time');
  assert.ok(sawWaiting, 'the others waited their turn');
});

test('downloadAhead in config.json: only the top songs of the queue are downloaded ahead', async () => {
  const s = await start({ downloadAhead: 2 });
  for (const id of ['ahead_00001', 'ahead_00002', 'ahead_00003']) await s.post('/add', { url: yt(id) });
  await waitFor(async () => (await s.state()).queue.filter(x => x.status === 'ready').length === 2, 5000, 'the top two to download');
  await sleep(400);
  const q = (await s.state()).queue;
  assert.deepEqual(q.map(x => x.status), ['ready', 'ready', 'waiting'], 'the third waits until it\'s in the top two');
  await s.post('/remove', { id: q[0].id });
  await waitFor(() => inQueue(s, x => x.id === q[2].id && x.status === 'ready'), 5000, 'the third to download once it moved up');
});

test('delete (even mid-download) and undo; but not if someone has added the song again meanwhile', async () => {
  const s = await start();
  await s.post('/add', { url: yt('slow_000001') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'downloading'), 5000, 'the download to start');
  await s.post('/remove', { id: q.id });
  assert.equal((await s.state()).queue.length, 0);
  const entry = (await s.state()).log.find(e => e.text === `removed "${q.title}"`);
  assert.equal(entry.undo, q.id, 'the log entry has an Undo button');
  await s.post('/undo', { id: q.id });
  const back = await inQueue(s, x => x.id === q.id);
  assert.ok(back && ['waiting', 'downloading'].includes(back.status), 'back, and downloading again: ' + back?.status);
  assert.ok((await s.log()).includes(`Alice: restored "${q.title}"`));
  await waitFor(() => inQueue(s, x => x.id === q.id && x.status === 'ready'), 9000, 'it to finish downloading');

  await s.post('/remove', { id: q.id });
  assert.equal((await s.post('/add', { url: 'https://youtu.be/slow_000001' }, { as: 'Bob' })).status, 204, 'Bob adds it again');
  const r = await s.post('/undo', { id: q.id });
  assert.deepEqual([r.status, /is already in the queue$/.test(r.text)], [409, true]);
  assert.equal((await s.state()).queue.filter(x => x.url === yt('slow_000001')).length, 1, 'only once');
});

test('undo lasts 10 minutes', async () => {
  const s = await servers({ env: { COUCHWAVE_TIME_SCALE: '0.01' }, initial: playing });
  await s.post('/add', { url: yt('undo_000002') });
  const q = await waitFor(() => inQueue(s, () => true), 3000, 'the song');
  await s.post('/remove', { id: q.id });
  assert.ok((await s.state()).log.some(e => e.undo === q.id), 'Undo shows straight away');
  await waitFor(async () => !(await s.state()).log.some(e => e.undo === q.id), 12000, 'the Undo button to go after 10 (sped-up) minutes');
  await s.post('/undo', { id: q.id });
  assert.equal((await s.state()).queue.length, 0, 'too late to bring it back');
});

test('your own song: removed straight away, and only you can undo it, even after a restart', async () => {
  const s = await start();
  await s.post('/add', { url: yt('mine_000001') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, x => x.status === 'ready'), 5000, 'the song to download');
  await s.post('/remove', { id: q.id }, { as: 'Alice' });
  assert.equal((await s.state()).queue.length, 0, 'gone');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Bob' })).status, 403, 'Bob can\'t bring it back');
  await saved(s, '"trash":[{');
  await s.restart();
  assert.ok((await s.state()).log.some(e => e.undo === q.id), 'the Undo button is still there after a restart');
  assert.equal((await s.post('/undo', { id: q.id }, { as: 'Bob' })).status, 403, 'still not for Bob');
  await s.post('/undo', { id: q.id }, { as: 'Alice' });
  assert.equal((await inQueue(s, x => x.id === q.id))?.status, 'ready', 'Alice can, and it\'s ready to play without downloading again');
});

test('anyone else\'s song: a vote to remove it, shown to everyone; 60% of the people online removes it, for good (no Undo)', async () => {
  const s = await start();
  const stop = await s.keepOnline('Alice', 'Bob', 'Cara');
  await s.post('/add', { url: yt('vote_000001') }, { as: 'Alice' });
  const q = await waitFor(() => inQueue(s, () => true), 5000, 'the song');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  const x = await inQueue(s, y => y.id === q.id);
  assert.ok(x, '1 vote of 3: still there');
  assert.deepEqual(x.removeVoters, ['Bob'], 'everyone sees who voted');
  await s.post('/remove', { id: q.id, vote: false }, { as: 'Bob' });
  assert.deepEqual((await inQueue(s, y => y.id === q.id)).removeVoters, [], 'a vote can be taken back');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Cara' });
  assert.ok(!(await inQueue(s, y => y.id === q.id)), '2 of 3: removed');
  assert.ok((await s.log()).some(l => /^Cara: removed ".+" \(2 of 3 voted\)$/.test(l)), 'the log says how many voted');
  assert.ok(!(await s.state()).log.some(e => e.undo === q.id), 'voted out: no Undo button for anyone');
  for (const who of ['Cara', 'Bob', 'Alice']) await s.post('/undo', { id: q.id }, { as: who });
  assert.ok(!(await inQueue(s, y => y.id === q.id)), 'not the deciding voter, the others, or whoever added it can bring it back');
  stop();
});

test('people leaving can tip a vote to remove (votes only count while online)', async () => {
  const s = await start();
  await s.post('/add', { url: yt('vote_000003') }, { as: 'Alice' });
  const q = await waitFor(() => s.queued(() => true, 'Bob'), 5000, 'the song');
  const stopAll = await s.keepOnline('Bob', 'Cara', 'Dan');
  await s.post('/remove', { id: q.id, vote: true }, { as: 'Bob' });
  await waitFor(async () => (await s.state('Bob')).users.join() === 'Bob,Cara,Dan', secs(15), 'Alice to drop off');
  assert.ok(await s.queued(y => y.id === q.id, 'Bob'), '1 of 3: still there');
  stopAll(); const stopBob = await s.keepOnline('Bob');
  await waitFor(async () => !(await s.queued(y => y.id === q.id, 'Bob')), secs(20), 'the song to be removed once they\'ve gone');
  assert.ok((await s.log('Bob')).some(l => /^Bob: removed "/.test(l)), 'by Bob\'s vote');
  stopBob();
});

test('the queue\'s order: people take turns (one person\'s pile doesn\'t keep everyone waiting), and it can\'t be reordered by hand', async () => {
  const s = await start();
  for (const id of ['fair_000001', 'fair_000002', 'fair_000003']) await s.post('/add', { url: yt(id) }, { as: 'Alice' });
  await s.post('/add', { url: yt('fair_000004') }, { as: 'Bob' });
  const q = (await s.state()).queue;
  assert.deepEqual(q.map(x => x.by), ['Alice', 'Bob', 'Alice', 'Alice'], 'Bob goes second, not last');
  assert.equal((await s.post('/move', { id: q[3].id, to: 0 }, { as: 'Alice' })).status, 404, 'there\'s no way to move a song');
  assert.deepEqual((await s.state()).queue.map(x => x.id), q.map(x => x.id), 'still in the same order');
});

test('every kind of YouTube link is stored as one standard link, and a song already queued or playing can\'t go in twice', async () => {
  const s = await servers({ initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000, url: yt('nowp_000001') }) } });
  for (const [link, id] of [['https://youtu.be/link_000001?si=abc', 'link_000001'], ['https://www.youtube.com/shorts/link_000002', 'link_000002'],
    ['https://music.youtube.com/watch?v=link_000003&feature=share', 'link_000003'], ['https://m.youtube.com/watch?feature=x&v=link_000004', 'link_000004'],
    ['https://youtube.com/shorts/link_000005?si=Ab12Cd34', 'link_000005'], ['https://youtu.be/link_000006?si=Ab12Cd34&t=42', 'link_000006']]) {
    assert.equal((await s.post('/add', { url: link })).status, 204, link);
    assert.ok(await inQueue(s, q => q.url === yt(id)), `${link} is stored as ${yt(id)}`);
  }
  const again = await s.post('/add', { url: 'https://www.youtube.com/shorts/link_000001' }, { as: 'Bob' });
  assert.equal(again.status, 409, 'the same song, as a different kind of link');
  assert.match(again.text, /is already in the queue$/);
  const nowPlaying = await s.post('/add', { url: yt('nowp_000001') }, { as: 'Bob' });
  assert.equal(nowPlaying.status, 409);
  assert.match(nowPlaying.text, /is playing right now$/);
  assert.equal((await s.post('/add', { url: 'https://youtu.be/link_000005?si=Zz99' }, { as: 'Bob' })).status, 409, 'a Short shared as a youtu.be link is the same video');
  await s.post('/add', { url: yt('slow_000009') }, { as: 'Bob' });
  const downloading = await s.post('/add', { url: 'https://youtu.be/slow_000009' });
  assert.equal(downloading.status, 409);
  assert.equal(downloading.text, 'That song is already in the queue', 'still downloading, so no title yet');
  assert.equal((await s.state()).queue.length, 7);
});

test('adding songs has a speed limit: 10 a minute each, then a polite refusal (others can still add)', async () => {
  const s = await start();
  for (let i = 0; i < 10; i++) assert.equal((await s.post('/add', { url: yt(`rate_00000${i}`) })).status, 204);
  const r = await s.post('/add', { url: 'one more song' });
  assert.equal(r.status, 429);
  assert.match(r.text, /^Slow down a little/);
  assert.equal((await s.post('/add', { url: yt('rate_000010') }, { as: 'Bob' })).status, 204, 'Bob isn\'t affected');
  assert.equal((await s.state()).queue.length, 11);
});
});
