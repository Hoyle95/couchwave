// ---------- Updating Couchwave to the newest release ----------
const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const common = require('./common');
const { ROOT, DATA, RELEASES, newer, newestOf, configFile, writeAtomic, secs } = common;

const UPDATES = path.join(DATA, 'update');
const STAGE = path.join(UPDATES, 'new'), PREVIOUS = path.join(UPDATES, 'previous'), LOCK = path.join(UPDATES, 'lock');
const KEPT_DATA = ['accounts.json', 'state.json', 'logins.json', 'login-key', 'dj.json'];
const HEADERS = { 'User-Agent': 'Couchwave', Accept: 'application/vnd.github+json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- Zip files ----------
function readZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const files = [], count = buf.readUInt16LE(end + 10);
  for (let i = 0, p = buf.readUInt32LE(end + 16); i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('a damaged zip file');
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), full = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28), attributes = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('a damaged zip file');
    const at = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28), packed = buf.subarray(at, at + size);
    const data = method === 0 ? Buffer.from(packed) : method === 8 ? zlib.inflateRawSync(packed) : null;
    if (!data || data.length !== full) throw new Error(`can't unpack ${name}`);
    files.push({ name, data, runnable: ((attributes >>> 16) & 0o111) !== 0 });
  }
  return files;
}
const safeName = name => !/^[/\\]|\\|:|(^|\/)\.\.?(\/|$)|(^|\/)\.git(\/|$)/.test(name);
const kept = name => name === 'config.json' || name.startsWith('data/');

// ---------- Batch files that may be running ----------
function batchSafe(oldText, newText) {
  const line = /^[^\S\r\n]*node\b.*(\r?\n|$)/im.exec(oldText);
  if (!line) return oldText === newText;
  return newText.startsWith(oldText.slice(0, line.index + line[0].length));
}

