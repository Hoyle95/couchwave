// Shared by the tests: starts a throwaway Couchwave in a temporary folder (its own copy of server.js and
// index.html, its own data/ and password, a free port), with stand-ins for yt-dlp / ffmpeg / ffprobe (fakes/).
// Your real server, songs and chat are never touched.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PASSWORD = 'test-password'; // the room password
const ownPassword = name => 'own-' + name; // each test person's own password
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait until fn() returns something truthy (it may be async), or fail after `ms`.
async function waitFor(fn, ms = 5000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out after ${ms}ms waiting for: ${what}`);
    await sleep(100);
  }
}

const freePort = () => new Promise(r => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });

// A pretend song (as it's saved in state.json), for setting up a server with a queue already in it.
let fileNo = 0;
function song(id, title, by = 'Alice', extra = {}) {
  return { id, url: `https://www.youtube.com/watch?v=song${String(id).padStart(7, '0')}`, title, by, status: 'ready', duration: 200, file: `test-${id}-${++fileNo}.mp4`, ...extra };
}

class Server {
  // initial: what to put in data/state.json first (songs from song() get files made for them).
  // files: { 'name.mp4': Buffer } extra files for data/downloads.
  constructor({ initial, files } = {}) { this.initial = initial; this.files = files || {}; }

  async start() {
    if (!this.dir) {
      this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'couchwave-test-'));
      for (const f of ['server.js', 'dj.js', 'index.html']) fs.copyFileSync(path.join(ROOT, f), path.join(this.dir, f));
      for (const d of ['icons', 'fonts']) fs.cpSync(path.join(ROOT, d), path.join(this.dir, d), { recursive: true });
      fs.mkdirSync(path.join(this.dir, 'data', 'downloads'), { recursive: true });
      this.port = await freePort();
      fs.writeFileSync(path.join(this.dir, 'config.json'), JSON.stringify({ password: PASSWORD, port: this.port }));
      if (this.initial) {
        const s = { nextId: 100, queue: [], current: null, startedAt: Date.now(), paused: false, pausedAt: 0, log: [], chat: [], colors: {}, faces: {}, ...this.initial };
        for (const q of [s.current, ...s.queue]) if (q && q.file && !this.files[q.file]) this.files[q.file] = Buffer.alloc(64 * 1024, q.id % 256);
        fs.writeFileSync(this.statePath, JSON.stringify(s));
      }
      for (const [name, data] of Object.entries(this.files)) fs.writeFileSync(path.join(this.dir, 'data', 'downloads', name), data);
    }
    this.out = '';
    this.proc = spawn(process.execPath, ['server.js'], { cwd: this.dir, env: { ...process.env, PORT: '', YTP_PASSWORD: '', COUCHWAVE_FAKE_TOOLS: path.join(__dirname, 'fakes') } });
    this.proc.stdout.on('data', d => (this.out += d));
    this.proc.stderr.on('data', d => (this.out += d));
    await waitFor(async () => (await this.req('GET', '/manifest.json', { cookie: '' }).catch(() => null)), 10000, 'the server to start');
    return this;
  }
  get statePath() { return path.join(this.dir, 'data', 'state.json'); }
  get url() { return `http://localhost:${this.port}`; }

  async stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    const exited = new Promise(r => this.proc.on('exit', r));
    this.proc.kill();
    await exited;
  }
  async restart() { await this.stop(); await this.start(); }
  async close() { for (const t of this.timers || []) clearInterval(t); await this.stop(); if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5 }); }

  // Joins as `name` (with the room password and that nickname's own password, which claims the nickname
  // the first time); returns the login cookie's value. Throws if refused.
  async login(name = 'Alice', { password = PASSWORD, own = ownPassword(name) } = {}) {
    const r = await this.req('POST', '/login', { body: { password, name, own }, cookie: '' });
    if (r.status !== 204) throw new Error(`login as ${name} failed: ${r.status} ${r.text}`);
    return /auth=([^;]*)/.exec(r.headers['set-cookie'].find(c => c.startsWith('auth=')))[1];
  }
  // The Cookie header for `name`, logging in the first time. forget() drops them all (e.g. after --logout-everyone).
  async cookie(name = 'Alice') {
    this.auths ||= {};
    this.auths[name] ||= this.login(name);
    try { return `auth=${await this.auths[name]}; name=${encodeURIComponent(name)}`; }
    catch (e) { delete this.auths[name]; throw e; }
  }
  forget(name) { if (name) delete (this.auths || {})[name]; else this.auths = {}; }

  // A request as `as` (a nickname: logged in as them). Returns { status, headers, body (Buffer), text, json }.
  // cookie: send exactly this Cookie header instead ('' = none).
  async req(method, url, { as = 'Alice', body, cookie, headers = {} } = {}) {
    if (cookie === undefined) cookie = await this.cookie(as);
    return new Promise((resolve, reject) => {
      const r = http.request({ port: this.port, path: url, method, headers: { Cookie: cookie, ...headers } }, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const b = Buffer.concat(chunks);
          let json; try { json = JSON.parse(b); } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString(), json });
        });
      });
      r.on('error', reject);
      if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
      r.end();
    });
  }
  get(url, opts) { return this.req('GET', url, opts); }
  post(url, body, opts = {}) { return this.req('POST', url, { ...opts, body }); }
  async state(as = 'Alice') { return (await this.get('/state', { as })).json; }

  // Keeps these people "online": checks in every second, like an open page (which does every 2s).
  // Stops by itself when the server is closed (so a failed test can't leave it running).
  keepOnline(...names) {
    const t = setInterval(() => { for (const n of names) this.state(n).catch(() => {}); }, 1000);
    t.unref(); // never keeps the test run going on its own
    (this.timers ||= []).push(t);
    return () => clearInterval(t);
  }
  // Activity log as "Name: text" lines.
  async log(as = 'Alice') { return (await this.state(as)).log.map(e => `${e.by}: ${e.text}`); }
  // Things the server printed that look like crashes or warnings.
  problems() { return this.out.split('\n').filter(l => /Error|Warning|at .*server\.js/.test(l) && !/yt-dlp|ERROR: \[youtube\]|HTTP Error/.test(l)); }
}

// A server for one test file: started before its tests, cleaned up after.
function useServer(t, opts) {
  const s = new Server(opts);
  t.before(() => s.start());
  t.after(() => s.close());
  return s;
}

module.exports = { Server, useServer, song, waitFor, sleep, PASSWORD, ownPassword, ROOT };
