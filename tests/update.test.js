// ---------- node server.js --update ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), http = require('http'), zlib = require('zlib'), crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { waitFor, sleep, ROOT, PASSWORD, TOOL_ENV, appCopy, run, freePort } = require('./helpers');
const { readZip, batchSafe } = require('../lib/update');

const versionIn = text => /const VERSION = '([^']+)'/.exec(text)[1];
const OLD = versionIn(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8')), NEW = '9.9.9';
const servers = [], dirs = [];
after(() => {
  for (const s of servers) s.close();
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
});

// ---------- A release, and a GitHub to get it from ----------
function makeZip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), data = zlib.deflateRawSync(f.data);
    const local = Buffer.alloc(30), head = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26);
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(8, 10);
    head.writeUInt32LE(data.length, 20); head.writeUInt32LE(f.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42);
    parts.push(local, name, data);
    central.push(head, name);
    offset += 30 + name.length + data.length;
  }
  const dir = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const filesUnder = rel => (fs.statSync(path.join(ROOT, rel)).isFile() ? [rel] : fs.readdirSync(path.join(ROOT, rel)).flatMap(n => filesUnder(`${rel}/${n}`)));
function release(version, change = s => s) {
  const files = ['server.js', ...filesUnder('lib'), ...filesUnder('public'), 'update.cmd'].map(name => ({ name, data: name === 'server.js'
    ? Buffer.from(change(fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/const VERSION = '[^']+'/, `const VERSION = '${version}'`)))
    : fs.readFileSync(path.join(ROOT, name)) }));
  return makeZip([...files, { name: `NEW-IN-${version}.txt`, data: Buffer.from('new\n') }]);
}
async function github(zip, { version = NEW, digest } = {}) {
  const sum = digest || 'sha256:' + crypto.createHash('sha256').update(zip).digest('hex');
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/releases') {
      return res.end(JSON.stringify([{ tag_name: `v${version}`, draft: false, html_url: 'https://example.com/notes',
        assets: [{ name: `couchwave-v${version}.zip`, browser_download_url: `${base}/zip`, digest: sum }] }]));
    }
    if (req.url === '/zip') return res.end(zip);
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/releases`;
}

// ---------- A Couchwave to update ----------
async function folder() {
  const { dir } = appCopy();
  dirs.push(dir);
  const port = await freePort();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ password: PASSWORD, port }));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'state.json'), JSON.stringify({ chat: [{ t: 1, by: 'Alice', text: 'kept across the update' }] }));
  const env = { ...process.env, ...TOOL_ENV, COUCHWAVE_TIME_SCALE: '0.1' };
  const read = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const cli = (args, extra = {}) => run(dir, args, { timeout: 90000, env: { COUCHWAVE_TIME_SCALE: '0.1', ...extra } });
  const up = () => waitFor(() => fetch(`http://127.0.0.1:${port}/manifest.json`).then(x => x.ok, () => false), 15000, 'Couchwave to start');
  return { dir, port, env, read, cli, up, version: () => versionIn(read('server.js')),
    update: (url, scale = '0.4') => cli(['--update'], { COUCHWAVE_RELEASES_URL: url, COUCHWAVE_TIME_SCALE: scale }) };
}

