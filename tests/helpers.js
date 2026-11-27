// ---------- Throwaway test servers and shared helpers ----------
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_FILES = ['server.js', 'lib', 'public'];
const PASSWORD = 'test-password';
const ownPassword = name => 'own-' + name;
const TIME = 0.25;
const secs = n => n * 1000 * TIME;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SLOW = process.env.CI ? 3 : 1;

async function waitFor(fn, ms = 5000, what = 'condition') {
  ms *= SLOW;
  const end = Date.now() + ms;
  for (;;) {
    let timer;
    const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error(`timed out after ${ms}ms waiting for: ${what} (it stopped answering)`)), Math.max(end - Date.now(), 2000)); });
    const v = await Promise.race([fn(), late]).finally(() => clearTimeout(timer));
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
    await sleep(50);
  }
}

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const yt = id => `https://www.youtube.com/watch?v=${id}`;

// ---------- A copy of Couchwave in a folder of its own (for tests that start it themselves) ----------
const TOOL_ENV = { COUCHWAVE_FAKE_TOOLS: path.join(__dirname, 'fakes'), COUCHWAVE_CHECK_TOOLS: 'no', COUCHWAVE_RELEASES_URL: 'http://127.0.0.1:9/no-internet-in-tests', COUCHWAVE_COUNT_URL: 'http://127.0.0.1:9/no-internet-in-tests' };
const testEnv = (...extra) => Object.assign(Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('COUCHWAVE_'))), TOOL_ENV, ...extra);
function appCopy(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchwave-copy-'));
  for (const f of [...APP_FILES, ...extra]) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  return { dir, clean: () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} } };
}
const run = (dir, args, { env = {}, input, timeout = 30000 } = {}) => new Promise(resolve => {
  const p = require('child_process').execFile(process.execPath, ['server.js', ...args], { cwd: dir, encoding: 'utf8', timeout, env: testEnv(env) },
    (err, stdout, stderr) => resolve({ status: !err ? 0 : typeof err.code === 'number' ? err.code : err.killed ? 'timed out' : err.signal || 1, stdout, stderr, out: stdout + stderr }));
  if (input !== undefined) p.stdin.end(input);
});

let fileNo = 0;
function song(id, title, by = 'Alice', extra = {}) {
  return { id, url: yt(`song${String(id).padStart(7, '0')}`), title, by, status: 'ready', duration: 200, file: `test-${id}-${++fileNo}.mp4`, ...extra };
}

class Server {
  constructor({ initial, files, expectProblems, config, env, nodeArgs } = {}) { this.initial = initial; this.files = files || {}; this.expectProblems = expectProblems; this.config = config; this.env = env; this.nodeArgs = nodeArgs || []; this.out = ''; }

