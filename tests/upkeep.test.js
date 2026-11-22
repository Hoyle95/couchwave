// ---------- Saved state, the log file, stuck downloads, disk space, the tools, updates and backups ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { testServers, song, yt, waitFor, sleep, ROOT } = require('./helpers');

const start = testServers({ after });
const playing = { current: song(1, 'Playing now', 'Zed', { duration: 100000 }) };
const inQueue = async (s, pred) => (await s.state()).queue.find(pred);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const fileHas = (file, re) => { try { return re.test(fs.readFileSync(file, 'utf8')); } catch { return false; } };

describe('upkeep', { concurrency: true }, () => {
test('a download that stops getting anywhere is stopped after 5 minutes and tried again later, so the queue keeps moving', async () => {
  const s = await start({ env: { COUCHWAVE_TIME_SCALE: '0.01' }, config: { downloadsAtOnce: 1 }, initial: playing });
  await s.post('/add', { url: yt('stall_00001') });
  await s.post('/add', { url: yt('okay_000005') }, { as: 'Bob' });
  const stuck = await waitFor(() => inQueue(s, q => q.url === yt('stall_00001') && q.status === 'failed'), 8000, 'the stuck download to be stopped');
  assert.deepEqual([stuck.error, stuck.retrying], ['Download stalled', true]);
  await waitFor(() => inQueue(s, q => q.url === yt('okay_000005') && q.status === 'ready'), 5000, 'the next song to download meanwhile');
  await s.logHas(/downloading .*stall_00001 stalled \(nothing new for 5 minutes\): stopped/);
});

test('ffmpeg getting stuck is stopped (after 30 minutes), and the song still plays, without its audio-only copy', async () => {
  const s = await start({ env: { COUCHWAVE_TOOL_MINUTES: '0.02', COUCHWAVE_FAKE_HANG: 'ffmpeg' }, initial: playing, expectProblems: /ffmpeg was still going/ });
  await s.post('/add', { url: yt('okay_000006') });
  const q = await waitFor(() => inQueue(s, x => x.status === 'ready'), 5000, 'the song to be ready anyway');
  await s.logHas(/ffmpeg was still going after \d+ minutes: stopped/);
  assert.equal((await s.get(`/audio/${q.id}`)).headers['content-type'], 'video/mp4', 'no audio-only copy: the page gets the video file');
});

test('nearly out of disk space: downloads wait (shown in the queue and Activity) instead of filling the disk', async () => {
  const s = await start({ env: { COUCHWAVE_FAKE_FREE_DISK: String(1024 ** 3) }, initial: playing });
  await s.post('/add', { url: yt('okay_000007') });
  const q = await waitFor(() => inQueue(s, x => x.url === yt('okay_000007')), 3000, 'the song');
  await sleep(500);
  const held = await inQueue(s, x => x.id === q.id);
  assert.deepEqual([held.status, held.held], ['waiting', true], 'waiting, marked as held up');
  assert.ok((await s.log()).includes('server: paused downloads: this computer has less than 2 GB of disk space left'));
  s.env = {};
  await s.restart();
  await waitFor(() => inQueue(s, x => x.id === q.id && x.status === 'ready' && !x.held), 5000, 'it to download once there\'s room');
});

test('when starting: the tools are checked, and a missing one is named in the log and Activity', async () => {
  const s = await start({ env: { COUCHWAVE_CHECK_TOOLS: 'yes' } });
  await s.logHas(/found yt-dlp: 2026\.10\.26/, 8000);
  await s.logHas(/found ffmpeg: ffmpeg version 7\.1-test/, 8000);
  const fakes = fs.mkdtempSync(path.join(os.tmpdir(), 'couchwave-fakes-'));
  for (const f of ['yt-dlp.js', 'ffprobe.js']) fs.copyFileSync(path.join(__dirname, 'fakes', f), path.join(fakes, f));
  const t = await start({ env: { COUCHWAVE_FAKE_TOOLS: fakes, COUCHWAVE_CHECK_TOOLS: 'yes' }, expectProblems: /ffmpeg/ });
  await t.logHas(/can't find ffmpeg, so songs won't download properly\. Install it \(see docs\/INSTALL\.md\) and restart Couchwave/, 8000);
  assert.ok((await t.log()).some(l => /^server: can't find ffmpeg/.test(l)));
  assert.ok(!(await t.log()).some(l => /can't find (yt-dlp|ffprobe)/.test(l)));
  fs.rmSync(fakes, { recursive: true, force: true });
});

test('a damaged state.json: unreadable, it\'s kept aside and Couchwave starts afresh; with odd parts, what makes sense is kept and ids are never reused', async () => {
  const s = await start({ expectProblems: /state\.json/ });
  await s.stop();
  fs.writeFileSync(s.statePath, '{ "queue": [ broken');
  await s.start();
  await s.logHas(/Can't read .*state\.json .*starting with an empty queue\. The old file is kept as state\.json\.broken-\d+/);
  const kept = fs.readdirSync(path.join(s.dir, 'data')).filter(f => f.startsWith('state.json.broken-'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.dir, 'data', kept[0]), 'utf8'), '{ "queue": [ broken', 'the old file, untouched');
  assert.deepEqual((await s.state()).queue, []);

  await s.stop();
  fs.writeFileSync(s.statePath, JSON.stringify({
    nextId: 3, current: 5, chat: null, queue: [song(50, 'Kept song', 'Zed', { status: 'waiting', file: undefined, url: yt('kept_000050') }), 'junk', null],
    history: [1, { url: yt('hist_000001'), title: 'Kept history', by: 'Zed', t: Date.now() }],
  }));
  await s.start();
  const st = await s.state();
  assert.ok([st.current, ...st.queue].some(q => q?.id === 50), 'the queued song');
  assert.equal(st.history.at(-1).title, 'Kept history', 'the history entry that made sense (the queued song may already be playing, ahead of it)');
  assert.ok(st.history.every(h => h && typeof h === 'object'), 'and not the junk');
  assert.deepEqual(st.chat, []);
  await s.post('/add', { url: yt('okay_000002') });
  const now = await s.state(), added = [now.current, ...now.queue].find(q => q?.url === yt('okay_000002'));
  assert.ok(added.id > 50, `a new id (${added.id}), not one already taken`);
});

test('the log file is trimmed to its newest 2 MB once it passes 5 MB', async () => {
  const s = await start();
  await s.stop();
  fs.writeFileSync(s.logFile, 'OLDEST LINE\n' + ('x'.repeat(99) + '\n').repeat(60000) + 'NEWEST OLD LINE\n');
  await s.start();
  await waitFor(() => /Running on[\s\S]*$/.test(fs.readFileSync(s.logFile, 'utf8').slice(-500)), 3000, 'the server to log that it started');
  const text = fs.readFileSync(s.logFile, 'utf8');
  assert.ok(text.length < 2.1 * 1024 * 1024, `${(text.length / 1024 / 1024).toFixed(1)} MB`);
  assert.match(text, /^---- .*: older lines trimmed, keeping the newest ----\n/);
  assert.ok(!text.includes('OLDEST LINE') && text.includes('NEWEST OLD LINE'));
});

test('leftover downloads are cleared away; the files of songs still queued or playing are kept', async () => {
  const s = await start({
    initial: { current: song(1, 'Playing', 'Zed', { duration: 100000 }), queue: [song(2, 'Next', 'Zed')] },
    files: { '77-1700000000000.mp4': Buffer.alloc(10), '77-1700000000000.m4a': Buffer.alloc(10), 'stray.mp4.part': Buffer.alloc(10) },
  });
  const dl = path.join(s.dir, 'data', 'downloads');
  await waitFor(() => !['77-1700000000000.mp4', '77-1700000000000.m4a', 'stray.mp4.part'].some(f => fs.existsSync(path.join(dl, f))), 3000, 'the leftovers to go');
  const saved = JSON.parse(fs.readFileSync(s.statePath, 'utf8'));
  for (const q of [saved.current, ...saved.queue]) assert.ok(fs.existsSync(path.join(dl, path.basename(q.file))), `${q.title}: kept`);
});

test('keeps yt-dlp up to date (a minute after starting, then daily): Activity says when it updated, or once that it can\'t update itself', async () => {
  const s = await start({ env: { COUCHWAVE_TIME_SCALE: '0.01' } });
  await s.logHas(/yt-dlp update check: yt-dlp is up to date/, 5000);
  assert.ok(!(await s.log()).some(l => /updated yt-dlp/.test(l)), 'nothing in Activity when there was nothing new');
  fs.writeFileSync(path.join(s.dir, 'yt-dlp-update'), '');
  await s.restart();
  await waitFor(async () => (await s.log()).includes('server: updated yt-dlp to 2026.11.01'), 5000, 'Activity to say so');

  const p = await start({ env: { COUCHWAVE_TIME_SCALE: '0.01' } });
  fs.writeFileSync(path.join(p.dir, 'yt-dlp-cant-update'), '');
  await p.restart();
  const told = async () => (await p.log()).filter(l => /^server: yt-dlp can't update itself here \(it was installed with pip\)/.test(l));
  await waitFor(async () => (await told()).length, 5000, 'Activity to say it can\'t (installed with pip)');
  await sleep(1000);
  assert.equal((await told()).length, 1, 'once');
  assert.match((await told())[0], /Update it the same way it was installed, or install it as in docs\/INSTALL\.md$/);
});

test('a newer Couchwave: Activity says so once (not after every restart); nothing when up to date, or with updateCheck false', async () => {
  const version = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[1];
  let reply = [{ tag_name: 'v' + version, draft: false }], asked = 0;
  const releases = http.createServer((req, res) => { asked++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply)); });
  await new Promise(r => releases.listen(0, '127.0.0.1', r));
  const env = { COUCHWAVE_TIME_SCALE: '0.01', COUCHWAVE_RELEASES_URL: `http://127.0.0.1:${releases.address().port}/releases` };
  const told = async s => (await s.log()).filter(l => /newer Couchwave/.test(l));
  try {
    const s = await start({ env });
    await waitFor(() => asked >= 1, 5000, 'the first check');
    await sleep(300);
    assert.deepEqual(await told(s), [], 'up to date: nothing said');
    reply = [{ tag_name: 'v99.0.0-beta', draft: true }, { tag_name: 'v98.0.0-beta', draft: false }];
    await s.restart();
    await waitFor(async () => (await told(s)).length, 5000, 'Activity to say so');
    assert.deepEqual(await told(s), [`server: a newer Couchwave is out: v98.0.0-beta (this is v${version}). Whoever runs it can update with node server.js --update (or update.cmd on Windows)`], 'the newest that isn\'t a draft');
    await waitFor(() => fs.readFileSync(s.statePath, 'utf8').includes('"newestTold":"v98.0.0-beta"'), 3000, 'it to be saved');
    await s.restart();
    const n = asked;
    await waitFor(() => asked > n, 5000, 'the check after the restart');
    await sleep(300);
    assert.equal((await told(s)).length, 1, 'said once');
    const off = await start({ env, config: { updateCheck: false } });
    const before = asked;
    await sleep(2000);
    assert.equal(asked, before, 'updateCheck false: never asks');
    assert.deepEqual(await told(off), []);
  } finally { releases.close(); }
});

test('youtubeCookies in config.json: handed to yt-dlp for downloads and for searches, playlists and the DJ (a cookies file, or a browser)', async () => {
  const s = await start({ config: { youtubeCookies: 'data/youtube-cookies.txt' }, initial: playing });
  await s.logHas(/youtubeCookies should be a cookies file that exists \(like "data\/youtube-cookies\.txt"\) or a browser .*; downloading without cookies/);
  fs.writeFileSync(path.join(s.dir, 'data', 'youtube-cookies.txt'), '# Netscape HTTP Cookie File\n');
  await s.restart();
  await s.post('/add', { url: yt('cook_000001') });
  await s.post('/add', { url: 'cookie search' });
  const used = path.join(s.dir, 'cookies-used.log');
  await waitFor(() => fileHas(used, /^download --cookies .*youtube-cookies\.txt$/m) && fileHas(used, /^list --cookies .*youtube-cookies\.txt$/m), 5000, 'both to use the cookies file');
  const b = await start({ config: { youtubeCookies: 'Firefox' }, initial: playing });
  await b.post('/add', { url: yt('cook_000002') });
  await waitFor(() => fileHas(path.join(b.dir, 'cookies-used.log'), /^download --cookies-from-browser firefox$/m), 5000, 'the browser\'s cookies');
});

test('a backup of the accounts, logins, queue and settings once a day, keeping the last 7 days', async () => {
  const s = await start({ env: { COUCHWAVE_TIME_SCALE: '0.01' } });
  await s.state();
  const backups = path.join(s.dir, 'data', 'backups'), day = path.join(backups, today());
  await waitFor(() => fs.existsSync(path.join(day, 'state.json')), 5000, 'today\'s backup');
  for (const f of ['state.json', 'logins.json', 'config.json']) assert.ok(fs.existsSync(path.join(day, f)), f);
  await s.stop();
  for (let i = 1; i <= 9; i++) fs.mkdirSync(path.join(backups, `2020-01-0${i}`));
  await s.start();
  await waitFor(() => fs.readdirSync(backups).length === 7, 5000, 'only the last 7 days to be kept');
  const kept = fs.readdirSync(backups).sort();
  assert.equal(kept[0], '2020-01-04', 'the oldest went');
  assert.equal(kept.at(-1), today(), 'today\'s is kept');
});

test('/health, for uptime monitors and Docker: OK without logging in, and a problem (503) while saving or reading accounts fails, until it\'s fixed', async () => {
  const s = await start({ expectProblems: /save failed|accounts\.json/ });
  const health = async () => { const r = await s.get('/health', { cookie: '' }); return [r.status, r.json]; };
  assert.deepEqual(await health(), [200, { ok: true }]);
  const head = await s.req('HEAD', '/health', { cookie: '' });
  assert.deepEqual([head.status, head.body.length], [200, 0], 'HEAD works too');
  fs.rmSync(s.statePath, { force: true });
  fs.mkdirSync(s.statePath);
  await s.post('/chat', { text: 'this can\'t be saved' });
  assert.deepEqual(await health(), [503, { ok: false, problem: 'can\'t save to data/state.json: see data/server.log' }]);
  fs.rmdirSync(s.statePath);
  await s.post('/chat', { text: 'saved again' });
  assert.deepEqual(await health(), [200, { ok: true }], 'fixed: OK again');
  const accounts = path.join(s.dir, 'data', 'accounts.json'), good = fs.readFileSync(accounts, 'utf8');
  fs.writeFileSync(accounts, '{ broken');
  assert.deepEqual(await health(), [503, { ok: false, problem: 'can\'t read data/accounts.json: see data/server.log' }]);
  fs.writeFileSync(accounts, good);
  assert.deepEqual(await health(), [200, { ok: true }]);
});
});
