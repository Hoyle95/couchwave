// ---------- The page and public files ----------
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, ROOT, PASSWORD } = require('./helpers');

const start = testServers({ after });
let s;
before(async () => { s = await start(); });
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('public/index.html');
const SCRIPTS = [...html.matchAll(/<script src="\/js\/([\w-]+\.js)"><\/script>/g)].map(m => m[1]);
const pageCode = () => SCRIPTS.filter(f => f !== 'theme.js').map(f => read(`public/js/${f}`)).join('\n');

test('this computer\'s home-network addresses, for the join screen: only for a visit from this computer itself, at a localhost address', async () => {
  const local = (await s.get('/room', { cookie: '' })).json;
  assert.ok(Array.isArray(local.home), 'visiting from this computer');
  for (const u of local.home) assert.match(u, new RegExp(`^http://(10|192\\.168|172\\.(1[6-9]|2\\d|3[01]))\\.[\\d.]+:${s.port}$`));
  for (const host of [`localhost:${s.port}`, `[::1]:${s.port}`, 'localhost']) {
    assert.ok(Array.isArray((await s.get('/room', { cookie: '', headers: { Host: host } })).json.home), host);
  }
  const viaTunnel = (await s.get('/room', { cookie: '', headers: { 'X-Forwarded-For': '203.0.113.5' } })).json;
  assert.deepEqual(viaTunnel, { public: false }, 'not for a visitor from elsewhere, even through a tunnel or proxy on this computer');
  const quietProxy = (await s.get('/room', { cookie: '', headers: { Host: 'couchwave.example.com' } })).json;
  assert.deepEqual(quietProxy, { public: false }, 'nor through a proxy on this computer that doesn\'t say who\'s visiting (the address it was asked for gives it away)');
});

test('the version, for the footer: only for people who are logged in', async () => {
  const version = /const VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'))[1];
  assert.equal((await s.state()).version, version);
  const room = await s.get('/room', { cookie: '' });
  assert.equal(room.status, 200);
  assert.equal(room.json.version, undefined, 'not before logging in');
  assert.equal((await s.get('/state', { cookie: '' })).status, 401);
});

test('the page has no scripts of its own (so the security policy can block every inline script), and loads every script file, app.js last', () => {
  assert.doesNotMatch(html, /<script>/, 'no inline <script>');
  assert.deepEqual(html.match(/ on[a-z]+=/g), null, 'no onclick="…" and the like');
  assert.match(html, /<link rel="stylesheet" href="\/css\/style\.css">/, 'loads css/style.css');
  assert.deepEqual([...SCRIPTS].sort(), fs.readdirSync(path.join(ROOT, 'public', 'js')).sort(), 'every file in public/js, and nothing else');
  assert.deepEqual([SCRIPTS[0], SCRIPTS.at(-1)], ['theme.js', 'app.js'], 'the theme first (before the page draws), app.js (which starts everything) last');
  const app = read('public/js/app.js');
  for (const [, action] of html.matchAll(/data-(?:click|submit|dblclick|enter)="(\w+)"/g)) {
    assert.match(app, new RegExp(`const ACTIONS = \\{[\\s\\S]*\\b${action}\\b[\\s\\S]*?\\};`), `${action} is wired up in app.js`);
  }
});

test('security headers on everything: a strict script policy, no framing, no sniffing, no referrer, and https-only once it\'s served over https', async () => {
  for (const [url, opts] of [['/', { cookie: '' }], ['/js/app.js', { cookie: '' }], ['/state', {}], ['/nope', { cookie: '' }]]) {
    const h = (await s.get(url, opts)).headers;
    assert.match(h['content-security-policy'], /(^|; )script-src 'self'(;|$)/, url);
    assert.match(h['content-security-policy'], /frame-ancestors 'none'/, url);
    assert.equal(h['x-content-type-options'], 'nosniff', url);
    assert.equal(h['x-frame-options'], 'DENY', url);
    assert.equal(h['referrer-policy'], 'no-referrer', url);
    assert.equal(h['strict-transport-security'], undefined, url + ': not on plain http (it would lock a home network out)');
    const https = (await s.get(url, { ...opts, headers: { 'X-Forwarded-Proto': 'https' } })).headers;
    assert.equal(https['strict-transport-security'], 'max-age=31536000', url + ': over https');
  }
});

test('the page\'s scripts, server.js and everything in lib/ have no syntax errors (and the page\'s scripts don\'t declare the same name twice)', () => {
  const lib = fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f);
  for (const f of [...SCRIPTS.map(x => `public/js/${x}`), 'server.js', ...lib]) assert.doesNotThrow(() => new Function(read(f)), f);
  assert.doesNotThrow(() => new Function(pageCode()), 'they share one scope in the browser, so together they must still make sense');
});

