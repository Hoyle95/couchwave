// The DJ (dj.js): off until "!dj on"; keeps up to 10 songs of its own queued, always after people's;
// removing or skipping them is a vote, like anyone's; "!dj off" leaves them queued. YouTube's Mix comes
// from the stand-in yt-dlp: for a song, one by the same artist, two by other artists, and a full album and
// a jingle it should skip.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, song, yt, waitFor, sleep, secs, PASSWORD, ownPassword } = require('./helpers');

const servers = testServers({ after });
const start = (initial = { here: {} }) => servers({ initial });
const CHECKS = secs(5); // long enough for the DJ to have checked (every 3 server seconds) at least once
const vid = q => (/v=([\w-]{11})/.exec(q.url || '') || [])[1];
const say = (s, as, text) => s.post('/chat', { text }, { as });
const djSongs = async s => (await s.state()).queue.filter(q => q.by === 'DJ');
const djCount = n => async s => (await djSongs(s)).length >= n;
// Alice's song plays (so it's in the History); with a long one, it keeps playing.
async function aliceSong(s, id) {
  await s.post('/add', { url: yt(id) }, { as: 'Alice' });
  await waitFor(async () => (await s.state()).history?.some(h => h.url.endsWith(id)), 6000, 'Alice\'s song to play');
}

describe('the DJ', { concurrency: true }, () => {
  test('off by default: an empty queue stays empty', async () => {
    // Something to go on (Alice's song, played), nothing playing or queued
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
    await say(s, 'Cara', '!djembe lessons anyone?'); // not a command
    assert.equal((await s.state()).chat.at(-1).text, '!djembe lessons anyone?');
  });

  test('keeps up to 10 songs queued, only from what people asked for (never its own picks), nothing that isn\'t a song', async () => {
    // Alice is playing a long song; Alice and Bob asked for 4 more before (the History).
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
    // Alice's only song, and everything in its Mix already played (by the DJ): nothing new to find.
    const seed = 'aaaa_000001', fromMix = n => (n + require('crypto').createHash('md5').update(seed).digest('hex')).slice(0, 11); // as fakes/yt-dlp.js
    const now = Date.now();
    const s = await start({ here: {}, history: [
      { url: yt(seed), title: `Song ${seed}`, by: 'Alice', t: now },
      ...['a', 'b', 'e'].map((n, i) => ({ url: yt(fromMix(n)), title: `DJ pick ${n}`, by: 'DJ', t: now - (i + 1) * 60000 })),
    ] });
    await say(s, 'Bob', '!dj on');
    await waitFor(async () => (await s.state()).chat.some(m => m.by === 'DJ' && /run out of new songs/.test(m.text)), 8000, 'the DJ to ask');
    await sleep(CHECKS);
    assert.equal((await s.state()).chat.filter(m => /run out of new songs/.test(m.text)).length, 1, 'once');
    assert.equal((await djSongs(s)).length, 0, 'and it doesn\'t pick from its own songs instead');
    const t = Date.now();
    await s.post('/add', { url: yt('bobs_000009') }, { as: 'Bob' });
    await waitFor(async () => (await s.log()).some(l => /^DJ: added ".+" \(like ".+", from Bob\)$/.test(l)), secs(60), 'the DJ to carry on from Bob\'s song');
    assert.ok(Date.now() - t < secs(20), `picked up in ${((Date.now() - t) / secs(1)).toFixed(1)} (server) seconds, not after its 30-second wait`);
  });

  test('always after people\'s songs: a song added later still goes ahead of the DJ\'s', async () => {
    const s = await start();
    await aliceSong(s, 'long_000003');
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
    // Alice's 1-second song playing (and so in the History), and one of Bob's played before: a DJ song plays
    // next. (Two songs to go on: each Mix has 3 the DJ can use, and this test uses up 3 of them.)
    const s = await start({ here: {}, current: song(1, 'Song alic_000004', 'Alice', { duration: 1, url: yt('alic_000004') }),
      history: [{ url: yt('alic_000004'), title: 'Song alic_000004', by: 'Alice', t: Date.now() },
        { url: yt('bobs_000004'), title: 'Song bobs_000004', by: 'Bob', t: Date.now() - 60000 }] });
    const stop = await s.keepOnline('Alice', 'Bob', 'Cara', 'Dan'); // 4 people online: 3 votes needed
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
    for (const who of ['Cara', 'Bob']) await s.post('/skip', { id: playing.id }, { as: who }); // a majority of the people online
    assert.notEqual((await s.state()).current?.id, playing.id, 'skipped by the vote');
    assert.ok((await s.log()).some(l => /^: ".+" was skipped \(\d of \d voted\)$/.test(l)), 'logged as a vote');
    // (Counted after turning it off: while on, it may add another at any moment.)
    await say(s, 'Bob', '!dj off');
    const kept = (await djSongs(s)).length;
    assert.ok(kept > 0, 'off: what it queued stays, until it\'s voted out');
    const said = (await s.state()).chat.at(-1).text;
    assert.match(said, /DJ off: I won't add any more\. My \d+ songs? already queued stays? \(you can vote them out of the queue\)/);
    assert.equal(Number(/My (\d+) song/.exec(said)[1]), kept, 'it says how many it left');
    await sleep(CHECKS);
    assert.equal((await djSongs(s)).length, kept, '...and it doesn\'t add any more');
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
    await aliceSong(s, 'long_000005');
    await waitFor(() => djCount(1)(s), 10000, 'the DJ to start from Alice\'s song');
  });

  test('nobody can be "DJ": not as a new nickname, and not with an account from before it was reserved', async () => {
    const s = await start();
    const join = name => s.req('POST', '/login', { body: { password: PASSWORD, name, own: ownPassword('Bob') }, cookie: '' });
    assert.equal((await join('dj')).status, 400);
    assert.equal((await join('DJ')).status, 400);
    // An old account called "dj" (made before the name was reserved): Bob's, renamed.
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
});
