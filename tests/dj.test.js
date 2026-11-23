// ---------- The DJ ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, secs } = require('./helpers');

const servers = testServers({ after });
const start = (initial = { here: {} }) => servers({ initial: { ...initial, history: (initial.history || []).map(h => ({ duration: 200, ...h })) } });
const CHECKS = secs(5);
const vid = q => (/v=([\w-]{11})/.exec(q.url || '') || [])[1];
const say = (s, as, text) => s.post('/chat', { text }, { as });
const djSongs = async s => (await s.state()).queue.filter(q => q.by === 'DJ');
const djCount = n => async s => (await djSongs(s)).length >= n;
async function aliceSong(s, id) {
  await s.post('/add', { url: yt(id) }, { as: 'Alice' });
  await waitFor(async () => (await s.state()).history?.some(h => h.url.endsWith(id)), 12000, 'Alice\'s song to play');
}

describe('the DJ', { concurrency: true }, () => {
  test('off by default; !dj on / !dj off / !dj answer in chat, are logged, aren\'t posted themselves, and on/off is remembered', async () => {
    const s = await start({ here: {}, history: [{ url: yt('alic_000001'), title: 'Song alic_000001', by: 'Alice', t: Date.now() }] });
    await sleep(CHECKS);
    assert.deepEqual([(await s.state()).dj, (await s.state()).queue.length], [false, 0], 'off by default: an empty queue stays empty');
    await say(s, 'Bob', '!dj');
    let st = await s.state();
    assert.match(st.chat.at(-1).text, /The DJ is off/);
    assert.equal(st.chat.at(-1).by, 'DJ');
    await say(s, 'Bob', '!DJ on');
    st = await s.state();
    assert.equal(st.dj, true);
    assert.match(st.chat.find(m => /DJ on!/.test(m.text))?.text || '', /up to 10 songs/);
    assert.ok((await s.log()).includes('Bob: turned the DJ on'));
    assert.ok(!st.chat.some(m => /^!dj/i.test(m.text)), 'commands aren\'t posted as messages');
    await say(s, 'Cara', '!dj on');
    assert.match((await s.state()).chat.at(-1).text, /already on/);
    await say(s, 'Cara', '!dj off');
    st = await s.state();
    assert.equal(st.dj, false);
    assert.ok((await s.log()).includes('Cara: turned the DJ off'));
    await say(s, 'Cara', '!djembe lessons anyone?');
    assert.equal((await s.state()).chat.at(-1).text, '!djembe lessons anyone?');
    await s.restart();
    assert.equal((await s.state()).dj, false, 'off, after a restart');
    await say(s, 'Bob', '!dj on');
    await s.restart();
    assert.equal((await s.state()).dj, true, 'on, after a restart');
  });

  test('keeps up to 10 songs queued, only from what people asked for (never its own picks), all between 1 and 20 minutes long', async () => {
    const now = Date.now(), asked = ['hist_000001', 'hist_000002', 'hist_000003', 'hist_000004'];
    const s = await start({
      here: {}, current: song(1, 'Song play_000001', 'Alice', { duration: 10000, url: yt('play_000001') }),
      history: [{ url: yt('play_000001'), title: 'Song play_000001', by: 'Alice', t: now },
        ...asked.map((id, i) => ({ url: yt(id), title: `Song ${id}`, by: i % 2 ? 'Bob' : 'Alice', t: now - (i + 1) * 60000 }))],
    });
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(10)(s), 20000, '10 DJ songs');
    const mine = await djSongs(s);
    assert.equal(new Set(mine.map(vid)).size, 10, 'no repeats');
    assert.ok(!mine.some(q => /Full Album|Too Short|Too Long/.test(q.title)), 'not 25 minutes, 30 seconds, or an album');
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added'));
    assert.equal(picks.length, 10);
    assert.ok(picks.some(l => /Fourth Band - Long Song/.test(l)), 'a 15-minute song is fine:\n' + picks.join('\n'));
    assert.ok(picks.every(l => /\(like "Song (play|hist)_00000\d", from (Alice|Bob)\)$/.test(l)), 'every pick is like a song a person asked for:\n' + picks.join('\n'));
    await sleep(CHECKS);
    assert.equal((await djSongs(s)).length, 10, 'and no more');
  });

  test('takes turns: every song people asked for in the whole history is a starting point once, in a random order, before any is used again', async () => {
    const now = Date.now(), asked = Array.from({ length: 12 }, (_, i) => `hist_${String(i + 1).padStart(6, '0')}`);
    const s = await start({
      here: {}, current: song(1, 'Song play_000001', 'Zed', { duration: 100000, url: yt('play_000001') }),
      history: asked.map((id, i) => ({ url: yt(id), title: `Song ${id}`, by: i % 2 ? 'Bob' : 'Alice', t: now - (i + 1) * 60000 })),
    });
    await say(s, 'Alice', '!dj on');
    const starts = async () => {
      const each = (await s.log()).filter(l => l.startsWith('DJ: added')).map(l => (/\(like "Song (hist_\d+)"/.exec(l) || [])[1]);
      return each.filter((id, i) => id !== each[i - 1]);
    };
    for (let round = 0; round < 3; round++) {
      await waitFor(() => djCount(10)(s), 30000, `10 DJ songs, round ${round + 1}`);
      if ((await starts()).length >= 12) break;
      for (const q of await djSongs(s)) await s.post('/remove', { id: q.id, vote: true });
    }
    const used = (await starts()).slice(0, 12);
    assert.equal(used.length, 12, `12 starting points used: ${used}`);
    assert.deepEqual([...used].sort(), asked, 'each of the 12 once, the oldest too, before any is used again');
  });

  test('never rushes YouTube: a Mix at most every 10 seconds, even when its songs keep being voted out, and no more than 60 an hour', async () => {
    const SCALE = 0.005, GAP = 10000 * SCALE, HOUR = 3600000 * SCALE, now = Date.now();
    const seeds = Array.from({ length: 8 }, (_, i) => `many_${String(i + 1).padStart(6, '0')}`);
    const s = await servers({ env: { COUCHWAVE_TIME_SCALE: String(SCALE) }, initial: {
      current: song(1, 'Song play_000001', 'Zed', { duration: 100000, url: yt('play_000001') }),
      history: seeds.map((id, i) => ({ url: yt(id), title: `Song ${id}`, by: 'Alice', t: now - (i + 1) * 60000, duration: 200 })),
    } });
    const reads = () => { try { return fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim().split('\n').map(l => Number(l.split('\t')[1])); } catch { return []; } };
    const on = Date.now();
    await say(s, 'Alice', '!dj on');
    for (const end = Date.now() + HOUR + 2000; Date.now() < end; await sleep(30)) {
      for (const q of await djSongs(s)) await s.post('/remove', { id: q.id, vote: true });
    }
    const r = reads(), within = span => r.filter(t => t < on + span).length;
    assert.ok(within(20 * GAP) <= 21, `a Mix at most every ${GAP} ms (at this clock): ${within(20 * GAP)} in the first ${20 * GAP} ms, of ${r.length} reads`);
    assert.ok(within(HOUR) <= 60, `no more than 60 in the first hour (at this clock): ${within(HOUR)}`);
  });

  test('run out of ideas: asks in the chat (once), and carries on as soon as someone adds a song', async () => {
    const seed = 'aaaa_000001', fromMix = n => (n + require('crypto').createHash('md5').update(seed).digest('hex')).slice(0, 11);
    const now = Date.now();
    const s = await start({ here: {}, history: [
      { url: yt(seed), title: `Song ${seed}`, by: 'Alice', t: now },
      ...['a', 'b', 'e', 'f'].map((n, i) => ({ url: yt(fromMix(n)), title: `DJ pick ${n}`, by: 'DJ', t: now - (i + 1) * 60000 })),
    ] });
    await say(s, 'Bob', '!dj on');
    await waitFor(async () => (await s.state()).chat.some(m => m.by === 'DJ' && /run out of new songs/.test(m.text)), 8000, 'the DJ to ask');
    await sleep(CHECKS);
    assert.equal((await s.state()).chat.filter(m => /run out of new songs/.test(m.text)).length, 1, 'once');
    assert.equal((await djSongs(s)).length, 0, 'and it doesn\'t pick from its own songs instead');
    await s.post('/add', { url: yt('bobs_000009') }, { as: 'Bob' });
    await waitFor(async () => (await s.state()).history.some(h => h.url.endsWith('bobs_000009')), 12000, 'Bob\'s song to play');
    const t = Date.now();
    await waitFor(async () => (await s.log()).some(l => /^DJ: added ".+" \(like (".+"|a song), from Bob\)$/.test(l)), secs(60), 'the DJ to carry on from Bob\'s song');
    assert.ok(Date.now() - t < secs(20), `picked up in ${((Date.now() - t) / secs(1)).toFixed(1)} (server) seconds, not after its 30-second wait`);
  });

  test('only songs that have played are starting points: nothing played yet, it asks for a song (once), even with one waiting in the queue', async () => {
    const s = await start({ here: {}, current: song(1, 'Playing now', 'Zed', { duration: 100000 }) });
    const asked = () => { try { return fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim(); } catch { return ''; } };
    await say(s, 'Bob', '!dj on');
    await s.post('/add', { url: yt('bobs_000005') }, { as: 'Bob' });
    await sleep(CHECKS);
    assert.equal(asked(), '', 'nothing asked about the song still waiting');
    assert.equal((await djSongs(s)).length, 0);
    assert.equal((await s.state()).chat.filter(m => m.by === 'DJ' && /Nothing to go on yet: add a song/.test(m.text)).length, 1, 'asked for a song, once');
    await s.post('/skip', { id: 1 }, { as: 'Bob' });
    await s.post('/skip', { id: 1 }, { as: 'Alice' });
    await waitFor(async () => (await s.log()).some(l => /^DJ: added .* from Bob\)$/.test(l)), 12000, 'the DJ to go on Bob\'s song once it plays');
  });

  test('always after people\'s songs: a song added later still goes ahead of the DJ\'s', async () => {
    const s = await start();
    await aliceSong(s, 'play_000003');
    await s.post('/add', { url: yt('bobs_000001') }, { as: 'Bob' });
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(3)(s), 20000, 'DJ songs');
    await s.post('/add', { url: yt('cara_000001') }, { as: 'Cara' });
    await s.post('/add', { url: yt('bobs_000002') }, { as: 'Bob' });
    const q = (await s.state()).queue;
    const firstDj = q.findIndex(x => x.by === 'DJ');
    assert.deepEqual(q.slice(0, firstDj).map(x => x.by), ['Bob', 'Cara', 'Bob'], 'people first, taking turns');
    assert.ok(q.slice(firstDj).every(x => x.by === 'DJ'), 'then the DJ\'s');
  });

  test('the DJ\'s songs: removing one from the queue, or skipping the one playing, is a vote; !dj off leaves the rest queued', async () => {
    const s = await start({ here: {}, current: song(1, 'Song alic_000004', 'Alice', { duration: 1, url: yt('alic_000004') }),
      history: [{ url: yt('alic_000004'), title: 'Song alic_000004', by: 'Alice', t: Date.now() },
        { url: yt('bobs_000004'), title: 'Song bobs_000004', by: 'Bob', t: Date.now() - 60000 }] });
    const stop = await s.keepOnline('Alice', 'Bob', 'Cara', 'Dan');
    await say(s, 'Bob', '!dj on');
    const [first] = await waitFor(async () => { const d = await djSongs(s); return d.length && d; }, 8000, 'a DJ song');
    await s.post('/remove', { id: first.id, vote: true }, { as: 'Cara' });
    assert.deepEqual((await djSongs(s)).find(q => q.id === first.id)?.removeVoters, ['Cara'], 'one vote: still there, and shown');
    for (const who of ['Bob', 'Dan']) await s.post('/remove', { id: first.id, vote: true }, { as: who });
    assert.ok(!(await djSongs(s)).some(q => q.id === first.id), '3 of 4: removed');
    assert.ok(!(await s.state('Dan')).log.some(e => e.undo === first.id), 'voted out: no Undo');
    await s.post('/undo', { id: first.id }, { as: 'Dan' });
    assert.ok(!(await djSongs(s)).some(q => q.id === first.id), 'not even for the deciding voter');
    const playing = await waitFor(async () => { const st = await s.state('Dan'); return st.current?.by === 'DJ' && st.current; }, 15000, 'a DJ song to play');
    await s.post('/skip', { id: playing.id }, { as: 'Dan' });
    const st = await s.state('Dan');
    assert.equal(st.current?.id, playing.id, 'one vote isn\'t enough, even for the DJ\'s song');
    assert.deepEqual(st.skip.voters, ['Dan']);
    for (const who of ['Cara', 'Bob']) await s.post('/skip', { id: playing.id }, { as: who });
    assert.notEqual((await s.state()).current?.id, playing.id, 'skipped by the vote');
    assert.ok((await s.log()).some(l => /^: ".+" was skipped \(\d of \d voted\)$/.test(l)), 'logged as a vote');
    await waitFor(() => djCount(1)(s), 15000, 'the DJ to have a song queued again');
    await say(s, 'Bob', '!dj off');
    const kept = (await djSongs(s)).length;
    assert.ok(kept > 0, 'off: what it queued stays, until it\'s voted out');
    const said = (await s.state()).chat.at(-1).text;
    assert.match(said, /DJ off: I won't add any more\. My \d+ songs? already queued stays? \(you can vote them out of the queue\)/);
    assert.equal(Number(/My (\d+) song/.exec(said)[1]), kept, 'it says how many it left');
    const picks = async () => (await s.log()).filter(l => l.startsWith('DJ: added')).length, before = await picks();
    await sleep(CHECKS);
    assert.equal(await picks(), before, '...and it doesn\'t add any more');
    stop();
  });

  test('songs saved as Shorts links are starting points too (as long as they have a Mix)', async () => {
    const s = await start({ here: {}, history: [{ url: 'https://www.youtube.com/shorts/shmu_000001', title: 'Song shmu_000001', by: 'Alice', t: Date.now() }] });
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(1)(s), 8000, 'a DJ song');
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added'));
    assert.ok(picks.length && picks.every(l => / \(like "Song shmu_000001", from Alice\)$/.test(l)), picks.join('\n'));
    assert.ok(!(await djSongs(s)).some(q => vid(q) === 'shmu_000001'), 'not the Short itself again');
  });

  test('videos that aren\'t music have no Mix: says so once, never asks YouTube about them again, and carries on from music', async () => {
    const now = Date.now(), notMusic = ['nomx_000001', 'nomx_000002'];
    const s = await start({ here: {}, history: notMusic.map((id, i) => ({ url: yt(id), title: `Not music ${id}`, by: 'Alice', t: now - i * 60000 })) });
    const asked = () => { try { return fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim().split('\n').map(l => l.split('\t')[0]); } catch { return []; } };
    await say(s, 'Bob', '!dj on');
    await waitFor(async () => (await s.state()).chat.some(m => m.by === 'DJ' && /no Mix for the other videos/.test(m.text)), 8000, 'the DJ to say it needs music');
    assert.deepEqual(asked().sort(), notMusic, 'asked YouTube once about each');
    await sleep(secs(32));
    assert.deepEqual(asked().sort(), notMusic, 'and not again, even after its 30-second wait');
    await s.post('/add', { url: yt('musc_000001') }, { as: 'Cara' });
    await waitFor(() => djCount(1)(s), 8000, 'the DJ to carry on from Cara\'s song');
    assert.ok(!asked().slice(2).some(id => id.startsWith('nomx')), 'still never asked about the non-music ones again');
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added'));
    assert.ok(picks.every(l => / \(like (".+"|a song), from Cara\)$/.test(l)), 'every pick is like Cara\'s song, never its own:\n' + picks.join('\n'));
    assert.equal((await s.state()).chat.filter(m => /no Mix for the other videos/.test(m.text)).length, 1, 'said once');
  });

  test('a song of its own that can never be downloaded: the DJ drops it, so it doesn\'t sit in the queue, and doesn\'t pick it again', async () => {
    const s = await start({ here: {}, current: song(1, 'Playing now', 'Zed', { duration: 100000 }),
      queue: [song(2, 'Song mine_000001', 'Alice', { status: 'waiting', file: undefined, url: yt('fail_perm02') }),
        song(3, 'Song djsg_000001', 'DJ', { status: 'waiting', file: undefined, url: yt('fail_perm03') })] });
    await waitFor(async () => (await s.log()).includes('DJ: dropped "Song djsg_000001": it couldn\'t be downloaded (Unavailable)'), 8000, 'the DJ to drop it');
    assert.ok(!(await s.state()).queue.some(x => x.id === 3), 'gone from the queue');
    await waitFor(async () => (await s.state()).queue.find(x => x.id === 2)?.status === 'failed', 8000, 'someone else\'s to fail too');
    await sleep(500);
    assert.equal((await s.state()).queue.find(x => x.id === 2)?.status, 'failed', 'someone else\'s stays, with its Retry button');
    const d = await start({ here: {}, current: song(1, 'Playing now', 'Zed', { duration: 100000 }),
      history: [{ url: yt('brkn_000001'), title: 'Song brkn_000001', by: 'Alice', t: Date.now() }] });
    await say(d, 'Bob', '!dj on');
    await waitFor(async () => (await d.log()).some(l => /^DJ: dropped "Broken Band - Never Downloads brkn_000001"/.test(l)), 15000, 'the DJ to pick the broken one, and drop it');
    await sleep(CHECKS);
    assert.equal((await d.log()).filter(l => /^DJ: added "Broken Band/.test(l)).length, 1, 'picked once, not again and again');
  });

  test('only songs between 1 and 20 minutes are starting points: says so if that\'s all there is, and goes on from one once there is one', async () => {
    const now = Date.now();
    const s = await start({ here: {}, history: [
      { url: yt('long_000001'), title: 'Song long_000001', by: 'Bob', t: now, duration: 7260 },
      { url: yt('shrt_000001'), title: 'Song shrt_000001', by: 'Bob', t: now - 60000, duration: 30 },
    ] });
    const asked = () => { try { return fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim().split('\n').map(l => l.split('\t')[0]); } catch { return []; } };
    await say(s, 'Bob', '!dj on');
    await waitFor(async () => (await s.state()).chat.some(m => m.by === 'DJ' && /between 1 and 20 minutes long/.test(m.text)), 8000, 'the DJ to say it needs a song of the right length');
    assert.deepEqual(asked(), [], 'it didn\'t ask YouTube for songs like them');
    await aliceSong(s, 'musc_000003');
    assert.equal((await s.state()).history.find(h => h.url.endsWith('musc_000003')).duration, 200, 'the history keeps how long it is');
    await waitFor(() => djCount(1)(s), 8000, 'the DJ to carry on from Alice\'s song');
    assert.ok(asked().every(id => id === 'musc_000003'), 'only asked about Alice\'s song: ' + asked().join(', '));
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added'));
    assert.ok(picks.every(l => /from Alice\)$/.test(l)), picks.join('\n'));
  });

  test('a thumbs-up on one of its songs in the history: it finds more like it; only its songs can be liked, each person sees only their own like, and it can be taken back', async () => {
    const now = Date.now();
    const djSong = { url: yt('djlk_000001'), title: 'Song djlk_000001', by: 'DJ', t: now }, bobSong = { url: yt('bobs_000001'), title: 'Song bobs_000001', by: 'Bob', t: now - 60000 };
    const s = await start({ here: {}, history: [djSong, bobSong] });
    const like = (as, h, yes = true) => s.post('/like', { url: h.url, t: h.t, like: yes }, { as });
    const seenBy = async (as, url) => (await s.state(as)).history.find(h => h.url === url);
    const saved = url => JSON.parse(fs.readFileSync(s.statePath, 'utf8')).history.find(h => h.url === url).likedBy;

    await like('Alice', bobSong);
    assert.equal(saved(bobSong.url), undefined, 'people\'s own songs have no thumbs-up');
    await like('Alice', djSong);
    await like('Alice', djSong, false);
    await like('Alice', djSong);
    await like('Cara', djSong);
    assert.deepEqual(saved(djSong.url), ['Alice', 'Cara'], 'both likes count for the DJ');
    assert.equal((await seenBy('Alice', djSong.url)).liked, true, 'Alice sees her like');
    assert.equal((await seenBy('Bob', djSong.url)).liked, undefined, 'Bob, who didn\'t like it, sees nothing');
    assert.ok(!JSON.stringify((await s.state('Bob')).history).includes('Cara'), 'nobody sees who liked it');
    assert.ok(!(await s.log()).some(l => /liked/.test(l)), 'and Activity doesn\'t say');

    await say(s, 'Bob', '!dj on');
    await waitFor(async () => (await s.log()).some(l => /^DJ: added .* \(like "Song djlk_000001", a liked song\)$/.test(l)), 12000, 'a pick like the liked song');

    await like('Alice', djSong, false);
    await like('Cara', djSong, false);
    assert.equal(saved(djSong.url), undefined, 'and the likes can be taken back');
    assert.equal((await seenBy('Alice', djSong.url)).liked, undefined);
  });

  test('turning it on doesn\'t rush YouTube: its first picks come straight away, then a Mix every 10 seconds', async () => {
    const now = Date.now();
    const s = await start({ here: {}, history: ['gapa_000001', 'gapb_000001', 'gapc_000001'].map((id, i) => ({ url: yt(id), title: `Song ${id}`, by: 'Alice', t: now - i * 60000 })) });
    await s.cookie('Bob');
    const turnedOn = Date.now();
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(4)(s), 20000, 'picks from a second Mix');
    const times = fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim().split('\n').map(l => +l.split('\t')[1]);
    assert.ok(times[0] - turnedOn < secs(20), `the first Mix straight away, not after waiting (${times[0] - turnedOn} ms)`);
    const gaps = times.slice(1).map((t, i) => t - times[i]);
    assert.ok(gaps.length >= 1 && gaps.every(g => g >= secs(10) - 100), `time between Mixes: ${gaps.join(', ')} ms (at least ${secs(10)})`);
  });
});
