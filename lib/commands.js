// ---------- Commands for whoever runs Couchwave ----------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const common = require('./common');
const { DATA, STATE, REQUESTS, writeAtomic, configFile, savedState, RELEASES, newer, newestOf, FAKE_TOOLS, videoId, CLEARABLE, clearedText } = common;
const accounts = require('./accounts');

module.exports = function runCommand(command, args) {
  if (command === '--version') { console.log(common.VERSION); process.exit(0); }
  if (command === '--update') return require('./update')(args, { askServer, askYesNo });
  if (command === '--logout-everyone') return logoutEveryone();
  if (command === '--delete-account' || command === '--set-password') return changeAccount(command, args);
  if (command === '--stop') return stopCommand();
  if (command === '--status') return statusCommand();
  if (command === '--remove-song') return removeSongCommand(args.join(' ').trim());
  if (command === '--clear') return clearCommand(args.map(w => w.toLowerCase().replace(/^-+/, '')));
};

// ---------- Accounts and logins ----------
function logoutEveryone() {
  accounts.newLoginKey();
  console.log('Done: everyone is logged out and has to enter the password again.');
  process.exit(0);
}

function changeAccount(command, args) {
  const name = accounts.cleanName(args[0]);
  let list;
  try { list = accounts.readAccounts(); } catch (err) { console.log(`Can't read ${accounts.ACCOUNTS}: ${err.message}`); process.exit(1); }
  const key = accounts.nameKey(name), acc = Object.hasOwn(list, key) ? list[key] : null;
  if (!name || !accounts.isAccount(acc)) {
    const names = Object.values(list).filter(accounts.isAccount).map(a => a.name);
    console.log(`No account "${name}". Accounts: ${names.join(', ') || 'none yet'}`);
    process.exit(1);
  }
  if (command === '--delete-account') {
    list[key] = { name: acc.name, deleted: Date.now() };
    accounts.writeAccounts(list);
    console.log(`Done: "${acc.name}" is deleted and logged out. Whoever joins with that nickname next starts fresh.`);
    process.exit(0);
  }
  const setPassword = password => {
    if (password.length < accounts.MIN_OWN_PASSWORD) {
      console.log(`That's too short: it needs at least ${accounts.MIN_OWN_PASSWORD} characters. Nothing was changed.`);
      process.exit(1);
    }
    const now = accounts.readAccounts(), salt = crypto.randomBytes(16).toString('hex');
    now[key] = { ...now[key], salt, hash: crypto.scryptSync(password, salt, 32).toString('hex') };
    accounts.writeAccounts(now);
    console.log(`Done: "${acc.name}" has a new password and is logged out everywhere. Send them the new password.`);
    process.exit(0);
  };
  if (args[1] !== undefined) return setPassword(String(args[1]));
  askQuietly(`New password for "${acc.name}" (it won't show as you type): `).then(setPassword);
}

// ---------- Asking whoever runs it ----------
function askQuietly(question) {
  const input = process.stdin;
  process.stdout.write(question);
  input.setEncoding('utf8');
  return new Promise(resolve => {
    let typed = '', finished = false;
    const done = () => { if (finished) return; finished = true; input.off('data', onData); if (input.isTTY) input.setRawMode(false); input.pause(); process.stdout.write('\n'); resolve(typed); };
    const onData = text => {
      for (const c of text) {
        if (c === '\r' || c === '\n') return done();
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(1); }
        if (c === '\u007f' || c === '\b') typed = typed.slice(0, -1);
        else typed += c;
      }
    };
    if (input.isTTY) input.setRawMode(true);
    input.on('data', onData);
    input.on('end', done);
    input.resume();
  });
}
const askYesNo = question => new Promise(resolve => {
  process.stdout.write(question);
  process.stdin.setEncoding('utf8');
  process.stdin.once('data', d => { process.stdin.pause(); resolve(/^\s*y/i.test(d)); });
  process.stdin.once('end', () => resolve(false));
  process.stdin.resume();
});

// ---------- Asking the running server ----------
async function askServer(request, keep) {
  const port = Number(configFile().port) || 3000;
  const running = await fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: AbortSignal.timeout(3000) })
    .then(r => r.json()).then(m => m.name === 'Couchwave', () => false);
  if (!running) return;
  fs.mkdirSync(REQUESTS, { recursive: true });
  const file = path.join(REQUESTS, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`);
  writeAtomic(file + '.json', JSON.stringify(request));
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 100));
    let reply;
    try { reply = JSON.parse(fs.readFileSync(file + '.reply', 'utf8')); } catch { continue; }
    fs.rmSync(file + '.reply', { force: true });
    if (keep) return reply;
    console.log(reply.text);
    process.exit(reply.ok ? 0 : 1);
  }
  fs.rmSync(file + '.json', { force: true });
  const why = `Couchwave on port ${port} didn't answer within 10 seconds (if it was started from a different folder, run this there)`;
  if (keep) return { ok: false, text: why + '.' };
  console.log(why + '. Nothing was changed.');
  process.exit(1);
}

// ---------- Stopping ----------
function stopCommand() {
  askServer({ stop: true }, true).then(reply => {
    console.log(reply ? reply.text : 'Couchwave isn\'t running.');
    process.exit(!reply || reply.ok ? 0 : 1);
  });
}

