// ---------- Adding, downloading and removing songs ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, secs } = require('./helpers');

const servers = testServers({ after });
const start = () => servers({ initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
const inQueue = async (s, pred) => (await s.state()).queue.find(pred);
const removeSong = (s, ...what) => new Promise(resolve => require('child_process').execFile(process.execPath, ['server.js', '--remove-song', ...what],
  { cwd: s.dir, encoding: 'utf8', timeout: 30000 }, (err, stdout, stderr) => resolve({ status: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })));

describe('songs', { concurrency: true }, () => {
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

const found = (q, words) => q && q.url && q.url.endsWith(('1' + words.replace(/\W/g, '') + '0000000000').slice(0, 11));

test('a song name: the result that matches best and isn\'t a livestream (not just YouTube\'s first); nothing found: says so', async () => {
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
});

test('a song name shows "Searching" in the queue straight away, and keeps its place (the order asked)', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow one' });
  await s.post('/add', { url: 'fast two' });
  let q = (await s.state()).queue;
  assert.equal(q[0].title, 'Searching for "slow one"…');
  assert.equal(q[0].status, 'searching');
  assert.equal(q[0].url, null, 'no link yet');
  await waitFor(async () => (await s.state()).queue.every(x => x.status !== 'searching'), 5000, 'both searches');
  q = (await s.state()).queue;
  assert.ok(found(q[0], 'slow one') && found(q[1], 'fast two'), 'in the order asked, though "fast two" was found first: ' + q.map(x => x.url).join(', '));
});

test('a "Searching" stand-in can be deleted (and undone) like any song, even with a restart before the search finishes', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow gone' });
  const q = await inQueue(s, () => true);
  await s.post('/remove', { id: q.id });
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('"trash":[{'), 3000, 'it to be saved');
  await s.restart();
  await waitFor(async () => (await s.log()).includes('Alice: added "slow gone - top result"'), 6000, 'the search to finish after the restart');
  assert.equal((await s.state()).queue.length, 0, 'it doesn\'t come back by itself');
  await s.post('/undo', { id: q.id });
  await waitFor(() => inQueue(s, x => x.id === q.id && found(x, 'slow gone')), 5000, 'undo: back, as the song found');
});

test('a search cut short by a restart starts again', async () => {
  const s = await start();
  await s.post('/add', { url: 'slow restart' });
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('"searching"'), 3000, 'the search to be saved');
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
  assert.deepEqual((await s.state()).queue.map(q => q.url.slice(-11)).sort(), ['plist_00001', 'plist_00003', 'plist_00004'], 'the private one and the 4-hour one are skipped');
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (3 songs, 1 longer than 3 hours left out)'));
  await s.post('/add', { url: yt('okay_000002') + '&list=PLtest' });
  await waitFor(async () => (await s.state()).queue.length === 4, 5000, 'one more song');
});

