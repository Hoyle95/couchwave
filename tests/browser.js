// ---------- A headless Chrome or Edge for testing the page (no npm packages: it speaks DevTools over a WebSocket) ----------
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn, spawnSync } = require('child_process');
const { waitFor, sleep } = require('./helpers');

const env = process.env;
const CANDIDATES = {
  win32: [`${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`, `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'],
};
const BROWSER = env.COUCHWAVE_BROWSER || (CANDIDATES[process.platform] || []).find(f => { try { return fs.statSync(f).isFile(); } catch { return false; } });
const missing = !globalThis.WebSocket ? 'needs Node.js 22 or newer' : !BROWSER ? 'no Chrome or Edge found (set COUCHWAVE_BROWSER to use another)' : null;

class Browser {
  static async launch() {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'couchwave-browser-'));
    const proc = spawn(BROWSER, [
      '--headless=new', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required', '--window-size=1280,900', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1', ...(process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank',
    ], { stdio: 'ignore' });
    try {
      const portFile = path.join(profile, 'DevToolsActivePort');
      const [port, where] = await waitFor(() => { try { const l = fs.readFileSync(portFile, 'utf8').split('\n'); return l[1] && l; } catch { return false; } }, 15000, 'the browser to start');
      const ws = new WebSocket(`ws://127.0.0.1:${port.trim()}${where.trim()}`);
      await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error('can\'t reach the browser')); });
      return new Browser(proc, profile, ws);
    } catch (err) {
      await end(proc, profile);
      throw err;
    }
  }
  constructor(proc, profile, ws) {
    Object.assign(this, { proc, profile, ws, id: 0, waiting: new Map(), listeners: new Set() });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if (m.error) w.fail(new Error(`${w.method}: ${m.error.message}`)); else w.ok(m.result);
      } else for (const l of this.listeners) l(m);
    };
    ws.onclose = ws.onerror = () => {
      this.gone = true;
      for (const w of this.waiting.values()) w.fail(new Error(`${w.method}: the browser went away`));
      this.waiting.clear();
    };
  }
  send(method, params = {}, sessionId) {
    return new Promise((ok, fail) => {
      if (this.gone) return fail(new Error(`${method}: the browser went away`));
      const id = ++this.id;
      const timer = setTimeout(() => { this.waiting.delete(id); fail(new Error(`${method}: no answer from the browser within 30 seconds`)); }, 30000);
      this.waiting.set(id, { ok: v => { clearTimeout(timer); ok(v); }, fail: e => { clearTimeout(timer); fail(e); }, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async newPage() {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this, sessionId, browserContextId);
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable'].map(m => page.send(m)));
    return page;
  }
  async close() {
    const exited = new Promise(r => this.proc.once('exit', r));
    try { this.ws.send(JSON.stringify({ id: ++this.id, method: 'Browser.close' })); } catch {}
    await Promise.race([exited, sleep(5000)]);
    try { this.ws.close(); } catch {}
    await end(this.proc, this.profile);
  }
}
async function end(proc, profile) {
  if (proc.exitCode === null && proc.signalCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']); else proc.kill('SIGKILL');
  }
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

class Page {
  constructor(browser, sessionId, contextId) {
    Object.assign(this, { browser, sessionId, contextId, dialogs: [], errors: [] });
    browser.listeners.add(m => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.javascriptDialogOpening') {
        this.dialogs.push(m.params.message);
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
      if (m.method === 'Runtime.exceptionThrown') this.errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
  }
  send(method, params) { return this.browser.send(method, params, this.sessionId); }
  async goto(url) {
    await this.send('Page.navigate', { url });
    await waitFor(() => this.eval(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false), 10000, `${url} to load`);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  waitFor(expression, ms = 5000, what = expression) { return waitFor(() => this.eval(expression).catch(() => false), ms, what); }
  text(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`); }
  visible(selector) { return this.eval(`(el => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0)(document.querySelector(${JSON.stringify(selector)}))`); }
  click(selector) {
    const s = JSON.stringify(selector);
    return this.eval(`(el => { if (!el) throw new Error('nothing matches ' + ${s}); el.click(); return true; })(document.querySelector(${s}))`);
  }
  type(selector, value) {
    return this.eval(`(el => { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })(document.querySelector(${JSON.stringify(selector)}))`);
  }
  submit(selector) { return this.eval(`document.querySelector(${JSON.stringify(selector)}).requestSubmit(), true`); }
  async loginAs(server, name) {
    const auth = await server.login(name);
    await this.send('Network.setCookies', { cookies: [
      { name: 'auth', value: auth, domain: '127.0.0.1', path: '/' }, { name: 'name', value: encodeURIComponent(name), domain: '127.0.0.1', path: '/' },
    ] });
    await this.goto(`http://127.0.0.1:${server.port}/`);
    await this.waitFor(`document.getElementById('me').textContent === ${JSON.stringify(name)} && !document.querySelector('.me.loading')`, 5000, `${name} to be in`);
  }
  async answer(urlPattern, status) {
    const matches = new RegExp(`^${urlPattern.split('*').map(p => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    if (!this.answers) {
      this.answers = [];
      this.browser.listeners.add(m => {
        if (m.sessionId !== this.sessionId || m.method !== 'Fetch.requestPaused') return;
        const answer = this.answers.findLast(a => a.matches.test(m.params.request.url));
        const code = answer ? answer.status(m.params.request) : 0, requestId = m.params.requestId;
        (code ? this.send('Fetch.fulfillRequest', { requestId, responseCode: code, body: '' }) : this.send('Fetch.continueRequest', { requestId })).catch(() => {});
      });
    }
    this.answers.push({ urlPattern, matches, status });
    await this.send('Fetch.enable', { patterns: this.answers.map(a => ({ urlPattern: a.urlPattern })) });
  }
  close() { return this.browser.send('Target.disposeBrowserContext', { browserContextId: this.contextId }).catch(() => {}); }
}

module.exports = { Browser, missing };