// ---------- Status ----------
function toolVersion(name, flag) {
  return new Promise(resolve => {
    const p = FAKE_TOOLS ? spawn(process.execPath, [path.join(FAKE_TOOLS, name + '.js'), flag]) : spawn(name, [flag]);
    const timer = setTimeout(() => p.kill(), 10000);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('error', () => { clearTimeout(timer); resolve(`${name}: not found`); });
    p.on('close', code => {
      clearTimeout(timer);
      const first = String(out).trim().split(/\r?\n/)[0];
      resolve(code === 0 && first ? `${name} ${first.replace(/^ff\w+ version /, '').split(' ')[0]}` : `${name}: not found`);
    });
  });
}
async function statusCommand() {
  const reply = await askServer({ status: true }, true), lines = [];
  if (reply) lines.push(reply.text);
  else {
    const s = savedState(), count = v => (Array.isArray(v) ? v.length : 0);
    lines.push(`Couchwave v${common.VERSION} isn't running.`, `Saved: ${count(s.queue)} song${count(s.queue) === 1 ? '' : 's'} in the queue, ${count(s.history)} in the played history.`);
  }
  try { const st = fs.statfsSync(DATA); lines.push(`Disk: ${(st.bavail * st.bsize / 1024 ** 3).toFixed(1)} GB free`); } catch {}
  const tools = await Promise.all([toolVersion('yt-dlp', '--version'), toolVersion('ffmpeg', '-version'), toolVersion('ffprobe', '-version')]);
  lines.push(`Tools: ${[...tools, `Node.js ${process.versions.node}`].join(', ')}`);
  if (configFile().updateCheck !== false) {
    const newest = await fetch(RELEASES, { headers: { 'User-Agent': 'Couchwave', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) })
      .then(r => r.json()).then(newestOf, () => null);
    lines.push(!newest ? 'Newest release: couldn\'t check'
      : newer(newest.tag_name, common.VERSION) ? `Newest release: ${newest.tag_name}, newer than this one: update with node server.js --update (or update.cmd on Windows)`
      : `Newest release: ${newest.tag_name} (this is up to date)`);
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

// ---------- Removing a song ----------
const songLine = (queue, q) => `${queue.indexOf(q) + 1}. ${q.title} (added by ${q.by})`;
function queueList(queue) {
  if (!queue.length) return 'The queue is empty.';
  return queue.slice(0, 50).map(q => songLine(queue, q)).join('\n') + (queue.length > 50 ? `\n…and ${queue.length - 50} more` : '');
}
function findSong(queue, what) {
  if (/^\d+$/.test(what)) {
    const q = queue[Number(what) - 1];
    if (q) return { song: q };
    return { problem: queue.length ? `There's no song ${what}: the queue has ${queue.length}.\n\n${queueList(queue)}` : 'The queue is empty.' };
  }
  const id = videoId(what);
  const found = id ? queue.filter(q => videoId(q.url) === id) : queue.filter(q => String(q.title).toLowerCase().includes(what.toLowerCase()));
  if (found.length === 1) return { song: found[0] };
  if (found.length) return { problem: `${found.length} songs match "${what}". Use its number instead:\n${found.map(q => songLine(queue, q)).join('\n')}` };
  return { problem: `Nothing in the queue matches "${what}".\n\n${queueList(queue)}` };
}
async function removeSongCommand(what) {
  const queue = (s => (Array.isArray(s.queue) ? s.queue.filter(q => q && typeof q === 'object') : []))(savedState());
  if (!what) {
    console.log(`Usage: node server.js --remove-song <queue number, YouTube link or part of the name>\n\n${queueList(queue)}`);
    process.exit(1);
  }
  const { song, problem } = findSong(queue, what);
  if (problem) { console.log(problem); process.exit(1); }
  if (process.stdin.isTTY && !(await askYesNo(`Remove ${songLine(queue, song)}? [y/N] `))) { console.log('Nothing was changed.'); process.exit(1); }
  await askServer({ removeSong: song.id });
  const state = savedState(), at = (Array.isArray(state.queue) ? state.queue : []).findIndex(q => q && q.id === song.id);
  if (at < 0) { console.log('That song isn\'t in the queue any more. Nothing was changed.'); process.exit(1); }
  state.queue.splice(at, 1);
  state.log = [...(Array.isArray(state.log) ? state.log : []), { t: Date.now(), by: 'server', text: `removed "${song.title}" (whoever runs Couchwave did)` }].slice(-200);
  writeAtomic(STATE, JSON.stringify(state));
  console.log(`Done: removed "${song.title}" from the queue.`);
  process.exit(0);
}

// ---------- Clearing ----------
async function clearCommand(words) {
  const state = savedState(), count = v => (Array.isArray(v) ? v.length : 0);
  const asked = words.map(w => (w === 'log' ? 'activity' : w));
  const what = asked.includes('all') ? Object.keys(CLEARABLE) : [...new Set(asked)].filter(w => CLEARABLE[w]);
  if (!what.length || asked.some(w => w !== 'all' && !CLEARABLE[w])) {
    console.log('Usage: node server.js --clear <history | activity | chat | all>   (one or more, like: --clear chat activity)\n\n'
      + `Now: ${count(state.history)} songs in the played history, ${count(state.log)} lines in Activity, ${count(state.chat)} chat messages.`);
    process.exit(1);
  }
  if (process.stdin.isTTY && !(await askYesNo(`Clear ${clearedText(what)}? It can't be undone. [y/N] `))) { console.log('Nothing was changed.'); process.exit(1); }
  await askServer({ clear: what });
  if (what.includes('history')) state.history = [];
  if (what.includes('chat')) state.chat = [];
  if (what.includes('activity')) state.log = [];
  state.log = [...(Array.isArray(state.log) ? state.log : []), { t: Date.now(), by: 'server', text: `cleared ${clearedText(what)} (whoever runs Couchwave did)` }].slice(-200);
  writeAtomic(STATE, JSON.stringify(state));
  console.log(`Done: cleared ${clearedText(what)}.`);
  process.exit(0);
}
