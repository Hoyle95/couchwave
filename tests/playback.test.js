// Pause / play / seek for everyone, songs moving on, the video and audio files, and download pacing.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { testServers, song, waitFor, sleep } = require('./helpers');

const start = testServers({ after });

// Each test has its own server, so they run at the same time.
describe('playback', { concurrency: true }, () => {
test('pause, seek and play: for everyone, and in the log', async () => {
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 300 }), startedAt: Date.now() - 20000 } });
  await s.post('/pause');
  let st = await s.state('Bob');
  assert.equal(st.paused, true);
  const at = st.elapsed;
  assert.ok(at >= 19 && at <= 22, 'paused around 0:20: ' + at);
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
  for (const line of ['Alice: paused at 0:20', 'Alice: jumped to 2:05', 'Alice: jumped to 1:00', 'Alice: resumed']) assert.ok(log.includes(line), line);
});

test('when a song ends, the next one plays and the old files are deleted', async () => {
  const s = await start({ initial: { current: song(1, 'Short song', 'Alice', { duration: 1 }), queue: [song(2, 'Next song', 'Bob')] } });
  const oldFile = path.join(s.dir, 'data', 'downloads', JSON.parse(fs.readFileSync(s.statePath)).current.file);
  assert.ok(fs.existsSync(oldFile));
  const st = await waitFor(async () => { const x = await s.state(); return x.current?.title === 'Next song' && x; }, 6000, 'the next song');
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

// Reads a download, pausing for `stall` ms after the first `pauseAt` bytes; returns how many bytes arrived in
// the `window` ms after reading starts again.
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
  // A 40 MB, 40-second song: 1 MB per second of song. Pace: the first 20 seconds of song (20 MB) at full
  // speed, then 3x the song's own speed: 3 MB/s.
  const MB = 1024 * 1024, BURST = 20 * MB, RATE = 3 * MB;
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 40, file: 'big.mp4' }) }, files: { 'big.mp4': Buffer.alloc(40 * MB, 1) } });
  let t = Date.now();
  const first = await s.get('/video/1', { headers: { Range: `bytes=0-${2 * MB - 1}` } });
  assert.equal(first.body.length, 2 * MB);
  assert.ok(Date.now() - t < 500, `the start of a song comes straight away: ${Date.now() - t}ms`);
  // The burst, then 3 MB more: about a second at 3 MB/s
  t = Date.now();
  await s.get('/video/1', { headers: { Range: `bytes=0-${BURST + 3 * MB - 1}` } });
  const took = (Date.now() - t) / 1000;
  assert.ok(took > 0.7 && took < 2.5, `20 MB at full speed + 3 MB at 3 MB/s took ${took.toFixed(1)}s (expected ~1s)`);
  // Stall 3 s just after the burst, then read for 1 s: at most 1 s of pace + the 1 s it banks + whatever the
  // connection buffered meanwhile (about 7 MB). Rushing to catch up on the 3 s it was "behind" would be ~13 MB.
  const after = await readWithStall(s, '/video/1', { pauseAt: BURST + MB, stall: 3000, window: 1000 });
  assert.ok(after < 2 * RATE + 3.5 * MB, `after a stall: ${(after / MB).toFixed(1)} MB in 1 s (limit ${((2 * RATE + 3.5 * MB) / MB).toFixed(1)} MB)`);
});
});