// ---------- Putting files in place ----------
function retry(fn) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (err) {
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
const order = name => (name === 'server.js' ? 3 : /^lib\/.*\.js$/.test(name) ? 2 : /\.cmd$/i.test(name) ? 1 : 0);
function putInPlace(from, names, waiting) {
  for (const name of [...names].sort((a, b) => order(a) - order(b))) {
    const src = path.join(from, name), dest = path.join(ROOT, name), data = fs.readFileSync(src);
    let old = null;
    try { old = fs.readFileSync(dest); } catch {}
    if (old && old.equals(data)) continue;
    if (old && /\.cmd$/i.test(name) && !batchSafe(old.toString('latin1'), data.toString('latin1'))) {
      fs.writeFileSync(dest + '.new', data);
      waiting.push(name);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.updating`;
    fs.writeFileSync(tmp, data);
    try { fs.chmodSync(tmp, fs.statSync(src).mode); } catch {}
    retry(() => fs.renameSync(tmp, dest));
  }
}
function backUp(names) {
  fs.rmSync(PREVIOUS, { recursive: true, force: true });
  const added = [];
  for (const name of names) {
    const dest = path.join(ROOT, name);
    if (!fs.existsSync(dest)) { added.push(name); continue; }
    fs.mkdirSync(path.dirname(path.join(PREVIOUS, name)), { recursive: true });
    fs.copyFileSync(dest, path.join(PREVIOUS, name));
  }
  writeAtomic(path.join(PREVIOUS, 'update.json'), JSON.stringify({ version: common.VERSION, added }));
}
function goBack(names) {
  const { added } = JSON.parse(fs.readFileSync(path.join(PREVIOUS, 'update.json'), 'utf8'));
  putInPlace(PREVIOUS, names.filter(n => !added.includes(n)), []);
  for (const name of added) fs.rmSync(path.join(ROOT, name), { force: true });
}

// ---------- Is it running? ----------
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const isCouchwave = port => fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: AbortSignal.timeout(2000) })
  .then(r => r.json()).then(m => m.name === 'Couchwave', () => false);
const versionIn = file => { try { return (/const VERSION = '([^']+)'/.exec(fs.readFileSync(file, 'utf8')) || [])[1]; } catch { return undefined; } };

async function tryOut() {
  const data = path.join(STAGE, 'data');
  fs.mkdirSync(data, { recursive: true });
  for (const f of KEPT_DATA) { try { fs.copyFileSync(path.join(DATA, f), path.join(data, f)); } catch {} }
  const port = await freePort();
  fs.writeFileSync(path.join(STAGE, 'config.json'), JSON.stringify({ ...configFile(), port, updateCheck: false }));
  const env = { ...process.env, COUCHWAVE_CHECK_TOOLS: 'no', COUCHWAVE_RELEASES_URL: 'http://127.0.0.1:9/', COUCHWAVE_FAKE_TOOLS: process.env.COUCHWAVE_FAKE_TOOLS || path.join(STAGE, 'no-tools') };
  const proc = spawn(process.execPath, ['server.js'], { cwd: STAGE, env, stdio: 'ignore' });
  let exited = null;
  const gone = new Promise(r => proc.on('exit', code => { exited = code ?? 'stopped'; r(); }));
  try {
    for (const end = Date.now() + 60000; Date.now() < end; await sleep(250)) {
      if (exited !== null) return `it stopped straight away, with code ${exited}`;
      if (await isCouchwave(port)) return null;
    }
    return 'it took over a minute';
  } finally {
    if (exited === null) { proc.kill(); await Promise.race([gone, sleep(5000)]); }
  }
}

async function runningAs(askServer, version) {
  for (const end = Date.now() + secs(90); Date.now() < end; await sleep(1000)) {
    const reply = await askServer({ status: true }, true);
    if (reply && reply.version === version) return true;
  }
  return false;
}

// ---------- The update ----------
module.exports = async function update(args, { askServer, askYesNo }) {
  const fail = text => { console.log(text); process.exit(1); };
  if (fs.existsSync(path.join(ROOT, '.git'))) fail('This Couchwave is a copy of the git repository: update it with git pull instead. Nothing was changed.');
  if (fs.existsSync('/.dockerenv')) fail('Couchwave is running in Docker: update it by pulling the newest image. Nothing was changed.');
  fs.mkdirSync(UPDATES, { recursive: true });
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' }); } catch {
    if (Date.now() - fs.statSync(LOCK).mtimeMs < 15 * 60000) fail('Another update is already running. Wait for it to finish.');
    fs.writeFileSync(LOCK, String(process.pid));
  }
  process.on('exit', () => { try { fs.rmSync(LOCK, { force: true }); } catch {} });
  const was = common.VERSION;

  console.log(`This is Couchwave v${was}. Checking for a newer version…`);
  const newest = newestOf(await fetch(RELEASES, { headers: HEADERS, signal: AbortSignal.timeout(15000) }).then(r => r.json()).catch(() => null));
  if (!newest) fail('Couldn\'t check GitHub for a newer version (is this computer online?). Nothing was changed.');
  if (!newer(newest.tag_name, was)) { console.log(`Couchwave v${was} is already the newest version.`); process.exit(0); }
  const tag = newest.tag_name.slice(0, 40);
  const asset = (Array.isArray(newest.assets) ? newest.assets : []).find(a => a && /^couchwave-.*\.zip$/.test(a.name));
  const sum = asset && /^sha256:([0-9a-f]{64})$/i.exec(String(asset.digest || ''));
  if (!asset) fail(`${tag} is out, but its download isn't ready yet. Try again in a few minutes. Nothing was changed.`);
  if (!sum) fail(`${tag} is out, but GitHub gave no checksum to check its download against, so it wasn't installed. Nothing was changed.`);

  const status = await askServer({ status: true }, true);
  const how = status ? status.runBy || 'none' : null;
  if (process.stdin.isTTY && !args.includes('--yes')) {
    const busy = status && status.online ? `Couchwave restarts to update, which stops the music for a few seconds (${status.online} online now).\n` : '';
    if (!(await askYesNo(`Update to ${tag}? What's new: ${newest.html_url || 'see the Releases page'}\n${busy}[y/N] `))) fail('Nothing was changed.');
  }

  console.log(`Downloading ${asset.name}…`);
  const zip = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'Couchwave' }, signal: AbortSignal.timeout(300000) })
    .then(r => (r.ok ? r.arrayBuffer() : null)).then(b => b && Buffer.from(b), () => null);
  if (!zip) fail('Couldn\'t download it. Nothing was changed. Try again later.');
  if (crypto.createHash('sha256').update(zip).digest('hex') !== sum[1].toLowerCase()) fail('The download doesn\'t match its checksum, so it wasn\'t installed. Nothing was changed.');
  let files;
  try { files = readZip(zip).filter(f => !kept(f.name)); } catch (err) { fail(`The download couldn't be unpacked (${err.message}). Nothing was changed.`); }
  if (!files.every(f => safeName(f.name)) || !files.some(f => f.name === 'server.js')) fail('The download doesn\'t look like Couchwave, so it wasn\'t installed. Nothing was changed.');
  fs.rmSync(STAGE, { recursive: true, force: true });
  for (const f of files) {
    const to = path.join(STAGE, f.name);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, f.data, { mode: f.runnable ? 0o755 : 0o644 });
  }
  const version = versionIn(path.join(STAGE, 'server.js'));
  if (!version || !newer(version, was)) fail(`The download says it's v${version || '?'}, not newer than v${was}, so it wasn't installed. Nothing was changed.`);
  const names = files.map(f => f.name);

  console.log(`Trying v${version} out before installing it…`);
  const problem = await tryOut();
  if (problem) fail(`v${version} didn't start in a trial run (${problem}), so it wasn't installed. Nothing was changed. Its log is in data/update/new/data/server.log`);

  if (how === 'none') {
    console.log('Stopping Couchwave to update it…');
    const stopped = await askServer({ stop: true }, true);
    if (!stopped || !stopped.ok) fail(`Couldn't stop Couchwave${stopped ? ` (${stopped.text})` : ''}. Nothing was changed.`);
    const port = Number(configFile().port) || 3000;
    for (const end = Date.now() + 20000; await isCouchwave(port); await sleep(500)) if (Date.now() > end) fail('Couchwave didn\'t stop. Nothing was changed.');
  }
  console.log(`Installing v${version}…`);
  const waiting = [];
  try { backUp(names); putInPlace(STAGE, names, waiting); } catch (err) {
    try { goBack(names); } catch {}
    fail(`Couldn't put the new files in place (${err.message}), so the old ones were put back.`);
  }
  const notes = [
    ...waiting.map(n => `${n} changed too. It was saved as ${n}.new, because it may be running: stop Couchwave (stop.cmd), rename ${n}.new to ${n}, then start it again.`),
    'The version it replaced is kept in data/update/previous.',
  ];
  const finish = text => {
    fs.rmSync(STAGE, { recursive: true, force: true });
    console.log([text, ...notes].join('\n'));
    process.exit(0);
  };

  if (how === 'watch' || how === 'systemd') {
    console.log('Restarting Couchwave…');
    if (how === 'systemd') await askServer({ restart: true }, true);
    if (await runningAs(askServer, version)) finish(`Done: Couchwave is now v${version} (it was v${was}). What's new: ${newest.html_url || 'see the Releases page'}`);
    console.log(`v${version} didn't start, so Couchwave is going back to v${was}…`);
    goBack(names);
    if (await runningAs(askServer, was)) fail(`Couchwave is running v${was} again. Nothing else was changed. Why v${version} didn't start is in data/server.log`);
    fail(`The old files are back, but Couchwave isn't running. Start it again (${how === 'systemd' ? 'sudo systemctl restart couchwave' : 'start.cmd, or Start-ScheduledTask Couchwave'}); data/server.log says what went wrong.`);
  }
  finish(how === 'none'
    ? `Done: v${version} is installed (it was v${was}). Start Couchwave again: node server.js`
    : `Done: v${version} is installed (it was v${was}). It runs the next time Couchwave starts.`);
};
Object.assign(module.exports, { readZip, batchSafe, safeName });
