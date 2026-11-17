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

test('security headers on everything: a strict script policy, no framing, no sniffing, no referrer', async () => {
  for (const [url, opts] of [['/', { cookie: '' }], ['/js/app.js', { cookie: '' }], ['/state', {}], ['/nope', { cookie: '' }]]) {
    const h = (await s.get(url, opts)).headers;
    assert.match(h['content-security-policy'], /(^|; )script-src 'self'(;|$)/, url);
    assert.match(h['content-security-policy'], /frame-ancestors 'none'/, url);
    assert.equal(h['x-content-type-options'], 'nosniff', url);
    assert.equal(h['x-frame-options'], 'DENY', url);
    assert.equal(h['referrer-policy'], 'no-referrer', url);
  }
});

test('app.js, theme.js, server.js and dj.js have no syntax errors', () => {
  for (const f of ['public/js/app.js', 'public/js/theme.js', 'server.js', 'dj.js']) {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*/, '')), f);
  }
});

test('the page is served, always re-checked by the browser', async () => {
  const r = await s.get('/', { cookie: '' });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(r.text, /<title>/);
});

test('its style and script are public, and always re-checked too', async () => {
  for (const [url, type] of [['/css/style.css', /^text\/css/], ['/js/app.js', /^text\/javascript/]]) {
    const r = await s.get(url, { cookie: '' });
    assert.equal(r.status, 200, url);
    assert.match(r.headers['content-type'], type, url);
    assert.equal(r.headers['cache-control'], 'no-cache', url);
    assert.equal(r.text, fs.readFileSync(path.join(ROOT, 'public', url.slice(1)), 'utf8'), url);
  }
});

test('app manifest, icons and font are public', async () => {
  const m = await s.get('/manifest.json', { cookie: '' });
  assert.equal(m.status, 200);
  assert.equal(m.json.name, 'Couchwave');
  const icon = await s.get('/icons/icon-192.png', { cookie: '' });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers['content-type'], 'image/png');
  const font = await s.get('/fonts/inter-latin.woff2', { cookie: '' });
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-type'], 'font/woff2');
});

test('unknown files and routes are 404, and paths can\'t escape the folder', async () => {
  assert.equal((await s.get('/icons/nope.png', { cookie: '' })).status, 404);
  assert.equal((await s.get('/nope')).status, 404);
  for (const url of ['/icons/..%2Fserver.js', '/fonts/../config.json', '/icons/../data/state.json', '/fonts/..%5Cconfig.json', '/css/..%2F..%2Fserver.js', '/js/../../config.json', '/style.css', '/app.js']) {
    const r = await s.get(url, { cookie: '' });
    assert.notEqual(r.status, 200, url);
    assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('require('), url + ' gives nothing away');
  }

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
});