describe('updating', { concurrency: true }, () => {
  test('not running: checks the download, tries it out, installs it, and keeps config.json, data/ and the old version', async () => {
    const f = await folder(), config = f.read('config.json');
    const r = await f.update(await github(release(NEW)));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Trying v9\.9\.9 out before installing it/);
    assert.match(r.out, new RegExp(`Done: v9\\.9\\.9 is installed \\(it was v${OLD.replace(/\./g, '\\.')}\\)\\. It runs the next time Couchwave starts\\.`));
    assert.equal(f.version(), NEW);
    assert.ok(fs.existsSync(path.join(f.dir, 'NEW-IN-9.9.9.txt')), 'new files arrive');
    assert.ok(fs.existsSync(path.join(f.dir, 'update.cmd')));
    assert.equal(f.read('config.json'), config, 'config.json untouched');
    assert.match(f.read('data/state.json'), /kept across the update/, 'data/ untouched');
    assert.equal(versionIn(f.read('data/update/previous/server.js')), OLD, 'the old version is kept');
    assert.ok(!fs.existsSync(path.join(f.dir, 'data', 'update', 'new')), 'the download is cleaned up');
    assert.ok(!fs.existsSync(path.join(f.dir, 'data', 'update', 'lock')));
    assert.equal((await f.cli(['--version'])).out.trim(), NEW);
  });

  test('already the newest: says so and changes nothing', async () => {
    const f = await folder();
    const r = await f.update(await github(release(OLD), { version: OLD }));
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /is already the newest version/);
    assert.ok(!fs.existsSync(path.join(f.dir, 'data', 'update', 'previous')));
  });

  test('a download that doesn\'t match its checksum, or a release that won\'t start: not installed, nothing changed', async () => {
    const f = await folder();
    let r = await f.update(await github(release(NEW), { digest: 'sha256:' + '0'.repeat(64) }));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /doesn't match its checksum, so it wasn't installed\. Nothing was changed\./);
    r = await f.update(await github(release(NEW, s => 'process.exit(3);\n' + s)));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /v9\.9\.9 didn't start in a trial run \(it stopped straight away, with code 3\), so it wasn't installed\. Nothing was changed\./);
    assert.equal(f.version(), OLD);
    assert.ok(!fs.existsSync(path.join(f.dir, 'NEW-IN-9.9.9.txt')));
    assert.ok(!fs.existsSync(path.join(f.dir, 'data', 'update', 'previous')), 'nothing was swapped');
  });

  test('a copy of the git repository: says to use git pull', async () => {
    const f = await folder();
    fs.mkdirSync(path.join(f.dir, '.git'));
    const r = await f.update(await github(release(NEW)));
    assert.equal(r.status, 1);
    assert.match(r.out, /git pull/);
    assert.equal(f.version(), OLD);
  });

  test('under node --watch (as start.cmd runs it): restarts into the new version', async () => {
    const f = await folder(), url = await github(release(NEW));
    const watcher = spawn(process.execPath, ['--watch', 'server.js'], { cwd: f.dir, env: f.env, stdio: 'ignore' });
    try {
      await f.up();
      const r = await f.update(url);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /Done: Couchwave is now v9\.9\.9/);
      assert.match((await f.cli(['--status'])).out, /^Couchwave v9\.9\.9 is running/m);
    } finally { await f.cli(['--stop']); watcher.kill(); await sleep(300); }
  });

  test('under node --watch, when the new version won\'t start once it\'s in place: goes back to the old one', async () => {
    const f = await folder(), url = await github(release(NEW, s => s + "\nif (require('path').basename(__dirname) !== 'new') process.exit(3);\n"));
    const watcher = spawn(process.execPath, ['--watch', 'server.js'], { cwd: f.dir, env: f.env, stdio: 'ignore' });
    try {
      await f.up();
      const r = await f.update(url, '0.15');
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, new RegExp(`v9\\.9\\.9 didn't start, so Couchwave is going back to v${OLD.replace(/\./g, '\\.')}`));
      assert.match(r.out, /is running v.+ again/);
      assert.equal(f.version(), OLD);
      assert.ok(!fs.existsSync(path.join(f.dir, 'NEW-IN-9.9.9.txt')), 'files the new version added are gone again');
      assert.match((await f.cli(['--status'])).out, new RegExp(`^Couchwave v${OLD.replace(/\./g, '\\.')} is running`, 'm'));
    } finally { await f.cli(['--stop']); watcher.kill(); await sleep(300); }
  });

  test('as a systemd service: asks it to restart, and it comes back as the new version', async () => {
    const f = await folder(), url = await github(release(NEW));
    let proc, stopped = false;
    const run = () => {
      proc = spawn(process.execPath, ['server.js'], { cwd: f.dir, env: { ...f.env, COUCHWAVE_FAKE_SYSTEMD: '1' }, stdio: 'ignore' });
      proc.on('exit', () => { if (!stopped) setTimeout(run, 300); });
    };
    run();
    try {
      await f.up();
      const r = await f.update(url);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /Done: Couchwave is now v9\.9\.9/);
    } finally { stopped = true; proc.kill(); await sleep(300); }
  });

  test('started by hand: stops it, installs, and says to start it again', async () => {
    const f = await folder(), url = await github(release(NEW));
    const server = spawn(process.execPath, ['server.js'], { cwd: f.dir, env: f.env, stdio: 'ignore' });
    const exited = new Promise(r => server.on('exit', r));
    try {
      await f.up();
      const r = await f.update(url);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /Stopping Couchwave to update it/);
      assert.match(r.out, /Done: v9\.9\.9 is installed .*Start Couchwave again: node server\.js/);
      await Promise.race([exited, sleep(5000).then(() => { throw new Error('still running'); })]);
      assert.equal(f.version(), NEW);
    } finally { server.kill(); }
  });

  test('reads a real release zip (made the way GitHub\'s release workflow makes it)', { skip: spawnSync('git', ['--version']).status !== 0 }, () => {
    const zip = spawnSync('git', ['archive', '--format=zip', 'HEAD'], { cwd: ROOT, maxBuffer: 100e6 });
    if (zip.status !== 0) return;
    const files = readZip(zip.stdout), server = files.find(x => x.name === 'server.js');
    assert.ok(files.some(x => x.name === 'lib/start.js'));
    const lf = text => text.replace(/\r/g, '');
    assert.equal(lf(server.data.toString()), lf(spawnSync('git', ['show', 'HEAD:server.js'], { cwd: ROOT, encoding: 'utf8' }).stdout));
  });

  test('a batch file that may be running is only replaced when everything up to its node line stays the same', () => {
    const old = '@echo off\r\ncd /d "%~dp0"\r\nnode server.js --update\r\npause\r\n';
    assert.ok(batchSafe(old, old.replace('pause', 'timeout /t 5')), 'after the node line: fine');
    assert.ok(!batchSafe(old, old.replace('@echo off', '@echo off\r\nrem a new line')), 'before it: not');
    assert.ok(!batchSafe(old, old.replace('node server.js --update', 'node server.js --update --yes')), 'the node line itself: not');
  });
});