test('a download that fails says why; YouTube\'s hiccups are retried by themselves (quietly), the rest wait for Retry', async () => {
  const s = await start();
  const cases = [
    ['fail_perm01', 'Unavailable', false], ['fail_priv01', 'Private video', false], ['fail_age001', 'Age-restricted', false],
    ['fail_memb01', 'Members only', false], ['live_000001', 'Livestreams aren\'t supported', false],
    ['fail_temp01', 'Blocked by YouTube (403)', true], ['fail_rate01', 'YouTube rate limit', true], ['fail_sign01', 'YouTube bot check', true],
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

test('longer than maxVideoHours (3 by default): refused before downloading, with the reason', async () => {
  const s = await start();
  await s.post('/add', { url: yt('long_000001') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the failure');
  assert.equal(q.error, 'Longer than 3 hours');
  assert.equal(q.retrying, false, 'for good: trying again won\'t make it shorter');
  assert.deepEqual(fs.readdirSync(path.join(s.dir, 'data', 'downloads')).filter(f => f.startsWith(q.id + '-')), [], 'nothing downloaded');
  await s.post('/add', { url: yt('okay_000003') });
  await waitFor(() => inQueue(s, x => x.url.endsWith('okay_000003') && x.status === 'ready'), 5000, 'a normal song to download');
});

test('a song name: results longer than maxVideoHours are passed over; if they all are, it says so', async () => {
  const s = await start();
  await s.post('/add', { url: 'long song' });
  const q = await waitFor(() => inQueue(s, q => q.url), 5000, 'the result');
  assert.equal(q.url.slice(-11), '2longsong00', 'the second result: the first is too long');
  const t = await servers({ config: { maxVideoHours: 0.01 }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  await t.post('/add', { url: 'long song' });
  await waitFor(async () => (await t.log()).includes('Alice: couldn\'t find anything shorter than 1 minute for "long song"'), 5000, 'the log to say so');
});

test('maxVideoHours in config.json: any number of hours, not just whole ones (1.5 = 1 hour 30 minutes)', async () => {
  for (const [maxVideoHours, text] of [[1.5, '1 hour 30 minutes'], [0.3, '18 minutes'], [1, '1 hour'], [3.75, '3 hours 45 minutes']]) {
    const s = await servers({ config: { maxVideoHours }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
    await s.post('/add', { url: yt('long_000002') });
    const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the failure');
    assert.equal(q.error, `Longer than ${text}`, `maxVideoHours ${maxVideoHours}`);
  }
  const big = await servers({ config: { maxVideoHours: 5 }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  await big.post('/add', { url: yt('long_000003') });
  await waitFor(() => inQueue(big, q => q.status === 'ready'), 5000, 'a 4-hour video to download with maxVideoHours 5');
});

test('downloadsAtOnce in config.json: how many download at the same time (the rest wait, in queue order)', async () => {
  const s = await servers({ config: { downloadsAtOnce: 1 }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  for (const id of ['slow_000001', 'slow_000002', 'slow_000003']) await s.post('/add', { url: yt(id) });
  const downloads = path.join(s.dir, 'data', 'downloads');
  let most = 0, sawWaiting = false;
  await waitFor(async () => {
    const q = (await s.state()).queue;
    most = Math.max(most, fs.readdirSync(downloads).filter(f => f.endsWith('.part')).length);
    sawWaiting ||= q.some(x => x.status === 'waiting');
    return q.length === 3 && q.every(x => x.status === 'ready');
  }, 9000, 'all three to download');
  assert.equal(most, 1, 'never more than one at a time');
  assert.ok(sawWaiting, 'the others waited their turn');
});

test('downloadAhead in config.json: only the top songs of the queue are downloaded ahead', async () => {
  const s = await servers({ config: { downloadAhead: 2 }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  for (const id of ['ahead_00001', 'ahead_00002', 'ahead_00003']) await s.post('/add', { url: yt(id) });
  await waitFor(async () => (await s.state()).queue.filter(x => x.status === 'ready').length === 2, 5000, 'the top two to download');
  await new Promise(r => setTimeout(r, 400));
  let q = (await s.state()).queue;
  assert.deepEqual(q.map(x => x.status), ['ready', 'ready', 'waiting'], 'the third waits until it\'s in the top two');
  await s.post('/remove', { id: q[0].id });
  await waitFor(() => inQueue(s, x => x.id === q[2].id && x.status === 'ready'), 5000, 'the third to download once it moved up');
});

test('a video that doesn\'t say how long it is, but turns out too long once downloaded: removed, with the reason', async () => {
  const s = await servers({ config: { maxVideoHours: 0.01 }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
  await s.post('/add', { url: yt('nolen000002') });
  const q = await waitFor(() => inQueue(s, q => q.status === 'failed'), 5000, 'the failure');
  assert.equal(q.error, 'Longer than 1 minute');
  await waitFor(() => fs.readdirSync(path.join(s.dir, 'data', 'downloads')).filter(f => f.startsWith(q.id + '-')).length === 0, 3000, 'its files deleted');
});

test('a video whose length YouTube doesn\'t say: measured from the file', async () => {
  const s = await servers();
  await s.post('/add', { url: yt('nolen000001') });
  const st = await waitFor(async () => { const x = await s.state(); return x.current && x; }, 5000, 'it to play');
  assert.equal(st.current.duration, 42, 'from ffprobe');
});

test('delete (even mid-download) and undo', async () => {
  const s = await start();
  await s.post('/add', { url: yt('slow_000001') });
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

test('undo lasts 10 minutes', async () => {
  const s = await servers({ env: { COUCHWAVE_TIME_SCALE: '0.01' }, initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) } });
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
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('"trash":[{'), 3000, 'it to be saved');
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
  assert.deepEqual((await inQueue(s, y => y.id === q.id)).removeVoters, ['Bob']);
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
  const playing = await s.post('/add', { url: yt('nowp_000001') }, { as: 'Bob' });
  assert.equal(playing.status, 409);
  assert.match(playing.text, /is playing right now$/);
  assert.equal((await s.post('/add', { url: 'https://youtu.be/link_000005?si=Zz99' }, { as: 'Bob' })).status, 409, 'a Short shared as a youtu.be link is the same video');
  await s.post('/add', { url: yt('slow_000009') }, { as: 'Bob' });
  const downloading = await s.post('/add', { url: 'https://youtu.be/slow_000009' });
  assert.equal(downloading.status, 409);
  assert.equal(downloading.text, 'That song is already in the queue', 'still downloading, so no title yet');
  assert.equal((await s.state()).queue.length, 7);
});

test('a playlist leaves out songs already in the queue or playing, and says how many', async () => {
  const s = await servers({ initial: { current: song(1, 'Playlist song 1', 'Zed', { duration: 100000, url: yt('plist_00001') }) } });
  await s.post('/add', { url: yt('plist_00003') }, { as: 'Bob' });
  await s.post('/add', { url: 'https://www.youtube.com/playlist?list=PLtest', playlist: true });
  await waitFor(async () => (await s.log()).some(l => /added playlist/.test(l)), 5000, 'the playlist');
  assert.deepEqual((await s.state()).queue.filter(q => q.by === 'Alice').map(q => q.url), [yt('plist_00004')]);
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (1 song, 1 longer than 3 hours and 2 already in the queue left out)'));
});

test('a song name whose best result is already in the queue: not added twice, and the log says so', async () => {
  const s = await start();
  await s.post('/add', { url: yt('1dupesong00') }, { as: 'Bob' });
  await s.post('/add', { url: 'dupe song' });
  await waitFor(async () => (await s.log()).some(l => /searched for "dupe song"/.test(l)), 5000, 'the search');
  assert.deepEqual((await s.state()).queue.map(q => q.by), ['Bob'], 'the "Searching" stand-in went');
  assert.ok((await s.log()).includes('Alice: searched for "dupe song": "dupe song - top result" is already in the queue'));
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

test('a playlist still being read when Couchwave restarts is read again afterwards, not lost', async () => {
  const s = await start();
  await s.post('/add', { url: 'https://www.youtube.com/playlist?list=PLslow', playlist: true });
  await s.restart();
  await waitFor(async () => (await s.log()).some(l => /added playlist/.test(l)), 8000, 'the playlist, after the restart');
  assert.ok((await s.log()).includes('Alice: added playlist "Test Playlist" (3 songs, 1 longer than 3 hours left out)'));
  assert.equal((await s.state()).queue.length, 3);
});

test('an "is adding a playlist…" stuck from before this was fixed says it didn\'t finish', async () => {
  const s = await servers({ initial: { log: [{ t: Date.now() - 60000, by: 'Alice', text: 'is adding a playlist…' }] } });
  assert.ok((await s.log()).includes('Alice: didn\'t finish adding a playlist (Couchwave restarted): add it again'));
});

test('undo won\'t put a song back if someone has added it again meanwhile', async () => {
  const s = await start();
  await s.post('/add', { url: yt('undo_000001') });
  const q = await waitFor(() => inQueue(s, q => q.url === yt('undo_000001')), 3000, 'the song');
  await s.post('/remove', { id: q.id });
  assert.equal((await s.post('/add', { url: 'https://youtu.be/undo_000001' }, { as: 'Bob' })).status, 204, 'Bob adds it again');
  const r = await s.post('/undo', { id: q.id });
  assert.equal(r.status, 409);
  assert.match(r.text, /is already in the queue$/);
  assert.equal((await s.state()).queue.filter(x => x.url === yt('undo_000001')).length, 1, 'only once');
});

test('--remove-song, for whoever runs Couchwave: by queue number, link or part of the name, straight away and without a vote', async () => {
  const s = await start();
  for (const [id, by] of [['rmsa_000001', 'Bob'], ['rmsb_000002', 'Cara'], ['rmsc_000003', 'Bob']]) await s.post('/add', { url: yt(id) }, { as: by });
  await waitFor(async () => (await s.state()).queue.filter(q => q.status === 'ready').length === 3, 5000, 'the songs');
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('Song rmsc_000003'), 3000, 'them to be saved');
  let r = await removeSong(s, 'Song rms');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /3 songs match "Song rms"\. Use its number instead:\n1\. Song rmsa_000001 \(added by Bob\)\n2\. Song rmsb_000002 \(added by Cara\)/);
  r = await removeSong(s, '2');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Done: removed "Song rmsb_000002" from the queue\./);
  assert.deepEqual((await s.state()).queue.map(q => q.title), ['Song rmsa_000001', 'Song rmsc_000003'], 'gone at once: no vote, no restart');
  assert.ok((await s.log()).includes('server: removed "Song rmsb_000002" (whoever runs Couchwave did)'), 'Activity says so');
  assert.equal((await removeSong(s, 'https://youtu.be/rmsc_000003?si=abc')).status, 0, 'by link, in any form');
  assert.equal((await removeSong(s, 'RMSA')).status, 0, 'by part of the name');
  assert.deepEqual((await s.state()).queue, []);
  r = await removeSong(s, 'not in the queue');
  assert.deepEqual([r.status, /Nothing in the queue matches "not in the queue"/.test(r.stdout)], [1, true]);
  r = await removeSong(s);
  assert.match(r.stdout, /^Usage: node server\.js --remove-song <queue number, YouTube link or part of the name>\n\nThe queue is empty\./);
  await s.post('/add', { url: yt('rmsd_000004') }, { as: 'Bob' });
  await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('rmsd_000004'), 3000, 'it to be saved');
  await s.stop();
  r = await removeSong(s, '1');
  assert.equal(r.status, 0, 'with Couchwave off too: ' + r.stdout + r.stderr);
  await s.start();
  assert.deepEqual((await s.state()).queue, []);
  assert.ok((await s.log()).some(l => /^server: removed ".*rmsd_000004.*" \(whoever runs Couchwave did\)$/.test(l)), 'Activity says so');
});
});
