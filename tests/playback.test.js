// ---------- Pause, play, seek, moving on and download pacing ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { testServers, song, waitFor, sleep, secs } = require('./helpers');

const start = testServers({ after });

describe('playback', { concurrency: true }, () => {
test('pause, seek and play: for everyone, and in the log', async () => {
  const t0 = Date.now();
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 300 }), startedAt: t0 - 20000 } });
  await s.post('/pause');
  let st = await s.state('Bob');
  assert.equal(st.paused, true);
  const at = st.elapsed, upTo = 20.1 + (Date.now() - t0) / 1000;
  assert.ok(at >= 20 && at <= upTo, `paused 20 seconds in, plus however long the server took to start (up to ${upTo.toFixed(1)}): ${at}`);
  await sleep(600);
  assert.equal((await s.state('Bob')).elapsed, at, 'the clock stops while paused');
  await s.post('/seek', { t: 125 });
  assert.equal((await s.state('Bob')).elapsed, 125);
  await s.post('/seek', { t: 99999 });
  assert.equal((await s.state('Bob')).elapsed, 300, 'seeking past the end stops at the end');
  await s.post('/seek', { t: 60 });
  await s.post('/play');
  await sleep(600);
  st = await s.state('Bob');
  assert.equal(st.paused, false);
  assert.ok(st.elapsed > 60.4 && st.elapsed < 62, 'playing on from 1:00: ' + st.elapsed);
  const log = await s.log();
  for (const line of [`Alice: paused at 0:${String(Math.floor(at)).padStart(2, '0')}`, 'Alice: jumped to 2:05', 'Alice: jumped to 1:00', 'Alice: resumed']) assert.ok(log.includes(line), line);
  const statuses = [];
  for (let i = 0; i < 31; i++) statuses.push((await s.post(i % 2 ? '/play' : '/pause', undefined, { as: 'Bob' })).status);
  assert.deepEqual([statuses.slice(0, 30).every(x => x === 204), statuses[30]], [true, 429], 'a speed limit: 30 a minute each');
  assert.equal((await s.post('/pause', undefined, { as: 'Cara' })).status, 204, 'others aren\'t affected');
});

test('moving through a song: only whoever added it while they\'re here (or it\'d be a skip without a vote), anyone once they\'ve gone', async () => {
  const t0 = Date.now();
  const s = await start({ initial: { current: song(1, 'Alice\'s song', 'Alice', { duration: 300 }), startedAt: t0 - 20000,
    queue: [song(2, 'The DJ\'s song', 'DJ', { duration: 300 })] } });
  const stopAlice = await s.keepOnline('Alice'), stopOthers = await s.keepOnline('Bob', 'Cara');
  const r = await s.post('/seek', { t: 200 }, { as: 'Bob' });
  assert.equal(r.status, 403, 'Bob is refused while Alice is here');
  assert.equal(r.text, 'Only Alice can move their song while they\'re here');
  const at = (await s.state('Bob')).elapsed;
  assert.ok(at >= 20 && at <= 20.1 + (Date.now() - t0) / 1000, 'not moved: ' + at);
  assert.ok(!(await s.log('Bob')).some(l => /jumped/.test(l)), 'nothing logged');
  assert.equal((await s.post('/seek', { t: 100 }, { as: 'Alice' })).status, 204, 'Alice can');
  stopAlice();
  await sleep(secs(10) + 500);
  assert.deepEqual((await s.state('Bob')).users, ['Bob', 'Cara'], 'Alice has gone; Bob and Cara are still here');
  assert.equal((await s.post('/seek', { t: 299 }, { as: 'Bob' })).status, 204, 'now anyone can move Alice\'s song, even to the end');
  await waitFor(async () => (await s.state('Bob')).current?.by === 'DJ', secs(20), 'the DJ\'s song to play');
  for (const who of ['Bob', 'Cara']) assert.equal((await s.post('/seek', { t: 299 }, { as: who })).status, 403, `with two here, nobody moves the DJ's song (${who})`);
  stopOthers();
  await sleep(secs(10) + 500);
  assert.deepEqual((await s.state('Bob')).users, ['Bob'], 'Bob is on his own');
  assert.equal((await s.post('/seek', { t: 150 }, { as: 'Bob' })).status, 204, 'on his own, Bob can move the DJ\'s song');
  assert.ok((await s.log('Bob')).includes('Bob: jumped to 2:30'));
});

test('when a song ends, the next one plays and the old files are deleted', async () => {
  const short = song(1, 'Short song', 'Alice', { duration: 4 });
  const s = await start({ initial: { current: short, queue: [song(2, 'Next song', 'Bob')] } });
  const oldFile = path.join(s.dir, 'data', 'downloads', short.file);
  const st = await waitFor(async () => { const x = await s.state(); return x.current?.title === 'Next song' && x; }, 12000, 'the next song');
  assert.equal(st.queue.length, 0);
  await waitFor(() => !fs.existsSync(oldFile), 3000, 'the old file to be deleted');
});

