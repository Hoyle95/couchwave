// The DJ (dj.js): off until "!dj on"; keeps up to 10 songs of its own queued, always after people's;
// removing or skipping them is a vote, like anyone's; "!dj off" leaves them queued. YouTube's Mix comes
// from the stand-in yt-dlp: for a song, one by the same artist, two by other artists, and a full album and
// a jingle it should skip.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { Server, song, waitFor, sleep, PASSWORD, ownPassword } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
async function start(initial = { here: {} }) { const s = new Server({ initial }); servers.push(s); return s.start(); }
const yt = id => `https://www.youtube.com/watch?v=${id}`;
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
    const s = await start();
    await aliceSong(s, 'shrt_000001');
    await sleep(7000);
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

  test('keeps up to 10 songs queued: like what people asked for, other artists first, nothing that isn\'t a song', async () => {
    const s = await start();
    await aliceSong(s, 'long_000002'); // a 200-second song, still playing
    await say(s, 'Bob', '!dj on');
    await waitFor(() => djCount(10)(s), 20000, '10 DJ songs');
    const mine = await djSongs(s);
    const fromMix = n => (n + require('crypto').createHash('md5').update('long_000002').digest('hex')).slice(0, 11); // as fakes/yt-dlp.js
    assert.ok([fromMix('b'), fromMix('e')].includes(vid(mine[0])), 'its first: another artist from the Mix of Alice\'s song: ' + vid(mine[0]));
    assert.equal(new Set(mine.map(vid)).size, 10, 'no repeats');
    assert.ok(!mine.some(q => /Full Album|Too Short/.test(q.title)), 'no albums or jingles');
    assert.ok((await s.log()).some(l => /^DJ: added ".+" \(like "Song long_000002", from Alice\)$/.test(l)), 'the log says why');
    await sleep(4000);
    assert.equal((await djSongs(s)).length, 10, 'and no more');
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
    const s = await start();
    await aliceSong(s, 'shrt_000004'); // 3 seconds: a DJ song plays next
    const stop = s.keepOnline('Alice', 'Bob', 'Cara', 'Dan'); // 4 people online: 3 votes needed
    for (const n of ['Bob', 'Cara', 'Dan']) await s.state(n);
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
    assert.ok((await s.log()).some(l => /: skipped ".+" \(\d of \d voted\)$/.test(l)), 'logged as a vote');
    const before = (await djSongs(s)).length;
    assert.ok(before > 0, 'it has songs queued');
    await say(s, 'Bob', '!dj off');
    assert.equal((await djSongs(s)).length, before, 'off: what it queued stays, until it\'s voted out');
    assert.match((await s.state()).chat.at(-1).text, /DJ off: I won't add any more\. My \d+ songs? already queued stays? \(you can vote them out of the queue\)/);
    await sleep(4000);
    assert.equal((await djSongs(s)).length, before, '...and it doesn\'t add any more');
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

  test('nothing played or queued yet: says so (once), instead of guessing', async () => {
    const s = await start();
    await say(s, 'Bob', '!dj on');
    await sleep(4000);
    const said = (await s.state()).chat.filter(m => m.by === 'DJ' && /Nothing to go on/.test(m.text));
    assert.equal(said.length, 1);
    assert.equal((await djSongs(s)).length, 0);
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

test('no crashes or warnings from the server', () => {
  for (const s of servers) assert.deepEqual(s.problems(), []);
});