  async start() {
    if (!this.dir) {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchwave-test-'));
      for (const f of APP_FILES) fs.cpSync(path.join(ROOT, f), path.join(this.dir, f), { recursive: true });
      fs.mkdirSync(path.join(this.dir, 'data', 'downloads'), { recursive: true });
      await this.newPort();
      if (this.initial) {
        const s = { nextId: 100, queue: [], current: null, startedAt: Date.now(), paused: false, pausedAt: 0, log: [], chat: [], colors: {}, faces: {}, ...this.initial };
        for (const q of [s.current, ...s.queue]) if (q && q.file && !this.files[q.file]) this.files[q.file] = Buffer.alloc(64 * 1024, q.id % 256);
        fs.writeFileSync(this.statePath, JSON.stringify(s));
      }
      for (const [name, data] of Object.entries(this.files)) fs.writeFileSync(path.join(this.dir, 'data', 'downloads', name), data);
    }
    for (let tries = 1; ; tries++) {
      const started = () => (this.logText().match(new RegExp(`Running on http://localhost:${this.port}\\b`, 'g')) || []).length;
      const before = started();
      this.out += `
---- starting ----
`;
      this.proc = spawn(process.execPath, [...this.nodeArgs, 'server.js'], { cwd: this.dir, env: testEnv({ COUCHWAVE_TIME_SCALE: String(TIME) }, this.env) });
      this.proc.stdout.on('data', d => (this.out += d));
      this.proc.stderr.on('data', d => (this.out += d));
      let gone = false;
      this.proc.once('exit', () => (gone = true));
      await waitFor(async () => gone || (started() > before && (await this.req('GET', '/manifest.json', { cookie: '' }).catch(() => null))), 10000, 'the server to start');
      if (!gone) return this;
      if (tries >= 3 || !/already in use/.test(this.logText())) throw new Error(`the server stopped while starting:\n${this.out}\n${this.logText().slice(-2000)}`);
      await this.newPort();
    }
  }
  async newPort() {
    this.port = await freePort();
    fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ password: PASSWORD, port: this.port, ...this.config }));
  }
  logText() { try { return fs.readFileSync(this.logFile, 'utf8'); } catch { return ''; } }
  get statePath() { return path.join(this.dir, 'data', 'state.json'); }
  get logFile() { return path.join(this.dir, 'data', 'server.log'); }
  logHas(re, ms = 3000) { return waitFor(() => { try { return re.test(fs.readFileSync(this.logFile, 'utf8')); } catch { return false; } }, ms, `the log to say ${re}`); }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    const exited = new Promise(r => this.proc.on('exit', r));
    this.proc.kill();
    await exited;
  }
  async restart() { await this.stop(); await this.start(); }
  async close() {
    for (const t of this.timers || []) clearInterval(t);
    await this.stop();
    const problems = this.dir ? this.problems() : [];
    if (this.dir) { try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {} }
    if (problems.length) throw new Error('the server logged problems:\n' + problems.join('\n'));
  }

  async login(name = 'Alice', { password = PASSWORD, own = ownPassword(name) } = {}) {
    const r = await this.req('POST', '/login', { body: { password, name, own }, cookie: '' });
    if (r.status !== 204) throw new Error(`login as ${name} failed: ${r.status} ${r.text}`);
    return /auth=([^;]*)/.exec(r.headers['set-cookie'].find(c => c.startsWith('auth=')))[1];
  }
  async cookie(name = 'Alice') {
    this.auths ||= Object.create(null);
    this.auths[name] ||= this.login(name);
    try { return `auth=${await this.auths[name]}; name=${encodeURIComponent(name)}`; }
    catch (e) { delete this.auths[name]; throw e; }
  }
  forget(name) { if (name) delete (this.auths || {})[name]; else this.auths = Object.create(null); }
  command(...args) { return run(this.dir, args); }

  async req(method, url, { as = 'Alice', body, cookie, headers = {}, host = '127.0.0.1' } = {}) {
    if (cookie === undefined) cookie = await this.cookie(as);
    return new Promise((resolve, reject) => {
      const r = http.request({ host, port: this.port, path: url, method, headers: { Cookie: cookie, ...headers } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const b = Buffer.concat(chunks);
          let json; try { json = JSON.parse(b); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString(), json });
        });
      });
      r.on('error', reject);
      r.setTimeout(30000, () => r.destroy(new Error(`${method} ${url}: no answer within 30 seconds`)));
      if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
      r.end();
    });
  }
  get(url, opts) { return this.req('GET', url, opts); }
  post(url, body, opts = {}) { return this.req('POST', url, { ...opts, body }); }
  async state(as = 'Alice') { return (await this.get('/state', { as })).json; }
  async queued(pred = () => true, as) { return (await this.state(as)).queue.find(pred); }
  async log(as = 'Alice') { return (await this.state(as)).log.map(e => `${e.by}: ${e.text}`); }

  keepOnline(...names) {
    const check = () => { for (const n of names) this.state(n).catch(() => {}); };
    const t = setInterval(check, secs(2));
    t.unref();
    (this.timers ||= []).push(t);
    return Promise.all(names.map(n => this.state(n))).then(() => () => clearInterval(t));
  }

  problems() {
    let logged = '';
    try { logged = fs.readFileSync(this.logFile, 'utf8'); } catch {}
    return (this.out + '\n' + logged).split('\n')
      .filter(l => /CRASH|Error|Warning|at .*server\.js/.test(l) && !/yt-dlp|ERROR: \[youtube\]|ERROR: unable to download|HTTP Error/.test(l))
      .filter(l => !(this.expectProblems && this.expectProblems.test(l)));
  }
}

function testServers({ after }) {
  const all = [];
  after(async () => {
    const failed = [];
    for (const s of all) { try { await s.close(); } catch (e) { failed.push(e.message); } }
    if (failed.length) throw new Error(failed.join('\n'));
  });
  return async (opts) => { const s = new Server(opts); all.push(s); return s.start(); };
}

module.exports = { Server, testServers, song, yt, waitFor, sleep, secs, TIME, PASSWORD, ownPassword, ROOT, APP_FILES, TOOL_ENV, testEnv, appCopy, run, freePort };