test('the one-line installers have no syntax errors (install.ps1 checked on Windows, install.sh elsewhere)', () => {
  const { spawnSync } = require('child_process');
  if (process.platform === 'win32') {
    const file = path.join(ROOT, 'install.ps1').replace(/'/g, "''");
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e) { $e | ForEach-Object { $_.ToString() }; exit 1 }`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } else {
    const r = spawnSync('bash', ['-n', path.join(ROOT, 'install.sh')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'install.sh'), 'latin1'), /\r/, 'install.sh has Unix line endings (bash can\'t run it otherwise)');
});

test('every element and icon the page\'s scripts use is on the page', () => {
  const app = pageCode();
  const ids = new Set([...html.matchAll(/ id="([\w-]+)"/g)].map(m => m[1]));
  const used = new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  assert.ok(used.size > 50, `found ${used.size} uses`);
  assert.deepEqual([...used].filter(id => !ids.has(id)), [], 'missing from index.html');
  const icons = [...app.matchAll(/icon\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'([\w-]+)'/g)].map(x => x[1]));
  assert.deepEqual(icons.filter(i => !html.includes(`<symbol id="i-${i}"`)), [], 'icons missing from index.html');
});

test('the page never uses the browser\'s own pop-ups (alert, confirm, prompt): problems show in its own notices and boxes, in its colours', () => {
  assert.deepEqual(pageCode().match(/\b(alert|confirm|prompt)\s*\(/g), null);
});

test('the page and its files are public; the page, style and scripts are always re-checked, compressed when the browser can take it, and "unchanged" (304) when it has them', async () => {
  const zlib = require('zlib');
  for (const [url, type, file] of [['/', /^text\/html/, 'index.html'], ['/css/style.css', /^text\/css/], ...SCRIPTS.map(f => [`/js/${f}`, /^text\/javascript/]),
    ['/manifest.json', /^application\/manifest\+json/], ['/icons/icon-192.png', /^image\/png$/], ['/fonts/inter-latin.woff2', /^font\/woff2$/]]) {
    const r = await s.get(url, { cookie: '' });
    assert.equal(r.status, 200, url);
    assert.match(r.headers['content-type'], type, url);
    if (!/^text\//.test(r.headers['content-type'])) continue;
    const plain = fs.readFileSync(path.join(ROOT, 'public', file || url.slice(1)));
    assert.equal(r.headers['cache-control'], 'no-cache', url);
    assert.deepEqual([r.body.equals(plain), r.headers['content-encoding']], [true, undefined], url + ': as it is, when compression wasn\'t asked for');
    const br = await s.get(url, { cookie: '', headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br', url);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), plain, url + ' unpacks to the file');
    if (plain.length > 20000) assert.ok(br.body.length < plain.length / 2, `${url}: ${br.body.length} bytes instead of ${plain.length}`);
    assert.deepEqual(zlib.gunzipSync((await s.get(url, { cookie: '', headers: { 'Accept-Encoding': 'gzip' } })).body), plain, url + ' (gzip)');
    const again = await s.get(url, { cookie: '', headers: { 'If-None-Match': r.headers.etag } });
    assert.deepEqual([again.status, again.body.length], [304, 0], url + ': unchanged');
  }
  assert.equal((await s.get('/manifest.json', { cookie: '' })).json.name, 'Couchwave');
});

test('other sites can\'t make a visitor\'s browser do things in Couchwave (even another site on the same computer)', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await s.req('POST', '/chat', { as: 'Mallory', body: { text: 'sent by another site' }, headers: { 'Sec-Fetch-Site': site } });
    assert.equal(r.status, 403, site);
  }
  assert.equal((await s.req('POST', '/logout', { cookie: '', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403, 'not even logging out');
  assert.equal((await s.req('POST', '/chat', { as: 'Mallory', body: { text: 'from the page' }, headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 204);
  assert.deepEqual((await s.state('Mallory')).chat.filter(m => m.by === 'Mallory').map(m => m.text), ['from the page']);
});

test('unknown files and routes are 404, and paths can\'t escape the folder', async () => {
  assert.equal((await s.get('/icons/nope.png', { cookie: '' })).status, 404);
  assert.equal((await s.get('/nope')).status, 404);
  for (const url of ['/icons/..%2Fserver.js', '/fonts/../config.json', '/icons/../data/state.json', '/fonts/..%5Cconfig.json', '/css/..%2F..%2Fserver.js', '/js/../../config.json', '/style.css', '/app.js']) {
    const r = await s.get(url, { cookie: '' });
    assert.notEqual(r.status, 200, url);
    assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('require('), url + ' gives nothing away');
  }
});

test('big status replies are compressed; small ones aren\'t worth it', async () => {
  const zlib = require('zlib');
  for (const who of ['Pat', 'Quinn', 'Rory']) {
    for (let i = 0; i < 6; i++) await s.post('/chat', { text: `${who} sends a fairly long message to make the reply nice and big, number ${i}` }, { as: who });
  }
  const r = await s.get('/state', { headers: { 'Accept-Encoding': 'gzip' } });
  assert.equal(r.headers['content-encoding'], 'gzip');
  assert.ok(JSON.parse(zlib.gunzipSync(r.body)).chat.length >= 18);
  assert.equal((await s.get('/room', { cookie: '', headers: { 'Accept-Encoding': 'gzip' } })).headers['content-encoding'], undefined);
});

test('a broken request (an address it can\'t read, or one cut off halfway) gets nowhere, and Couchwave carries on', async () => {
  const net = require('net');
  const raw = (text, cut) => new Promise(resolve => {
    const c = net.connect(s.port, '127.0.0.1', () => { c.write(text); if (cut) setTimeout(() => { c.destroy(); resolve('cut off'); }, 200); });
    let got = '';
    c.on('data', d => (got += d));
    c.on('close', () => resolve(got.split('\r\n')[0]));
    c.on('error', () => resolve('error'));
  });
  assert.equal(await raw('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), 'HTTP/1.1 400 Bad Request');
  const cookie = await s.cookie('Alice');
  await raw(`POST /chat HTTP/1.1\r\nHost: x\r\nCookie: ${cookie}\r\nContent-Length: 500\r\n\r\n{"text":"hel`, true);
  await raw('POST /login HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n{"pass', true);
  assert.equal((await s.get('/manifest.json', { cookie: '' })).status, 200, 'still running');
  assert.equal((await s.post('/chat', ['an', 'array'])).status, 204, 'a body that isn\'t an object is ignored, not a crash');
});
