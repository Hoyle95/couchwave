// Pause / play / seek for everyone, songs moving on, the video and audio files, and download pacing.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http');
const { Server, song, waitFor, sleep } = require('./helpers');

const servers = [];
after(() => Promise.all(servers.map(s => s.close())));
async function start(opts) { const s = new Server(opts); servers.push(s); return s.start(); }

test('pause, seek and play: for everyone, and in the log', async () => {
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 300 }), startedAt: Date.now() - 20000 } });
  await s.post('/pause');
  let st = await s.state('Bob');
  assert.equal(st.paused, true);
  const at = st.elapsed;
  assert.ok(at >= 19 && at <= 22, 'paused around 0:20: ' + at);
  await sleep(1200);
  assert.equal((await s.state('Bob')).elapsed, at, 'the clock stops while paused');
  await s.post('/seek', { t: 125 });
  assert.equal((await s.state('Bob')).elapsed, 125);
  await s.post('/seek', { t: 99999 });
  assert.equal((await s.state('Bob')).elapsed, 300, 'seeking past the end stops at the end');
  await s.post('/seek', { t: 60 });
  await s.post('/play');
  await sleep(1100);
  st = await s.state('Bob');
  assert.equal(st.paused, false);
  assert.ok(st.elapsed > 60.5 && st.elapsed < 63, 'playing on from 1:00: ' + st.elapsed);
  const log = await s.log();
  for (const line of ['Alice: paused at 0:20', 'Alice: jumped to 2:05', 'Alice: jumped to 1:00', 'Alice: resumed']) assert.ok(log.includes(line), line);
});

test('when a song ends, the next one plays and the old files are deleted', async () => {
  const s = await start({ initial: { current: song(1, 'Short song', 'Alice', { duration: 1 }), queue: [song(2, 'Next song', 'Bob')] } });
  const oldFile = path.join(s.dir, 'data', 'downloads', (await JSON.parse(fs.readFileSync(s.statePath))).current.file);
  assert.ok(fs.existsSync(oldFile));
  const st = await waitFor(async () => { const x = await s.state(); return x.current && x.current.title === 'Next song' && x; }, 6000, 'the next song');
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

// Bytes read from a download, with the reading paused for `stall` ms after the first `pauseAt` bytes;
// returns how many arrived in the `window` ms after reading starts again.
async function readWithStall(s, url, { pauseAt, stall, window }) {
  const cookie = await s.cookie('Alice');
  return new Promise((resolve, reject) => {
    const r = http.get({ port: s.port, path: url, headers: { Cookie: cookie } }, res => {
      let n = 0, after = 0, phase = 'start', tStart = Date.now(), tBurst = 0;
      res.on('data', c => {
        n += c.length;
        if (phase === 'start' && n >= pauseAt) {
          phase = 'stalled'; tBurst = Date.now() - tStart; res.pause();
          setTimeout(() => {
            phase = 'after'; res.resume();
            setTimeout(() => { r.destroy(); resolve({ tBurst, after }); }, window);
          }, stall);
        } else if (phase === 'after') after += c.length;
      });
    });
    r.on('error', e => (e.code === 'ECONNRESET' ? null : reject(e)));
  });
}

test('pacing: songs start at full speed, then go at a steady pace, with no rush after a stall', async () => {
  // 4 MB over 400 s = 10 KB/s of song. Pace: the first 20 s of song (200 KB) at full speed, then
  // max(3 x 10 KB/s, 256 KB/s) = 256 KB/s.
  const RATE = 256 * 1024;
  const s = await start({ initial: { current: song(1, 'Song A', 'Alice', { duration: 400, file: 'big.mp4' }) }, files: { 'big.mp4': Buffer.alloc(4 * 1024 * 1024, 1) } });
  const t0 = Date.now();
  const r = await s.get('/video/1', { headers: { Range: 'bytes=0-199999' } });
  assert.equal(r.body.length, 200000);
  assert.ok(Date.now() - t0 < 500, 'the start of a song comes straight away: ' + (Date.now() - t0) + 'ms');
  // 1 MB more: about 4 seconds at 256 KB/s
  const t1 = Date.now();
  await s.get('/video/1', { headers: { Range: 'bytes=0-1199999' } });
  const secs = (Date.now() - t1) / 1000;
  assert.ok(secs > 3 && secs < 6, `1.2 MB took ${secs.toFixed(1)}s (expected ~3.9s)`);
  // Stall 6 s, then 4 s of reading: at most 4 s of pace + the 1 s it banks + what the network buffered meanwhile.
  // (Before the fix it rushed out the whole 6 s it was "behind": ~1.5 MB more.)
  const { after } = await readWithStall(s, '/video/1', { pauseAt: 600 * 1024, stall: 6000, window: 4000 });
  assert.ok(after < 5 * RATE + 900 * 1024, `after a stall: ${Math.round(after / 1024)} KB in 4 s (limit ~${Math.round((5 * RATE + 900 * 1024) / 1024)} KB)`);
  assert.deepEqual(s.problems(), [], 'no warnings (e.g. MaxListenersExceeded)');
});
