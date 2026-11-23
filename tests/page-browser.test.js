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

  test('chat: a message shows for everyone exactly as typed (never as HTML), and the emoji picker adds to what you\'re typing', async () => {
    const s = await start();
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

  test('the queue: your own song is removed with a second click, and Undo in Activity brings it back', async () => {
    const s = await start({ initial: { current: song(1, 'Playing now', 'Zed', { duration: 100000 }), queue: [song(2, 'Mine', 'Alice')] } });
    const page = await open(s, 'Alice');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 1`, 5000, 'the queue');
    await page.click('#queue .del');
    assert.ok(await page.eval(`document.querySelector('#queue .del').classList.contains('armed')`), 'the first click only arms it');
    await new Promise(r => setTimeout(r, 400));
    await page.click('#queue .del');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 0`, 5000, 'it to go');
    await page.waitFor(`!!document.querySelector('#log .undo')`, 5000, 'the Undo button');
    await new Promise(r => setTimeout(r, 1600));
    await page.click('#log .undo');
    await page.waitFor(`document.querySelectorAll('#queue li[data-id]').length === 1`, 5000, 'it to come back');
    noErrors(page);
  });

  test('skipping and pausing are for everyone: the skip button counts votes, and pause shows on every page', async () => {
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

  test('GIFs: with a key, the GIF button opens KLIPY\'s trending GIFs (searched by the browser), and clicking one sends it to the chat', async () => {
    const asked = [];
    const klipy = http.createServer((req, res) => {
      asked.push(req.method + ' ' + req.url.split('?')[0]);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      const gif = n => ({ slug: `gif-${n}`, title: `Funny ${n}`, file: { sm: { webp: { url: `https://static.klipy.com/ii/test/${n}.webp`, width: 220, height: 160 } } } });
      res.end(JSON.stringify({ result: true, data: { data: [1, 2, 3, 4].map(gif), has_next: false } }));
    });
    await new Promise(r => klipy.listen(0, '127.0.0.1', r));
    try {
      const s = await start({ config: { klipyKey: 'test_Key-123456' }, env: { COUCHWAVE_KLIPY_URL: `http://127.0.0.1:${klipy.address().port}` } });
      const page = await open(s, 'Alice');
      await page.waitFor(`!document.getElementById('gifBtn').hidden`, 5000, 'the GIF button');
      await page.click('#gifBtn');
      assert.equal(await page.eval(`document.getElementById('gifSearch').placeholder`), 'Search KLIPY');
      await page.waitFor(`document.querySelectorAll('#gifGrid .gifItem').length === 4`, 5000, 'the trending GIFs');
      await page.click('#gifGrid .gifItem');
      await page.waitFor(`!!document.querySelector('#chat .msg:not(.pending) img.gif')`, 5000, 'the GIF in the chat');
      assert.equal(await page.visible('#gifPop'), false, 'the picker closes');
      assert.match((await s.state()).chat.at(-1).gif.url, /^https:\/\/static\.klipy\.com\/ii\/test\/\d\.webp$/);
      await waitFor(() => asked.includes('POST /api/v1/test_Key-123456/gifs/share/gif-1'), 3000, 'KLIPY to be told which GIF was shared');
      noErrors(page);
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

  test('the theme is remembered, and logging out goes back to the join screen', async () => {
    const s = await start();
    const page = await open(s, 'Alice');
    const was = await page.eval(`document.documentElement.dataset.theme || ''`);
    await page.click('#theme');
    const now = await page.eval(`document.documentElement.dataset.theme`);
    assert.notEqual(now, was);
    await page.goto(`http://127.0.0.1:${s.port}/`);
    assert.equal(await page.eval(`document.documentElement.dataset.theme`), now, 'still the same after reloading');
    await page.click('#logoutBtn');
    await page.waitFor(`!document.getElementById('join').hidden`, 5000, 'the join screen');
    assert.equal((await s.get('/state', { cookie: await page.eval('document.cookie') })).status, 401, 'logged out for real');
    noErrors(page);
  });
});
