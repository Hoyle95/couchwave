// ---------- The DJ ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, secs, PASSWORD, ownPassword } = require('./helpers');

const servers = testServers({ after });
const start = (initial = { here: {} }) => servers({ initial });
const CHECKS = secs(5);
const vid = q => (/v=([\w-]{11})/.exec(q.url || '') || [])[1];
const say = (s, as, text) => s.post('/chat', { text }, { as });
const djSongs = async s => (await s.state()).queue.filter(q => q.by === 'DJ');
const djCount = n => async s => (await djSongs(s)).length >= n;
async function aliceSong(s, id) {
  await s.post('/add', { url: yt(id) }, { as: 'Alice' });
  await waitFor(async () => (await s.state()).history?.some(h => h.url.endsWith(id)), 6000, 'Alice\'s song to play');
}

describe('the DJ', { concurrency: true }, () => {
  test('off by default: an empty queue stays empty', async () => {
    const s = await start({ here: {}, history: [{ url: yt('alic_000001'), title: 'Song alic_000001', by: 'Alice', t: Date.now() }] });
    await sleep(CHECKS);
    const st = await s.state();
    assert.equal(st.dj, false);
    assert.equal(st.queue.length, 0);
  });

  test('!dj on / !dj off / !dj: answers in chat, logged, and the command itself isn\'t posted', async () => {
    const s = await start();
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
  });

  test('keeps up to 10 songs queued, only from what people asked for (never its own picks), nothing that isn\'t a song', async () => {
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
    assert.ok(!mine.some(q => /Full Album|Too Short/.test(q.title)), 'no albums or jingles');
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added'));
    assert.equal(picks.length, 10);
    assert.ok(picks.every(l => /\(like "Song (play|hist)_00000\d", from (Alice|Bob)\)$/.test(l)), 'every pick is like a song a person asked for:\n' + picks.join('\n'));
    await sleep(CHECKS);
    assert.equal((await djSongs(s)).length, 10, 'and no more');
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
    const t = Date.now();
    await s.post('/add', { url: yt('bobs_000009') }, { as: 'Bob' });
    await waitFor(async () => (await s.log()).some(l => /^DJ: added ".+" \(like (".+"|a song), from Bob\)$/.test(l)), secs(60), 'the DJ to carry on from Bob\'s song');
    assert.ok(Date.now() - t < secs(20), `picked up in ${((Date.now() - t) / secs(1)).toFixed(1)} (server) seconds, not after its 30-second wait`);
  });

  test('always after people\'s songs: a song added later still goes ahead of the DJ\'s', async () => {
    const s = await start();
    await aliceSong(s, 'play_000003');
    await s.post('/add', { url: yt('bobs_000001') }, { as: 'Bob' });
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(5)(s), 20000, 'DJ songs');
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
    assert.equal((await s.post('/undo', { id: first.id }, { as: 'Alice' })).status, 403, 'only the deciding voter can undo it (the DJ isn\'t a person)');
    const playing = await waitFor(async () => { const st = await s.state('Dan'); return st.current?.by === 'DJ' && st.current; }, 15000, 'a DJ song to play');
    await s.post('/skip', { id: playing.id }, { as: 'Dan' });
    const st = await s.state('Dan');
    assert.equal(st.current?.id, playing.id, 'one vote isn\'t enough, even for the DJ\'s song');
    assert.deepEqual(st.skip.voters, ['Dan']);
    for (const who of ['Cara', 'Bob']) await s.post('/skip', { id: playing.id }, { as: who });
    assert.notEqual((await s.state()).current?.id, playing.id, 'skipped by the vote');
    assert.ok((await s.log()).some(l => /^: ".+" was skipped \(\d of \d voted\)$/.test(l)), 'logged as a vote');
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

  test('on/off is remembered when the server restarts', async () => {
    const s = await start();
    await say(s, 'Bob', '!dj on');
    await s.restart();
    assert.equal((await s.state()).dj, true);
    await say(s, 'Bob', '!dj off');
    await s.restart();
    assert.equal((await s.state()).dj, false);
  });

  test('nothing played or queued yet: asks for a song (once), and starts as soon as there is one', async () => {
    const s = await start();
    await say(s, 'Bob', '!dj on');
    await sleep(CHECKS);
    const said = (await s.state()).chat.filter(m => m.by === 'DJ' && /Nothing to go on yet: add a song/.test(m.text));
    assert.equal(said.length, 1);
    assert.equal((await djSongs(s)).length, 0);
    await aliceSong(s, 'play_000005');
    await waitFor(() => djCount(1)(s), 10000, 'the DJ to start from Alice\'s song');
  });

  test('nobody can be "DJ": not as a new nickname, and not with an account from before it was reserved', async () => {
    const s = await start();
    const join = name => s.req('POST', '/login', { body: { password: PASSWORD, name, own: ownPassword('Bob') }, cookie: '' });
    assert.equal((await join('dj')).status, 400);
    assert.equal((await join('DJ')).status, 400);
    await s.cookie('Bob');
    await s.stop();
    const file = path.join(s.dir, 'data', 'accounts.json');
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    list.dj = { ...list.bob, name: 'DJ' };
    fs.writeFileSync(file, JSON.stringify(list));
    await s.start();
    assert.equal((await join('DJ')).status, 400, 'still can\'t log in as it');
    await say(s, 'Bob', '!dj on');
    const st = await s.state('Bob');
    assert.deepEqual(st.users, ['Bob'], 'and the DJ isn\'t counted as a person online');
    assert.equal(st.skip.need, 1);
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
    const asked = () => { try { return fs.readFileSync(path.join(s.dir, 'mix-requests.log'), 'utf8').trim().split('\n'); } catch { return []; } };
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

  test('picks songs between 1 and 20 minutes long', async () => {
    const s = await start({ here: {}, history: [{ url: yt('lens_000001'), title: 'Song lens_000001', by: 'Alice', t: Date.now() }] });
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(3)(s), 8000, 'the DJ\'s picks');
    const picks = (await s.log()).filter(l => l.startsWith('DJ: added')).join('\n');
    assert.match(picks, /Fourth Band - Long Song/, 'a 15-minute song is fine:\n' + picks);
    assert.doesNotMatch(picks, /Too Long|Too Short|Full Album/, 'not 25 minutes, 30 seconds, or an album');
  });
});
