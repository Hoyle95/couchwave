// ---------- Commands for whoever runs Couchwave: --status, --clear, --remove-song, --stop ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { testServers, song, yt, waitFor, sleep, PASSWORD, appCopy, run, freePort, testEnv } = require('./helpers');

const start = testServers({ after });
const playing = { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) };
const saved = (s, text) => waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes(text), 3000, `"${text}" to be saved`);

describe('commands', { concurrency: true }, () => {
test('--status: whether it\'s running, who\'s online, what\'s playing, the queue, the DJ, disk space, the tools and the newest release', async () => {
  const s = await start({ initial: { ...playing, queue: [song(2, 'Next up', 'Bob')] } });
  const leave = await s.keepOnline('Alice');
  let r = await s.command('--status').finally(leave);
  assert.equal(r.status, 0, r.out);
  for (const line of [
    new RegExp(`^Couchwave v\\S+ is running on port ${s.port}\\.$`, 'm'), /^Online now: Alice$/m, /^Playing: "Playing now" \(added by Zed\), \d+:\d\d of 27:46:40$/m,
    /^Queue: 1 song \(1 ready\)$/m, /^The DJ is off\.$/m, /^Disk: [\d.]+ GB free$/m,
    /^Tools: yt-dlp 2026\.10\.26, ffmpeg 7\.1-test, ffprobe 7\.1-test, Node\.js \S+$/m, /^Newest release: couldn't check$/m,
  ]) assert.match(r.stdout, line);
  await s.stop();
  r = await s.command('--status');
  assert.match(r.stdout, /^Couchwave v\S+ isn't running\.\nSaved: 1 song in the queue, 0 in the played history\.$/m);
});

test('--clear: the chat, Activity or played history, any or all of them, with Couchwave on or off', async () => {
  const s = await start({ initial: { history: [{ url: yt('hist_000002'), title: 'Played before', by: 'Zed', t: Date.now() }] } });
  await s.post('/chat', { text: 'hello' }, { as: 'Bob' });
  await saved(s, 'hello');
  let r = await s.command('--clear');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^Usage: node server\.js --clear <history \| activity \| chat \| all>/);
  assert.match(r.stdout, /Now: 1 songs in the played history, \d+ lines in Activity, 1 chat messages\./, 'how much there is of each');
  assert.equal((await s.command('--clear', 'everything')).status, 1, 'only what it knows how to clear');
  const before = await s.state();
  r = await s.command('--clear', 'chat');
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^Done: cleared the chat\./);
  let st = (await s.get(`/state?log=${before.logRev}&chat=${before.chatRev}&history=${before.historyRev}`)).json;
  assert.deepEqual(st.chat, [], 'cleared straight away, and pages that already had the chat are sent the empty one');
  assert.equal(st.history, undefined, 'the history is untouched');
  assert.ok(st.log.some(e => e.by === 'server' && e.text === 'cleared the chat (whoever runs Couchwave did)'), 'Activity says so');
  assert.equal((await s.command('--clear', 'history', 'Activity')).status, 0, 'more than one, any capitals');
  st = await s.state();
  assert.deepEqual(st.history, []);
  assert.deepEqual(st.log.map(e => `${e.by}: ${e.text}`), ['server: cleared the played history and the Activity log (whoever runs Couchwave did)']);
  await s.post('/chat', { text: 'after' }, { as: 'Bob' });
  await saved(s, 'after');
  await s.stop();
  r = await s.command('--clear', 'all');
  assert.equal(r.status, 0, 'with Couchwave off: ' + r.out);
  await s.start();
  st = await s.state();
  assert.deepEqual([st.chat, st.history], [[], []]);
  assert.deepEqual(st.log.filter(e => !/^(joined|left)$/.test(e.text)).map(e => `${e.by}: ${e.text}`),
    ['server: cleared the played history, the Activity log and the chat (whoever runs Couchwave did)']);
  const configPath = path.join(s.dir, 'config.json'), config = fs.readFileSync(configPath, 'utf8');
  fs.writeFileSync(configPath, JSON.stringify({ ...JSON.parse(config), port: await freePort() }));
  await s.post('/chat', { text: 'before the port changed' }, { as: 'Bob' });
  r = await s.command('--clear', 'chat');
  assert.equal(r.status, 0, 'running, on another port than config.json now says: ' + r.out);
  assert.deepEqual((await s.state()).chat, [], 'it still reached the running Couchwave');
  fs.writeFileSync(configPath, config);
  await s.stop();
  fs.writeFileSync(path.join(s.dir, 'data', 'running.json'), JSON.stringify({ pid: process.pid, port: s.port }));
  assert.match((await s.command('--status')).stdout, /isn't running/, 'a note left behind by a Couchwave that was killed is ignored');
});

test('--remove-song: by queue number, link or part of the name, straight away and without a vote, with Couchwave on or off', async () => {
  const s = await start({ initial: playing });
  for (const [id, by] of [['rmsa_000001', 'Bob'], ['rmsb_000002', 'Cara'], ['rmsc_000003', 'Bob']]) await s.post('/add', { url: yt(id) }, { as: by });
  await waitFor(async () => (await s.state()).queue.filter(q => q.status === 'ready').length === 3, 5000, 'the songs');
  await saved(s, 'Song rmsc_000003');
  let r = await s.command('--remove-song', 'Song rms');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /3 songs match "Song rms"\. Use its number instead:\n1\. Song rmsa_000001 \(added by Bob\)\n2\. Song rmsb_000002 \(added by Cara\)/);
  r = await s.command('--remove-song', '2');
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /Done: removed "Song rmsb_000002" from the queue\./);
  assert.deepEqual((await s.state()).queue.map(q => q.title), ['Song rmsa_000001', 'Song rmsc_000003'], 'gone at once: no vote, no restart');
  assert.ok((await s.log()).includes('server: removed "Song rmsb_000002" (whoever runs Couchwave did)'), 'Activity says so');
  assert.equal((await s.command('--remove-song', 'https://youtu.be/rmsc_000003?si=abc')).status, 0, 'by link, in any form');
  assert.equal((await s.command('--remove-song', 'RMSA')).status, 0, 'by part of the name');
  assert.deepEqual((await s.state()).queue, []);
  r = await s.command('--remove-song', 'not in the queue');
  assert.deepEqual([r.status, /Nothing in the queue matches "not in the queue"/.test(r.stdout)], [1, true]);
  r = await s.command('--remove-song');
  assert.match(r.stdout, /^Usage: node server\.js --remove-song <queue number, YouTube link or part of the name>\n\nThe queue is empty\./);
  await s.post('/add', { url: yt('rmsd_000004') }, { as: 'Bob' });
  await saved(s, 'rmsd_000004');
  await s.stop();
  r = await s.command('--remove-song', '1');
  assert.equal(r.status, 0, 'with Couchwave off too: ' + r.out);
  await s.start();
  assert.deepEqual((await s.state()).queue, []);
  assert.ok((await s.log()).some(l => /^server: removed ".*rmsd_000004.*" \(whoever runs Couchwave did\)$/.test(l)), 'Activity says so');
});

