// Chat, instant updates (/events), only sending the log/chat when they changed, profile pictures and reactions.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { testServers, waitFor, sleep, secs } = require('./helpers');

const start = testServers({ after });

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

// Opens /events as `as`: `got` collects when each nudge arrived. Resolves once connected.
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

test('instant updates: everyone is nudged the moment someone sends a message, or reacts', async () => {
  const s = await start();
  const bob = await listen(s, 'Bob'), cara = await listen(s, 'Cara');
  assert.equal(bob.status, 200);
  assert.equal(bob.type, 'text/event-stream');
  await s.cookie('Alice'); // logged in already, so the timing below is just the message
  await sleep(100);        // (any nudge from logging in has gone by)
  const before = bob.length, sent = Date.now();
  await s.post('/chat', { text: 'hello' }, { as: 'Alice' });
  await waitFor(() => bob.length > before && cara.length > 0, 1000, 'both pages to be nudged');
  assert.ok(bob.at(-1) - sent < 250, `within ${bob.at(-1) - sent}ms`);
  const n = bob.length;
  await s.post('/react', { e: '🔥', n: 1 }, { as: 'Alice' }); // not saved, so a different path
  await waitFor(() => bob.length > n, 1000, 'a nudge for the reaction');
  bob.close(); cara.close();
});

test('nudges close together go out as one', async () => {
  const s = await start();
  const bob = await listen(s, 'Bob');
  await s.cookie('Alice');
  await sleep(100);
  const before = bob.length;
  await Promise.all([1, 2, 3, 4, 5].map(i => s.post('/chat', { text: 'msg ' + i }, { as: 'Alice' })));
  await sleep(200);
  assert.ok(bob.length - before >= 1 && bob.length - before <= 2, `5 messages at once: ${bob.length - before} nudge(s)`);
  bob.close();
});

test('the log and chat are only sent when they changed (most checks are tiny)', async () => {
  const s = await start();
  const first = (await s.get('/state')).json;
  assert.ok(first.log && first.chat, 'the first check gets everything');
  const again = (await s.get(`/state?log=${first.logRev}&chat=${first.chatRev}`)).json;
  assert.equal(again.log, undefined);
  assert.equal(again.chat, undefined);
  await s.post('/chat', { text: 'new' }, { as: 'Bob' });
  const later = (await s.get(`/state?log=${first.logRev}&chat=${first.chatRev}`)).json;
  assert.equal(later.chat.at(-1).text, 'new', 'chat sent again once it changed');
  assert.equal(later.log, undefined, 'the log didn\'t change');
});

test('profile pictures: a colour and an emoji, checked, and quick changes are one log entry', async () => {
  const s = await start();
  await s.post('/color', { color: '#FF0000' }, { as: 'Bob' });
  await s.post('/color', { color: '#00ff00' }, { as: 'Bob' });
  await s.post('/color', { color: 'red; background:url(x)' }, { as: 'Bob' });
  await s.post('/face', { face: '🐸' }, { as: 'Bob' });
  await s.post('/face', { face: '<img>' }, { as: 'Bob' });
  await s.post('/face', { face: 'abc' }, { as: 'Bob' });
  await s.post('/color', { color: '#123456', quiet: true }, { as: 'Cara' }); // set while joining: not news
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
});
