// ---------- The page, in a real (headless) browser ----------
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { testServers, song, yt, waitFor, PASSWORD } = require('./helpers');
const { Browser, missing } = require('./browser');

const start = testServers({ after });
let browser;
const pages = [];
async function open(s, name) {
  const page = await browser.newPage();
  pages.push(page);
  if (name) await page.loginAs(s, name);
  else await page.goto(`http://127.0.0.1:${s.port}/`);
  return page;
}
const noErrors = (...ps) => { for (const p of ps) assert.deepEqual(p.errors, [], 'no script errors on the page'); };

describe('the page in a browser', { skip: missing || false, concurrency: true }, () => {
  before(async () => { browser = await Browser.launch(); });
  after(async () => { for (const p of pages) await p.close(); if (browser) await browser.close(); });

  test('joining: a wrong room password says so; then in, with your name, your picture and the version; no GIF button without a key', async () => {
    const s = await start();
    const page = await open(s);
    await page.waitFor(`!document.getElementById('join').hidden`, 5000, 'the join screen');
    const home = (await s.get('/room', { cookie: '' })).json.home;
    assert.equal(await page.visible('#hostTip'), home.length > 0, 'on the computer running Couchwave, the addresses for friends at home (if it has one)');
    if (home.length) assert.match(await page.text('#hostTip'), new RegExp(`Friends at home can join at ${home[0].replace(/\./g, '\\.')}.*with the room password`));
    await page.type('#name', 'Alice');
    await page.type('#ownPw', 'alices-own-pw');
    await page.type('#pw', 'not the password');
    await page.submit('#joinForm');
    await page.waitFor(`document.getElementById('err').textContent === 'Wrong room password'`, 5000, 'the error');
    await page.type('#pw', PASSWORD);
    await page.submit('#joinForm');
    await page.waitFor(`document.getElementById('join').hidden && document.getElementById('me').textContent === 'Alice'`, 5000, 'to be in');
    assert.match(await page.text('#version'), /^v\d+\.\d+\.\d+/);
    assert.ok(await page.eval(`document.getElementById('meAvatar').textContent.length > 0`), 'a profile picture');
    assert.equal(await page.visible('#gifBtn'), false);
    assert.deepEqual((await s.state('Bob')).users.sort(), ['Alice', 'Bob'], 'online for everyone');
    await s.state('toString');
    await page.waitFor(`document.getElementById('userCount').textContent === '3'`, 5000, 'toString to be online');
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('#users li')].filter(li => /function|native code/.test(li.textContent) || /function/.test(li.querySelector('.avatar').style.background)).length`), 0,
      'a nickname that is also a word built into the browser (toString) still gets an emoji and a colour');
    noErrors(page);
  });

  test('chat: a message shows for everyone exactly as typed (never as HTML), and the emoji picker adds to what you\'re typing; Activity shares its place, a tab away (remembered), newest at the bottom like the chat, with a dot on Chat for new messages', async () => {
    const s = await start({ initial: { log: Array.from({ length: 40 }, (_, i) => ({ t: Date.now() - (40 - i) * 1000, by: 'Zed', text: `did thing ${i}` })) } });
    const alice = await open(s, 'Alice'), bob = await open(s, 'Bob');
    await alice.type('#chatText', '<b>hi</b> & bye');
    await alice.submit('#chatForm');
    await bob.waitFor(`[...document.querySelectorAll('#chat .msg .text')].some(t => t.textContent === '<b>hi</b> & bye')`, 5000, 'Bob to see it');
    assert.equal(await bob.eval(`document.querySelectorAll('#chat b:not(.nm)').length`), 0, 'not turned into HTML');
    assert.equal(await alice.eval(`document.getElementById('chatText').value`), '', 'the box is emptied');
    await alice.click('#emojiBtn');
    assert.equal(await alice.visible('#emojiPop'), true);
    const em = await alice.eval(`document.querySelector('#emojiPop button[data-e]').dataset.e`);
    await alice.click('#emojiPop button[data-e]');
    assert.equal(await alice.eval(`document.getElementById('chatText').value`), em);
    await alice.submit('#chatForm');
    await bob.waitFor(`[...document.querySelectorAll('#chat .text.big')].some(t => t.textContent === ${JSON.stringify(em)})`, 5000, 'a big emoji');
    const showing = p => p.eval(`['chat', 'chatForm', 'log'].filter(id => !document.getElementById(id).closest('[hidden]'))`);
    assert.deepEqual(await showing(bob), ['chat', 'chatForm'], 'the chat first');
    await bob.click('#logTab');
    assert.deepEqual(await showing(bob), ['log'], 'Activity in its place');
    const below = (later, earlier) => `(l => { const at = t => [...l.children].findIndex(li => li.textContent.includes(t));
      return at(${JSON.stringify(later)}) > at(${JSON.stringify(earlier)}) && at(${JSON.stringify(earlier)}) >= 0 && l.scrollHeight - l.scrollTop - l.clientHeight < 2; })(document.getElementById('log'))`;
    await bob.waitFor(below('did thing 39', 'did thing 0'), 5000, 'Activity oldest first, scrolled to the bottom');
    await s.post('/add', { url: yt('okay_000011') }, { as: 'Alice' });
    await bob.waitFor(below('Alice added', 'did thing 39'), 5000, 'a new line at the bottom, scrolled to');
    await alice.type('#chatText', 'while Bob looks at Activity');
    await alice.submit('#chatForm');
    await bob.waitFor(`document.getElementById('chatTab').classList.contains('unread')`, 5000, 'a dot on the Chat tab');
    await bob.goto(`http://127.0.0.1:${s.port}/`);
    await bob.waitFor(`!document.querySelector('.me.loading')`, 5000, 'Bob back in');
    assert.deepEqual(await showing(bob), ['log'], 'still on Activity after reloading');
    await bob.click('#chatTab');
    assert.deepEqual(await showing(bob), ['chat', 'chatForm']);
    assert.equal(await bob.eval(`document.getElementById('chatTab').classList.contains('unread')`), false, 'the dot goes');
    noErrors(alice, bob);
  });

  test('your colour and emoji: every change shows all over the page straight away; the server hears only the final choice, once, when the picker closes', async () => {
    const s = await start({ initial: { chat: [{ t: Date.now(), by: 'Alice', text: 'hi' }], log: [{ t: Date.now(), by: 'Alice', text: 'added a song' }] } });
    const alice = await open(s, 'Alice'), bob = await open(s, 'Bob');
    let sent = 0;
    await alice.answer('*/color', () => (sent++, 0));
    await alice.waitFor(`!!document.querySelector('#users .avatar[data-who="Alice"]')`, 5000, 'Alice online');
    const looks = () => alice.eval(`['#chat .nm', '#users .nm', '#log .nm'].map(sel => getComputedStyle(document.querySelector(sel + '[data-who="Alice"]')).color)
      .concat(document.querySelector('#users .avatar[data-who="Alice"]').textContent)`);
    await alice.click('.me .editAv');
    for (const [i, rgb] of [[0, 'rgb(239, 68, 68)'], [5, 'rgb(34, 197, 94)'], [8, 'rgb(59, 130, 246)']]) {
      await alice.eval(`document.querySelectorAll('#swatches button')[${i}].click()`);
      assert.deepEqual((await looks()).slice(0, 3), [rgb, rgb, rgb], `swatch ${i}: the chat, Online and Activity straight away`);
    }
    const em = await alice.eval(`(b => (b.click(), b.dataset.e))([...document.querySelectorAll('#facePick button[data-e]')].find(b => !b.classList.contains('on')))`);
    assert.equal((await looks())[3], em, 'the new emoji straight away');
    await new Promise(r => setTimeout(r, 500));
    assert.equal(sent, 0, 'nothing sent while choosing');
    assert.equal((await s.state()).colors.Alice, undefined);
    await alice.eval('document.body.click()');
    await waitFor(async () => { const st = await s.state(); return st.colors.Alice === '#3b82f6' && st.faces.Alice === em; }, 5000, 'the final choice, sent when the picker closed');
    assert.equal(sent, 1, 'once');
    await bob.waitFor(`(a => a && a.textContent === ${JSON.stringify(em)} && a.style.background.includes('59, 130, 246'))(document.querySelector('#users .avatar[data-who="Alice"]'))`, 5000, 'Bob to see it');
    assert.deepEqual((await looks()).slice(0, 3), Array(3).fill('rgb(59, 130, 246)'), 'and it stays after the update from the server');
    noErrors(alice, bob);
  });

  test('adding songs: a link goes in the queue and plays; a playlist link asks first; a link that isn\'t YouTube says why', async () => {
    const s = await start();
    const page = await open(s, 'Alice');
    await page.type('#url', yt('okay_000001'));
    await page.submit('#addForm');
    await page.waitFor(`document.getElementById('nowTitle').textContent === 'Song okay_000001'`, 8000, 'it to play');
    assert.match(await page.eval(`document.getElementById('a').getAttribute('src')`), /^\/audio\/\d+$/, 'the sound is loaded');
    assert.equal(await page.eval(`document.getElementById('url').value`), '', 'the box is emptied');
    await page.type('#url', yt('okay_000002') + '&list=PLtest');
    await page.submit('#addForm');
    await page.waitFor(`!document.getElementById('plModal').hidden`, 3000, 'the playlist question');
    await page.click('#plCancel');
    assert.equal(await page.visible('#plModal'), false);
    assert.equal((await s.state()).queue.length, 0, 'nothing added');
    await page.type('#url', 'https://example.com/video');
    await page.submit('#addForm');
    await waitFor(() => page.dialogs.includes('Not a YouTube link'), 3000, 'the page to say why');
    noErrors(page);
  });

  test('the queue: your own song is removed with a second click, and Undo in Activity brings it back; a song waiting on YouTube says when it tries again; a button whose request fails comes back', async () => {
    const s = await start({ initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }), queue: [song(2, 'Mine', 'Alice'), song(3, 'Held up', 'Bob', { status: 'failed', error: 'YouTube bot check', tries: 1, retryAt: Date.now() + 10 * 60000 }), song(4, 'Gone', 'Bob', { status: 'failed', error: 'Unavailable', tries: 3 })] } });
    const page = await open(s, 'Alice');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 3`, 5000, 'the queue');
    const [badge, why] = await page.eval(`(b => [b.textContent, b.title])(document.querySelector('#queue li[data-id="3"] .badge'))`);
    assert.match(badge, /^Retry at \d{1,2}:\d{2}/, 'when it tries again');
    assert.match(why, /^YouTube asked Couchwave to slow down, so it tries again at \d{1,2}:\d{2}/);
    await page.answer('*/retry', () => 500);
    assert.equal(await page.eval(`(b => { b.click(); return b.disabled; })(document.querySelector('#queue li[data-id="4"] .retry'))`), true, 'Retry waits for its answer');
    await page.waitFor(`(b => b && !b.disabled)(document.querySelector('#queue li[data-id="4"] .retry'))`, 5000, 'Retry to come back after its request failed');
    await page.click('#queue .del');
    assert.ok(await page.eval(`document.querySelector('#queue .del').classList.contains('armed')`), 'the first click only arms it');
    await new Promise(r => setTimeout(r, 400));
    await page.click('#queue .del');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 2`, 5000, 'it to go');
    await page.click('#logTab');
    await page.waitFor(`!!document.querySelector('#log .undo')`, 5000, 'the Undo button');
    await new Promise(r => setTimeout(r, 1600));
    await page.click('#log .undo');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 3`, 5000, 'it to come back');
    noErrors(page);
  });

  test('skipping and pausing are for everyone: the skip button counts votes, and pause shows on every page; clicking the video pauses or plays (double-clicking doesn\'t), and paused, it says who paused', async () => {
    const s = await start({ initial: { current: song(1, 'Song A', 'Zed', { duration: 100000 }), queue: [song(2, 'Song B', 'Zed', { duration: 100000 })] } });
    const alice = await open(s, 'Alice'), bob = await open(s, 'Bob');
    await alice.waitFor(`document.getElementById('userCount').textContent === '2'`, 5000, 'both to be online');
    await alice.click('#skipBtn');
    await bob.waitFor(`document.getElementById('skipText').textContent === '1 out of 2 voted to skip'`, 5000, 'Bob to see the vote');
    await bob.click('#skipBtn');
    for (const p of [alice, bob]) await p.waitFor(`document.getElementById('nowTitle').textContent === 'Song B'`, 5000, 'the next song');
    await alice.click('#pp');
    await bob.waitFor(`document.querySelector('#pp use').getAttribute('href') === '#i-play'`, 5000, 'Bob to see it paused');
    assert.equal((await s.state()).paused, true);
    await bob.waitFor(`!document.getElementById('pausedCard').hidden && document.getElementById('pausedBy').textContent.trim() === 'Paused by ' + document.querySelector('#pausedBy .avatar').textContent + ' Alice'`, 5000, 'the paused overlay, saying Alice paused');
    await bob.click('#v');
    await alice.waitFor(`document.getElementById('pausedCard').hidden`, 5000, 'Bob\'s click on the video to play it for everyone');
    assert.equal((await s.state()).paused, false);
    await alice.click('#v');
    await bob.waitFor(`/Paused by .* Alice/.test(document.getElementById('pausedBy').textContent)`, 5000, 'Alice\'s click on the video to pause it');
    await bob.eval(`(v => { for (const type of ['click', 'click', 'dblclick']) v.dispatchEvent(new MouseEvent(type, { bubbles: true })); })(document.getElementById('v'))`);
    await new Promise(r => setTimeout(r, 600));
    assert.equal((await s.state()).paused, true, 'a double-click (full screen) doesn\'t play or pause');
    noErrors(alice, bob);
  });

  test('history: played songs with how long they are; only the DJ\'s have a thumbs-up, which lights up when clicked', async () => {
    const now = Date.now();
    const s = await start({ initial: { history: [
      { url: yt('djlk_000001'), title: 'The DJ\'s pick', by: 'DJ', t: now, duration: 200 },
      { url: yt('bobs_000001'), title: 'Bob\'s song', by: 'Bob', t: now - 60000, duration: 4000 },
    ] } });
    const page = await open(s, 'Alice');
    await page.waitFor(`document.querySelectorAll('#history li').length === 2`, 5000, 'the history');
    assert.deepEqual(await page.eval(`[...document.querySelectorAll('#history .hlen')].map(e => e.textContent)`), ['3:20', '1:06:40']);
    assert.equal(await page.eval(`document.querySelectorAll('#history .like').length`), 1, 'one thumbs-up: the DJ\'s song');
    await page.click('#history .like');
    await page.waitFor(`document.querySelector('#history .like').classList.contains('on')`, 5000, 'it to light up');
    noErrors(page);
  });

  test('GIFs: with a key, the GIF button opens KLIPY\'s trending GIFs (searched by the browser), and clicking one sends it to the chat; the chat opens at the newest message, after its GIFs load; closed, the picker stops loading, and a failed load is tried again', async () => {
    const asked = [];
    let fail = false, more = false;
    const klipy = http.createServer((req, res) => {
      asked.push(req.method + ' ' + req.url.split('?')[0]);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (fail && req.method === 'GET') { res.writeHead(500); return res.end('{}'); }
      const gif = n => ({ slug: `gif-${n}`, title: `Funny ${n}`, file: { sm: { webp: { url: `https://static.klipy.com/ii/test/${n}.webp`, width: 220, height: 160 } } } });
      res.end(JSON.stringify({ result: true, data: { data: [1, 2, 3, 4].map(gif), has_next: more } }));
    });
    await new Promise(r => klipy.listen(0, '127.0.0.1', r));
    try {
      const gif = { url: '/icons/icon-512.png', width: 512, height: 512, title: 'A GIF' };
      const chat = Array.from({ length: 30 }, (_, i) => (i % 6 === 5 ? { t: Date.now(), by: 'Bob', text: '', gif } : { t: Date.now(), by: 'Bob', text: `message ${i}` }));
      const s = await start({ config: { klipyKey: 'test_Key-123456' }, env: { COUCHWAVE_KLIPY_URL: `http://127.0.0.1:${klipy.address().port}` }, initial: { chat } });
      const page = await open(s, 'Alice');
      await page.waitFor(`(i => i && i.complete && i.naturalWidth > 0)([...document.querySelectorAll('#chat img.gif')].pop())`, 5000, 'the newest GIF to load');
      await page.waitFor(`(c => c.scrollHeight - c.scrollTop - c.clientHeight < 2)(document.getElementById('chat'))`, 2000, 'the chat at its newest message');
      await page.waitFor(`!document.getElementById('gifBtn').hidden`, 5000, 'the GIF button');
      await page.click('#gifBtn');
      assert.equal(await page.eval(`document.getElementById('gifSearch').placeholder`), 'Search KLIPY');
      await page.waitFor(`document.querySelectorAll('#gifGrid .gifItem').length === 4`, 5000, 'the trending GIFs');
      await page.click('#gifGrid .gifItem');
      await page.waitFor(`[...document.querySelectorAll('#chat .msg:not(.pending) img.gif')].some(i => i.src.includes('klipy.com'))`, 5000, 'the GIF in the chat');
      assert.equal(await page.visible('#gifPop'), false, 'the picker closes');
      assert.match((await s.state()).chat.at(-1).gif.url, /^https:\/\/static\.klipy\.com\/ii\/test\/\d\.webp$/);
      await waitFor(() => asked.includes('POST /api/v1/test_Key-123456/gifs/share/gif-1'), 3000, 'KLIPY to be told which GIF was shared');
      const trending = () => asked.filter(a => a.startsWith('GET ') && a.endsWith('/trending')).length;
      fail = true;
      const bob = await open(s, 'Bob');
      await bob.waitFor(`!document.getElementById('gifBtn').hidden`, 5000, "Bob's GIF button");
      await bob.click('#gifBtn');
      await bob.waitFor(`/Couldn't reach KLIPY/.test(document.getElementById('gifGrid').textContent)`, 5000, 'the load to fail');
      await bob.click('#gifBtn');
      fail = false;
      await bob.click('#gifBtn');
      await bob.waitFor(`document.querySelectorAll('#gifGrid .gifItem').length === 4`, 5000, 'opened again, it tries again');
      more = true;
      const cara = await open(s, 'Cara');
      await cara.waitFor(`!document.getElementById('gifBtn').hidden`, 5000, "Cara's GIF button");
      const before = trending();
      await cara.eval(`document.getElementById('gifBtn').click(); document.getElementById('gifBtn').click()`);
      await new Promise(r => setTimeout(r, 1500));
      assert.ok(trending() - before <= 2, `closed straight away, it stops loading pages (${trending() - before} loaded)`);
      noErrors(page, bob, cara);
    } finally { klipy.close(); }
  });

  test('wide windows: the video and chat only ever grow as the window gets wider, and the controls stay on screen when it\'s short', async () => {
    const s = await start();
    const page = await open(s, 'Alice');
    const at = async (width, height) => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      return page.eval(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => {
        const box = s => document.querySelector(s).getBoundingClientRect();
        r({ video: box('#player').width, chat: box('aside').width, controls: box('.controls').bottom + scrollY, height: innerHeight });
      })))`);
    };
    let last = null;
    for (const width of [1280, 1366, 1440, 1460, 1500, 1600, 1920, 2560]) {
      const now = await at(width, 1440);
      if (last) {
        assert.ok(now.video >= last.video - 0.5, `the video doesn't shrink going from ${last.width} to ${width} wide (${last.video} → ${now.video})`);
        assert.ok(now.chat >= last.chat - 0.5, `the chat doesn't shrink going from ${last.width} to ${width} wide (${last.chat} → ${now.chat})`);
      }
      last = { ...now, width };
    }
    const narrow = await at(1440, 900), wide = await at(1920, 1080);
    assert.ok(wide.video > narrow.video + 200 && wide.chat > narrow.chat + 50, 'a 1920 wide screen gets a bigger video and chat');
    for (const [width, height] of [[2560, 900], [1920, 800], [3440, 1100]]) {
      const short = await at(width, height);
      assert.ok(short.controls <= short.height, `on a ${width}x${height} window the controls under the video are on screen (${short.controls} of ${short.height})`);
    }
    await page.send('Emulation.clearDeviceMetricsOverride');
    noErrors(page);
  });

  test('live updates: after a proxy in front of Couchwave answers with an error page (while it restarts), the page connects again', async () => {
    const s = await start();
    const page = await open(s, 'Alice');
    await page.waitFor(`events && events.readyState === 1`, 5000, 'live updates');
    let blocked = 0;
    await page.answer('*/events*', () => (blocked >= 0 ? (blocked++, 502) : 0));
    await s.restart();
    await waitFor(() => blocked > 0, 15000, 'the page to try again, and get the error page');
    blocked = -1;
    await page.waitFor(`events && events.readyState === 1`, 15000, 'live updates again');
    let asked = 0;
    await page.answer('*/state*', () => (asked++, 0));
    await page.eval('Promise.all(Array.from({ length: 10 }, () => poll()))');
    assert.ok(asked <= 2, `10 updates at once ask the server ${asked} times (one, then one more for anything since)`);
    noErrors(page);
  });

  test('the player: a song this browser can\'t load is tried again 3 times, not on every update; out of full screen, nothing checks whether to hide the controls', async () => {
    const s = await start({ initial: { current: song(1, 'Broken audio', 'Zed', { duration: 100000 }) } });
    const page = await open(s, 'Alice');
    let loads = 0;
    await page.answer('*/audio/*', () => (loads++, 500));
    await page.eval(`a.src = '/audio/1'`);
    for (let i = 0; i < 8; i++) { await page.eval('poll()'); await new Promise(r => setTimeout(r, 250)); }
    assert.ok(loads <= 5, `${loads} tries`);
    await page.eval(`(() => { let n = 0; const later = window.setTimeout; window.setTimeout = (f, ms, ...rest) => { if (ms === 3000) n++; return later(f, ms, ...rest); }; window.uiChecks = () => n; showUi(); })()`);
    await new Promise(r => setTimeout(r, 3500));
    assert.equal(await page.eval('uiChecks()'), 1, 'one check, which then stops');
    noErrors(page);
  });

  test('the theme button sits on its own, right of your name and Log out; the theme is remembered, and logging out goes back to the join screen', async () => {
    const s = await start();
    const page = await open(s, 'Alice');
    assert.deepEqual(await page.eval(`(() => { const me = document.querySelector('.me').getBoundingClientRect(), t = document.getElementById('theme').getBoundingClientRect();
      return [!!document.querySelector('.me #theme'), Math.round(t.left - me.right), t.height === me.height && t.top === me.top]; })()`), [false, 10, true], 'outside the pill, just right of it, the same height');
    const was = await page.eval(`document.documentElement.dataset.theme || ''`);
    await page.click('#theme');
    const now = await page.eval(`document.documentElement.dataset.theme`);
    assert.notEqual(now, was);
    await page.goto(`http://127.0.0.1:${s.port}/`);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), now, 'still the same after reloading');
    const LIGHT = 'rgb(243, 243, 247)', DARK = 'rgb(12, 12, 17)';
    const shows = async (system, chosen) => {
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: system }] });
      return page.eval(`(() => { const r = document.documentElement; ${chosen ? `r.dataset.theme = '${chosen}'` : 'delete r.dataset.theme'};
        const d = document.body.appendChild(document.createElement('div')); d.style.background = 'var(--bg)'; const c = getComputedStyle(d).backgroundColor; d.remove(); return c; })()`);
    };
    assert.deepEqual([await shows('light', ''), await shows('dark', ''), await shows('light', 'dark'), await shows('dark', 'light')], [LIGHT, DARK, DARK, LIGHT],
      'the system\'s light or dark, unless the theme button picked one');
    await page.send('Emulation.setEmulatedMedia', { features: [] });
    await page.eval(`document.documentElement.dataset.theme = ${JSON.stringify(now)}`);
    const url = `http://127.0.0.1:${s.port}/`, auth = (await page.send('Network.getCookies', { urls: [url] })).cookies.find(c => c.name === 'auth').value;
    await page.click('#logoutBtn');
    await page.waitFor(`!document.getElementById('join').hidden`, 5000, 'the join screen');
    assert.equal((await s.get('/state', { cookie: `auth=${auth}` })).status, 401, 'logged out for real: the login it had no longer works');
    noErrors(page);
  });
});