test('--stop: saves everything and stops; under systemd it says to use systemctl instead; with nothing running it says so', async () => {
  const s = await start({ initial: playing });
  await s.post('/chat', { text: 'saved before stopping' });
  const exited = new Promise(r => s.proc.on('exit', r));
  let r = await s.command('--stop');
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^Done: Couchwave has stopped, and everything is saved\./);
  assert.equal(await exited, 0, 'it stopped by itself, on purpose');
  assert.ok(fs.readFileSync(s.statePath, 'utf8').includes('saved before stopping'));
  assert.ok(fs.existsSync(path.join(s.dir, 'data', 'stop')), 'a note for start.cmd not to start it again');
  r = await s.command('--stop');
  assert.deepEqual([r.status, r.stdout.trim()], [0, 'Couchwave isn\'t running.']);
  await s.start();
  assert.ok(!fs.existsSync(path.join(s.dir, 'data', 'stop')), 'the note is cleared when it starts again');
  const systemd = await start({ env: { COUCHWAVE_FAKE_SYSTEMD: '1' } });
  r = await systemd.command('--stop');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /systemd service .* sudo systemctl stop couchwave/);
  assert.equal((await systemd.get('/manifest.json', { cookie: '' })).status, 200, 'still running');
});

async function folder(extra) {
  const copy = appCopy(extra), port = await freePort();
  fs.writeFileSync(path.join(copy.dir, 'config.json'), JSON.stringify({ password: PASSWORD, port }));
  const up = () => waitFor(() => fetch(`http://127.0.0.1:${port}/manifest.json`).then(x => x.ok, () => false), 15000, 'Couchwave to start');
  return { ...copy, env: testEnv(), up, stop: () => run(copy.dir, ['--stop']) };
}

test('--stop under node --watch (as start.cmd runs it): the watcher stops too, so nothing starts it again', async () => {
  const f = await folder();
  const watcher = spawn(process.execPath, ['--watch', 'server.js'], { cwd: f.dir, env: f.env, stdio: 'ignore' });
  const exited = new Promise(r => watcher.on('exit', r));
  try {
    await f.up();
    assert.equal((await f.stop()).status, 0);
    await Promise.race([exited, sleep(10000).then(() => { throw new Error('node --watch is still running'); })]);
  } finally { watcher.kill(); await sleep(300); f.clean(); }
});

test('Windows: stop.cmd\'s --stop ends start.cmd too, instead of it restarting Couchwave', { skip: process.platform !== 'win32' }, async () => {
  const f = await folder(['start.cmd']);
  const loop = spawn('cmd.exe', ['/c', path.join(f.dir, 'start.cmd')], { cwd: f.dir, env: f.env, stdio: 'ignore' });
  const exited = new Promise(r => loop.on('exit', r));
  try {
    await f.up();
    assert.equal((await f.stop()).status, 0);
    assert.equal(await Promise.race([exited, sleep(15000).then(() => 'start.cmd is still running')]), 0, 'start.cmd finished by itself');
    assert.ok(!fs.existsSync(path.join(f.dir, 'data', 'stop')), 'it took the "stopped" way out: only that clears the note');
  } finally { spawnSync('taskkill', ['/pid', String(loop.pid), '/T', '/F']); await sleep(300); f.clean(); }
});
});
