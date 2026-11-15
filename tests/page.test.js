// The page itself and the public files (app icons, font, manifest).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path');
const { testServers, ROOT, PASSWORD } = require('./helpers');

const start = testServers({ after });
let s; // one server for the whole file
before(async () => { s = await start(); });

test('the page has no JavaScript syntax errors', () => {
  // A broken script stops the whole page working (no chat, no users, no buttons), so check every one parses.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  assert.ok(scripts.length > 0, 'found the page scripts');
  scripts.forEach((code, i) => assert.doesNotThrow(() => new Function(code), `script ${i + 1} parses`));
});

test('server.js and dj.js have no syntax errors', () => {
  for (const f of ['server.js', 'dj.js']) {
    assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*/, '')), f);
  }
});

test('the page is served, always re-checked by the browser', async () => {
  const r = await s.get('/', { cookie: '' }); // no login needed: it shows the join screen
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/html/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.match(r.text, /<title>/);
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
  for (const url of ['/icons/..%2Fserver.js', '/fonts/../config.json', '/icons/../data/state.json', '/fonts/..%5Cconfig.json']) {
    const r = await s.get(url, { cookie: '' });
    assert.notEqual(r.status, 200, url);
    assert.ok(!r.text.includes(PASSWORD) && !r.text.includes('require('), url + ' gives nothing away');
  }
});