test('video and audio files: whole, in parts (seeking), and the next song early', async () => {
  const video = Buffer.from([...Array(100000).keys()].map(i => i % 251));
  const s = await start({
    initial: { current: song(1, 'Song A', 'Alice', { file: 'a.mp4', audio: 'a.m4a' }), queue: [song(2, 'Song B', 'Bob', { file: 'b.mp4' })] },
    files: { 'a.mp4': video, 'a.m4a': Buffer.alloc(5000, 9) },
  });
  let r = await s.get('/video/1');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'video/mp4');
  assert.ok(r.body.equals(video), 'the whole file, intact');
  r = await s.get('/video/1', { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers['content-range'], 'bytes 1000-1999/100000');
  assert.ok(r.body.equals(video.subarray(1000, 2000)), 'the right part');
  r = await s.get('/video/1', { headers: { Range: 'bytes=-500' } });
  assert.ok(r.body.equals(video.subarray(-500)), 'the last 500 bytes (browsers ask for the end of an mp4 first)');
  assert.equal((await s.get('/video/1', { headers: { Range: 'bytes=200000-' } })).status, 416, 'past the end');
  r = await s.get('/audio/1');
  assert.equal(r.headers['content-type'], 'audio/mp4');
  assert.equal(r.body.length, 5000, 'the audio-only copy');
  r = await s.get('/audio/2');
  assert.equal(r.headers['content-type'], 'video/mp4', 'no audio copy: falls back to the video file');
  assert.equal((await s.get('/video/2')).status, 200, 'the next song can be fetched early (pages start it the instant this one ends)');
  assert.equal((await s.get('/video/77')).status, 404, 'not a song that\'s playing or ready');
});

async function readWithStall(s, url, { pauseAt, stall, window }) {
  const cookie = await s.cookie('Alice');
  return new Promise((resolve, reject) => {
    const r = http.get({ port: s.port, path: url, headers: { Cookie: cookie } }, res => {
      let n = 0, after = 0, phase = 'start';
      res.on('data', c => {
        n += c.length;
        if (phase === 'start' && n >= pauseAt) {
          phase = 'stalled'; res.pause();
          setTimeout(() => {
            phase = 'after'; res.resume();
            setTimeout(() => { r.destroy(); resolve(after); }, window);
          }, stall);
        } else if (phase === 'after') after += c.length;
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}

test('pacing: songs start at full speed, then go at a steady pace, with no rush after a stall', async () => {
  const MB = 1024 * 1024, BURST = 20 * MB, RATE = 3 * MB;
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 60, file: 'big.mp4' }) }, files: { 'big.mp4': Buffer.alloc(60 * MB, 1) } });
  const fastest = async (bytes, good) => {
    let best = Infinity;
    for (let i = 0; i < 3 && !good(best); i++) {
      const t = Date.now(), r = await s.get('/video/1', { headers: { Range: `bytes=0-${bytes - 1}` } });
      assert.equal(r.body.length, bytes);
      best = Math.min(best, (Date.now() - t) / 1000);
    }
    return best;
  };
  const first = await fastest(2 * MB, t => t < 0.5);
  assert.ok(first < 0.5, `the start of a song comes straight away: ${first}s (fastest of 3)`);
  const took = await fastest(BURST + 3 * MB, t => t > 0.7 && t < 2.5);
  assert.ok(took > 0.7 && took < 2.5, `20 MB at full speed + 3 MB at 3 MB/s took ${took.toFixed(1)}s (expected ~1s, fastest of 3)`);
  const after = await readWithStall(s, '/video/1', { pauseAt: BURST + MB, stall: 3000, window: 3000 });
  assert.ok(after < 28 * MB, `after a stall: ${(after / MB).toFixed(1)} MB in 3 s, not the remaining 39 MB at once (what the computer had already buffered, plus a few seconds' worth)`);
});

test('even volume: every song\'s loudness is measured, and loud ones are turned down to match (songs from before too)', async () => {
  const s = await start({ initial: { current: song(1, 'Saved before', 'Alice', { duration: 10000 }) } });
  const loudGain = Math.round(10 ** ((-14 - -8) / 20) * 1000) / 1000;
  await waitFor(async () => (await s.state()).current.gain === loudGain, 5000, 'the song playing to be measured');
  await s.post('/add', { url: 'https://www.youtube.com/watch?v=loud_000001' });
  const next = await waitFor(async () => { const n = (await s.state()).next; return n && n.gain !== 1 && n; }, 5000, 'the new song to be measured');
  assert.equal(next.gain, loudGain, 'about half the volume for a song at -8 LUFS (aiming for -14)');
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(s.statePath, 'utf8')).queue.some(q => q.gain === loudGain); } catch { return false; } }, 3000, 'it to be saved');
  await s.restart();
  assert.equal((await s.state()).next.gain, loudGain, 'kept across a restart');
});
});
