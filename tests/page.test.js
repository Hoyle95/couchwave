// ---------- The page and public files ----------
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, ROOT, PASSWORD } = require('./helpers');

const start = testServers({ after });
let s;
before(async () => { s = await start(); });

test('the page has no scripts of its own (so the security policy can block every inline script)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /<script>/, 'no inline <script>');
  assert.deepEqual(html.match(/ on[a-z]+=/g), null, 'no onclick="…" and the like');
  assert.match(html, /<script src="\/js\/theme\.js"><\/script>/, 'loads js/theme.js');
  assert.match(html, /<script src="\/js\/app\.js"><\/script>/, 'loads js/app.js');
  assert.match(html, /<link rel="stylesheet" href="\/css\/style\.css">/, 'loads css/style.css');
  const app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
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

test('app.js, theme.js, server.js and dj.js have no syntax errors', () => {
  for (const f of ['public/js/app.js', 'public/js/theme.js', 'server.js', 'dj.js']) {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*/, '')), f);
  }
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

test('every element and icon app.js uses is on the page', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8'), app = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/ id="([\w-]+)"/g)].map(m => m[1]));
  const used = new Set([...app.matchAll(/\$\('([\w-]+)'\)/g)].map(m => m[1]));
  assert.ok(used.size > 50, `found ${used.size} uses`);
  assert.deepEqual([...used].filter(id => !ids.has(id)), [], 'missing from index.html');
  const icons = [...app.matchAll(/icon\(([^)]*)\)/g)].flatMap(m => [...m[1].matchAll(/'([\w-]+)'/g)].map(x => x[1]));
  assert.deepEqual(icons.filter(i => !html.includes(`<symbol id="i-${i}"`)), [], 'icons missing from index.html');
});

test('the page, its style, script, manifest, icons and font are public; the page, style and script are always re-checked', async () => {
  for (const [url, type, file] of [['/', /^text\/html/, 'index.html'], ['/css/style.css', /^text\/css/], ['/js/app.js', /^text\/javascript/],
    ['/manifest.json', /^application\/manifest\+json/], ['/icons/icon-192.png', /^image\/png$/], ['/fonts/inter-latin.woff2', /^font\/woff2$/]]) {
    const r = await s.get(url, { cookie: '' });
    assert.equal(r.status, 200, url);
    assert.match(r.headers['content-type'], type, url);
    if (/^text\//.test(r.headers['content-type'])) {
      assert.equal(r.headers['cache-control'], 'no-cache', url);
      assert.equal(r.text, fs.readFileSync(path.join(ROOT, 'public', file || url.slice(1)), 'utf8'), url);
    }
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

test('page files: compressed when the browser can take it, and "unchanged" (304) when it already has them', async () => {
  const zlib = require('zlib');
  for (const url of ['/', '/css/style.css', '/js/app.js']) {
    const file = fs.readFileSync(path.join(ROOT, 'public', url === '/' ? 'index.html' : url.slice(1)));
    const plain = await s.get(url, { cookie: '' });
    assert.ok(plain.headers.etag, url + ' has a fingerprint');
    assert.equal(plain.headers['content-encoding'], undefined, url + ': plain when not asked for');
    const br = await s.get(url, { cookie: '', headers: { 'Accept-Encoding': 'gzip, deflate, br' } });
    assert.equal(br.headers['content-encoding'], 'br', url);
    assert.ok(br.body.length < file.length / 2, `${url}: ${br.body.length} bytes instead of ${file.length}`);
    assert.deepEqual(zlib.brotliDecompressSync(br.body), file, url + ' unpacks to the file');
    const gz = await s.get(url, { cookie: '', headers: { 'Accept-Encoding': 'gzip' } });
    assert.deepEqual(zlib.gunzipSync(gz.body), file, url + ' (gzip)');
    const again = await s.get(url, { cookie: '', headers: { 'If-None-Match': plain.headers.etag } });
    assert.equal(again.status, 304, url + ': unchanged');
    assert.equal(again.body.length, 0);
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
