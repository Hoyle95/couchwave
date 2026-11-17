// ---------- Chat, instant updates, profile pictures and reactions ----------
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { testServers, waitFor, sleep, secs } = require('./helpers');

const start = testServers({ after });

describe('chat', { concurrency: true }, () => {
test('messages: kept as typed (the page escapes them), trimmed, capped, empty ones ignored, saved', async () => {
  const s = await start();
  await s.post('/chat', { text: '  hey <b>all</b>  ' }, { as: 'Bob' });
  await s.post('/chat', { text: '    ' }, { as: 'Bob' });
  await s.post('/chat', { text: 'x'.repeat(600) }, { as: 'Bob' });
  const chat = (await s.state()).chat;
  assert.deepEqual(chat.map(m => [m.by, m.text.length > 20 ? m.text.length : m.text]), [['Bob', 'hey <b>all</b>'], ['Bob', 500]]);
  await s.restart();
  assert.equal((await s.state()).chat.length, 2, 'still there after a restart');
});

async function listen(s, as) {
  const got = [], cookie = await s.cookie(as);
  await new Promise((ok, fail) => {
    const req = http.get({ port: s.port, path: '/events', headers: { Cookie: cookie } }, res => {
      got.status = res.statusCode; got.type = res.headers['content-type'];
      res.on('data', d => { for (const m of String(d).matchAll(/^data: /gm)) got.push(Date.now()); });
      ok();
    });
    req.on('error', fail);
    got.close = () => req.destroy();
  });
  return got;
}

test('instant updates: everyone is nudged the moment someone sends a message or reacts, and nudges close together go out as one', async () => {
  const s = await start();
  const bob = await listen(s, 'Bob'), cara = await listen(s, 'Cara');
  assert.equal(bob.status, 200);
  assert.equal(bob.type, 'text/event-stream');
  await s.cookie('Alice');
  await sleep(100);
  const before = bob.length, sent = Date.now();
  await s.post('/chat', { text: 'hello' }, { as: 'Alice' });
  await waitFor(() => bob.length > before && cara.length > 0, 1000, 'both pages to be nudged');
  assert.ok(bob.at(-1) - sent < 1000, `within ${bob.at(-1) - sent}ms, not on the next 2-second check`);
  let n = bob.length;
  await s.post('/react', { e: '🔥', n: 1 }, { as: 'Alice' });
  await waitFor(() => bob.length > n, 1000, 'a nudge for the reaction');
  await sleep(100);
  n = bob.length;
  await Promise.all([1, 2, 3, 4, 5].map(i => s.post('/chat', { text: 'msg ' + i }, { as: 'Alice' })));
  await waitFor(() => bob.length > n, 3000, 'a nudge for the 5 messages');
  await sleep(200);
  assert.ok(bob.length - n >= 1 && bob.length - n < 5, `5 messages at once: ${bob.length - n} nudge(s), not one each`);
  bob.close(); cara.close();
});

test('up to 10 pages each get instant updates at once (any more just check in every few seconds)', async () => {
  const s = await start();
  const pages = [];
  for (let i = 0; i < 10; i++) pages.push(await listen(s, 'Bob'));
  assert.ok(pages.every(p => p.status === 200));
  const extra = await listen(s, 'Bob');
  assert.equal(extra.status, 429, 'an 11th is turned away');
  const cara = await listen(s, 'Cara');
  assert.equal(cara.status, 200, 'other people aren\'t affected');
  pages.shift().close();
  const again = await waitFor(async () => { const p = await listen(s, 'Bob'); if (p.status === 200) return p; p.close(); return null; }, 3000, 'room for one more once a page closes');
  for (const p of [...pages, extra, cara, again]) p.close();
});

test('the log, chat and history are only sent when they changed (most checks are tiny)', async () => {
  const s = await start();
  const first = (await s.get('/state')).json;
  assert.ok(first.log && first.chat && Array.isArray(first.history), 'the first check gets everything');
  const revs = `log=${first.logRev}&chat=${first.chatRev}&history=${first.historyRev}`;
  const again = (await s.get(`/state?${revs}`)).json;
  assert.deepEqual([again.log, again.chat, again.history], [undefined, undefined, undefined]);
  await s.post('/chat', { text: 'new' }, { as: 'Bob' });
  const later = (await s.get(`/state?${revs}`)).json;
  assert.equal(later.chat.at(-1).text, 'new', 'chat sent again once it changed');
  assert.deepEqual([later.log, later.history], [undefined, undefined], 'the log and history didn\'t change');
});

test('profile pictures: a colour and an emoji, checked, and quick changes are one log entry', async () => {
  const s = await start();
  await s.post('/color', { color: '#FF0000' }, { as: 'Bob' });
  await s.post('/color', { color: '#00ff00' }, { as: 'Bob' });
  await s.post('/color', { color: 'red; background:url(x)' }, { as: 'Bob' });
  await s.post('/face', { face: '🐸' }, { as: 'Bob' });
  await s.post('/face', { face: '<img>' }, { as: 'Bob' });
  await s.post('/face', { face: 'abc' }, { as: 'Bob' });
  await s.post('/color', { color: '#123456', quiet: true }, { as: 'Cara' });
  const st = await s.state();
  assert.equal(st.colors.Bob, '#00ff00');
  assert.equal(st.faces.Bob, '🐸');
  assert.equal(st.colors.Cara, '#123456');
  const log = (await s.log()).filter(l => /changed/.test(l));
  assert.deepEqual(log, ['Bob: changed their colour', 'Bob: changed their emoji to 🐸'], 'two colour changes, one entry; nothing for Cara');
});

test('reactions: shown for a few seconds, emoji only', async () => {
  const s = await start();
  await s.post('/react', { e: '🔥', n: 3, cid: 'page1' });
  await s.post('/react', { e: '<script>', n: 1 });
  await s.post('/react', { e: '🎉', n: 999 });
  const r = (await s.state()).reactions;
  assert.deepEqual(r.map(x => [x.e, x.n]), [['🔥', 3], ['🎉', 50]], 'not-emoji refused, bundle size capped');
  const shown = Date.now();
  await waitFor(async () => (await s.state()).reactions.length === 0, secs(6) + 1000, 'the reactions to go');
  assert.ok(Date.now() - shown >= secs(6) - 200, 'after 6 (server) seconds, not straight away');
  await s.cookie('Bob');
  const statuses = await Promise.all(Array.from({ length: 61 }, () => s.post('/react', { e: '🔥' }, { as: 'Bob' }).then(x => x.status)));
  assert.deepEqual([statuses.filter(x => x === 204).length, statuses.filter(x => x === 429).length], [60, 1], 'a speed limit: 60 every 10 seconds each');
});

test('chat has a speed limit: 8 messages in 10 seconds, then a 30-second cooldown, twice as long if it happens again soon', async () => {
  const s = await start();
  const spam = async () => { for (let i = 1; i <= 8; i++) assert.equal((await s.post('/chat', { text: 'msg ' + i }, { as: 'Bob' })).status, 204); };
  await spam();
  let r = await s.post('/chat', { text: 'one too many' }, { as: 'Bob' });
  assert.equal(r.status, 429);
  assert.equal(+r.headers['retry-after'], Math.ceil(secs(30) / 1000), 'a 30-second cooldown');
  assert.match(r.text, /^Slow down: you can chat again in \d+ seconds?$/);
  assert.equal((await s.post('/chat', { text: 'hi' }, { as: 'Cara' })).status, 204, 'others can still chat');
  await sleep(secs(10) + 200);
  assert.equal((await s.post('/chat', { text: 'still?' }, { as: 'Bob' })).status, 429, 'still cooling down 10 seconds later');
  await sleep(secs(20) + 200);
  await spam();
  r = await s.post('/chat', { text: 'again' }, { as: 'Bob' });
  assert.equal(+r.headers['retry-after'], Math.ceil(secs(60) / 1000), 'a clean slate after it, but twice as long the next time');
  assert.ok(!(await s.state()).chat.some(m => /one too many|still\?|again/.test(m.text)), 'none of the refused messages were posted');
});

test('a message arriving in pieces, split in the middle of an emoji, comes through whole', async () => {
  const s = await start();
  const body = Buffer.from(JSON.stringify({ text: 'split 🎉 here' })), cut = body.indexOf(Buffer.from('🎉')) + 2;
  const cookie = await s.cookie('Bob');
  await new Promise((resolve, reject) => {
    const r = http.request({ port: s.port, path: '/chat', method: 'POST', headers: { Cookie: cookie } }, res => { res.resume(); res.on('end', resolve); });
    r.on('error', reject);
    r.write(body.subarray(0, cut));
    setTimeout(() => r.end(body.subarray(cut)), 100);
  });
  assert.equal((await s.state()).chat.at(-1).text, 'split 🎉 here');
});
});
