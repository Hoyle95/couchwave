// ---------- What pages see ----------
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const common = require('./common');
const { secs, fmt, videoId, watchUrl } = common;
const { fatal } = require('./log');
const { PORT, PASSWORD, PUBLIC, GIFS } = require('./settings');
const { visitor, viaHttps, plainFromInternet } = require('./addresses');
const accounts = require('./accounts');
const { same, AUTH_COOKIE, NAME_COOKIE, cookie, parseCookies, newLogin, loggedIn, renewed, endLogin } = require('./logins');
const limits = require('./limits');
const { sendFile, sendStatic, MANIFEST, SECURITY_HEADERS, sendJson, readJson } = require('./web');
const room = require('./room');
const presence = require('./presence');
const songs = require('./songs');
const downloads = require('./downloads');
const playback = require('./playback');

const STREAMS_EACH = 10;
const pub = i => i && { id: i.id, url: i.url, title: i.title, by: i.by, duration: i.duration, gain: i.gain ?? 1 };
function pageState(q, who) {
  const now = Date.now();
  for (const n in room.seen) if (now - room.seen[n] > 3600000) delete room.seen[n];
  const users = presence.online().sort((a, b) => a.localeCompare(b));
  const { current, removeVotes, logRev, chatRev, historyRev } = room;
  const s = {
    current: pub(current),
    elapsed: current ? playback.elapsed() : 0,
    paused: room.paused,
    next: pub(playback.nextUp()),
    queue: room.queue.map(({ id, url, title, by, status, error, retryAt }) => ({ id, url, title, by, status, error, retrying: !!retryAt,
      held: downloads.isDiskFull() && status === 'waiting', removeVoters: removeVotes.has(id) ? users.filter(n => removeVotes.get(id).has(n)) : [] })),
    colors: room.colors, faces: room.faces,
    reactions: room.reactions.filter(r => now - r.t < secs(6)),
    users,
    skip: { voters: users.filter(n => room.skipVotes.has(n)), need: songs.votesNeeded(users.length) },
    dj: !!(room.dj && room.dj.isOn()),
    logRev, chatRev, historyRev,
  };
  if (q.get('log') !== String(logRev)) s.log = room.log.map(({ t, by, text, undo }) => ({ t, by, text, undo: room.trash.has(undo) ? undo : undefined }));
  if (q.get('chat') !== String(chatRev)) s.chat = room.chat;
  if (q.get('history') !== String(historyRev)) s.history = room.history.map(({ likedBy, ...h }) => (likedBy && likedBy.includes(who) ? { ...h, liked: true } : h));
  return s;
}

function done(res) { room.save(); res.writeHead(204); res.end(); }

// ---------- GIFs ----------
const gifSetup = who => GIFS && {
  key: GIFS.key, api: GIFS.api, filter: GIFS.filter,
  customer: crypto.createHmac('sha256', accounts.loginKey()).update(`klipy\n${accounts.nameKey(who)}`).digest('hex').slice(0, 32),
};
function chatGif(g) {
  if (!GIFS || !g || typeof g !== 'object') return null;
  const url = String(g.url || ''), w = Number(g.width), h = Number(g.height);
  if (url.length > 600 || !/^https:\/\/static\d*\.klipy\.com\/[^\s"'<>\\]+$/.test(url)) return null;
  if (![w, h].every(n => Number.isInteger(n) && n >= 1 && n <= 4000)) return null;
  return { url, width: w, height: h, title: String(g.title || '').trim().slice(0, 120) };
}

// ---------- Logging in ----------
function login(req, res) {
  const { fails, nameFails, newNames, FAIL_MAX, NEW_NAMES_MAX, strikes, tellOnce } = limits;
  const ip = visitor(req);
  if (strikes(fails, ip).n >= FAIL_MAX) { res.writeHead(429); return res.end('Too many wrong passwords, try again later'); }
  return readJson(req, 2000, async ({ password, name, own }) => {
    const say = (status, msg) => {
      res.writeHead(status); res.end(msg);
      if (counted && g.n >= FAIL_MAX) tellOnce(g, `logins: ${ip} got a password wrong ${FAIL_MAX} times in 15 minutes, so it waits 15 minutes before trying again`);
      if (nameStrike && nameStrike.n >= FAIL_MAX) tellOnce(nameStrike, `logins: ${FAIL_MAX} wrong passwords for "${nameStrike.name}" in 15 minutes, so new logins with it wait 15 minutes (devices already logged in carry on)`);
    };
    const g = strikes(fails, ip);
    g.n++;
    let counted = true, nameStrike = null, newStrike = null;
    const newRight = () => { if (newStrike) { newStrike.n = Math.max(0, newStrike.n - 1); newStrike = null; } };
    const right = () => { if (counted) { counted = false; g.n = Math.max(0, g.n - 1); } };
    const nameRight = () => { if (nameStrike) { nameStrike.n = Math.max(0, nameStrike.n - 1); nameStrike = null; } };
    try {
      if (!PUBLIC && !same(password, PASSWORD)) return say(401, 'Wrong room password');
      name = accounts.cleanName(name);
      if (!name || accounts.RESERVED.has(accounts.nameKey(name))) { right(); return say(400, 'Pick a different nickname'); }
      if (accounts.mixedAlphabets(name)) { right(); return say(400, 'Use letters from one alphabet in your nickname'); }
      own = String(own || '');
      let acc = accounts.account(name);
      if (accounts.accountsBroken()) { right(); return say(503, 'Logins are paused: the server can\'t read its accounts file. Try again in a moment'); }
      if (acc) {
        const f = strikes(nameFails, accounts.nameKey(acc.name));
        if (f.n >= FAIL_MAX) { right(); return say(429, `Too many wrong passwords for "${acc.name}". Try again in a few minutes`); }
        f.n++; f.name = acc.name; nameStrike = f;
        if (!same(await accounts.scramble(own, acc.salt), acc.hash)) return say(401, `"${acc.name}" is taken. If it's yours, that's not its password`);
        nameRight();
      } else {
        right();
        if (own.length < accounts.MIN_OWN_PASSWORD) return say(400, `Choose a password for your nickname (at least ${accounts.MIN_OWN_PASSWORD} characters)`);
        const from = ip === '127.0.0.1' || ip === '::1' ? null : strikes(newNames, ip);
        if (from && from.n >= NEW_NAMES_MAX) {
          tellOnce(from, `logins: ${NEW_NAMES_MAX} new nicknames from ${ip} in the last hour, so it waits before making more`);
          return say(429, 'Lots of new nicknames have been made from here in the last hour. Try again later, or ask whoever runs Couchwave');
        }
        if (from) { from.n++; newStrike = from; }
        if (accounts.wasDeleted(name)) {
          for (const list of [room.colors, room.faces]) for (const n of Object.keys(list)) if (accounts.nameKey(n) === accounts.nameKey(name)) delete list[n];
          room.dirty = true;
        }
        const salt = crypto.randomBytes(16).toString('hex');
        acc = { name, salt, hash: await accounts.scramble(own, salt), created: Date.now() };
        let added;
        try { added = accounts.addAccount(acc); }
        catch (err) { newRight(); console.error('saving accounts failed:', err.message); return say(503, 'Couldn\'t save your nickname. Try again in a moment'); }
        if (!added) { newRight(); return say(401, `"${name}" was just taken by someone else`); }
      }
      right();
      res.writeHead(204, { 'Set-Cookie': [
        cookie(req, AUTH_COOKIE, newLogin(acc)),
        cookie(req, NAME_COOKIE, encodeURIComponent(acc.name)),
      ] });
      res.end();
    } catch (err) {
      right(); nameRight(); newRight();
      if (err.busy) { if (!res.headersSent) say(503, 'Lots of people are logging in right now. Try again in a moment'); return; }
      console.error('login failed:', err.message);
      if (!res.headersSent) say(500, 'Something went wrong. Try again');
    }
  });
}

function logout(req, res) {
  const signedIn = loggedIn(parseCookies(req.headers.cookie).auth);
  if (signedIn) {
    const who = signedIn.acc.name;
    endLogin(signedIn);
    for (const r of room.listeners) if (!loggedIn(r.auth)) { room.listeners.delete(r); r.end(); }
    if (![...room.listeners].some(r => r.who === who)) { delete room.seen[who]; presence.departed(who); }
  }
  res.writeHead(204, { 'Set-Cookie': cookie(req, AUTH_COOKIE, '', 0) });
  return res.end();
}

// ---------- Routes ----------
function route(req, res, url) {
  const key = req.method + ' ' + url.pathname;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (viaHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  plainFromInternet(req);
  if (req.method === 'POST' && /^(cross-site|same-site)$/.test(String(req.headers['sec-fetch-site'] || ''))) {
    res.writeHead(403); return res.end('Only Couchwave\'s own page can do that');
  }

  if (key === 'GET /') {
    const signedIn = loggedIn(parseCookies(req.headers.cookie).auth), fresh = signedIn && renewed(signedIn);
    const headers = signedIn && (fresh || viaHttps(req)) ? { 'Set-Cookie': cookie(req, AUTH_COOKIE, fresh || signedIn.token) } : {};
    return sendStatic(req, res, 'index.html', headers);
  }
  if (key === 'GET /room') return sendJson(req, res, { public: PUBLIC });
  if (key === 'GET /manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
    return res.end(MANIFEST);
  }
  const asset = /^\/((?:css\/[\w-]+\.css)|(?:js\/[\w-]+\.js)|(?:icons\/[\w-]+\.png)|(?:fonts\/[\w-]+\.woff2))$/.exec(url.pathname);
  if (req.method === 'GET' && asset) return sendStatic(req, res, asset[1]);
  if (key === 'POST /login') return login(req, res);
  if (key === 'POST /logout') return logout(req, res);

  const signedIn = loggedIn(parseCookies(req.headers.cookie).auth);
  if (!signedIn) { res.writeHead(401); return res.end('Not logged in'); }
  const fresh = renewed(signedIn);
  if (fresh) res.setHeader('Set-Cookie', cookie(req, AUTH_COOKIE, fresh));
  const who = signedIn.acc.name;
  const limited = limits.LIMITED[key];
  if (limited && limits.tooFast(limited, who)) { res.writeHead(429); return res.end('Slow down a little'); }

  switch (key) {
    case 'GET /state':
      presence.checkIn(who);
      return sendJson(req, res, { ...pageState(url.searchParams, who), me: who, version: common.VERSION, gifs: gifSetup(who) || undefined });

    case 'GET /events':
      if ([...room.listeners].filter(r => r.who === who).length >= STREAMS_EACH) { res.writeHead(429); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      res.who = who; res.auth = fresh || parseCookies(req.headers.cookie).auth;
      room.seen[who] = Date.now();
      room.listeners.add(res);
      req.on('close', () => { if (room.listeners.delete(res)) room.seen[who] = Date.now(); });
      return;

    case 'POST /bye':
      if (room.here.has(who)) room.closed[who] = Date.now();
      res.writeHead(204); return res.end();

    case 'POST /add':
      return readJson(req, 2000, ({ url: link, playlist }) => {
        link = String(link || '').trim();
        const say = (status, msg) => { res.writeHead(status); res.end(msg); };
        if (!link) return say(400, 'Paste a YouTube link or type a song name');
        const isLink = /^https?:\/\//i.test(link), wholePlaylist = playlist === true && /[?&]list=/.test(link);
        if (isLink && !/^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(link)) return say(400, 'Not a YouTube link');
        const id = isLink && !wholePlaylist && videoId(link), twin = songs.alreadyHere(id);
        if (isLink && !wholePlaylist && !id && /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)[\w-]/.test(link)) return say(400, 'That link looks cut off. Copy the whole link from YouTube again');
        if (twin) return say(409, `${songs.songName(twin)} ${songs.alreadyText(twin)}`);
        if (limits.tooFast('add', who)) return say(429, 'Slow down a little: you\'ve added a lot of songs. Try again in a minute');
        if (!isLink) { songs.addSearch(link.slice(0, 150), who); return done(res); }
        if (wholePlaylist) { songs.addPlaylist(link, who); return done(res); }
        const item = songs.addSong(id ? watchUrl(id) : link, link, who);
        room.addLog(who, `added ${link}`, item.id);
        downloads.pump();
        done(res);
      });

    case 'POST /skip':
      return readJson(req, 200, ({ id, vote }) => {
        presence.checkIn(who);
        const current = room.current;
        if (current && id === current.id) {
          if (vote !== false && current.by === who) {
            room.addLog(who, `skipped their song "${current.title}"`);
            playback.advance();
          } else {
            if (vote === false) room.skipVotes.delete(who); else room.skipVotes.add(who);
            playback.checkSkip();
          }
        }
        done(res);
      });

    case 'POST /pause':
      if (room.current && !room.paused) { room.pausedAt = playback.elapsed(); room.paused = true; room.addLog(who, `paused at ${fmt(room.pausedAt)}`); }
      return done(res);

    case 'POST /play':
      if (room.paused) { room.startedAt = Date.now() - room.pausedAt * 1000; room.paused = false; room.addLog(who, 'resumed'); }
      return done(res);

    case 'POST /seek':
      return readJson(req, 200, ({ t }) => {
        presence.checkIn(who);
        const current = room.current;
        const people = presence.online(), alone = people.length === 1 && people[0] === who;
        const ownerAway = current && !songs.isDjSong(current) && !people.includes(current.by);
        if (current && current.by !== who && !ownerAway && !alone) {
          res.writeHead(403);
          return res.end(songs.isDjSong(current) ? 'The DJ\'s songs can only be moved when you\'re the only one here'
            : `Only ${current.by} can move their song while they're here`);
        }
        if (current) {
          t = Math.max(0, Math.min(Number(t) || 0, current.duration));
          if (room.paused) room.pausedAt = t; else room.startedAt = Date.now() - t * 1000;
          room.addLog(who, `jumped to ${fmt(t)}`);
        }
        done(res);
      });

    case 'POST /remove':
      return readJson(req, 200, ({ id, vote }) => {
        const item = room.queue.find(q => q.id === id);
        if (item) {
          presence.checkIn(who);
          if (item.by === who) songs.removeFromQueue(item, who, `removed "${item.title}"`, true);
          else {
            const votes = room.removeVotes.get(item.id) || new Set();
            if (vote === false) votes.delete(who); else votes.add(who);
            if (votes.size) room.removeVotes.set(item.id, votes); else room.removeVotes.delete(item.id);
            songs.checkRemoves();
          }
        }
        done(res);
      });

    case 'POST /undo':
      return readJson(req, 200, ({ id }) => {
        const entry = room.trash.get(id);
        if (entry && entry.by !== who) { res.writeHead(403); return res.end('Only whoever deleted a song can bring it back'); }
        const twin = entry && songs.alreadyHere(videoId(entry.item.url));
        if (twin) { res.writeHead(409); return res.end(`${songs.songName(twin)} ${songs.alreadyText(twin)}`); }
        if (entry) {
          const { item, index } = entry;
          room.trash.delete(id);
          item.removed = false;
          if (item.status !== 'failed' && item.status !== 'searching' && !(item.status === 'ready' && item.file && fs.existsSync(item.file))) {
            Object.assign(item, { status: 'waiting', out: null, file: null, audio: null });
          }
          room.queue.splice(Math.min(index, room.queue.length), 0, item);
          room.addLog(who, `restored "${item.title}"`);
          downloads.pump();
        }
        done(res);
      });

    case 'POST /like':
      return readJson(req, 3000, ({ url: link, t, like }) => {
        const h = room.history.find(x => x.url === link && x.t === t);
        if (h && songs.isDjSong(h)) {
          const likedBy = new Set(h.likedBy || []);
          if (like === false) likedBy.delete(who); else likedBy.add(who);
          if (likedBy.size) h.likedBy = [...likedBy]; else delete h.likedBy;
          room.historyRev++;
        }
        done(res);
      });

    case 'POST /retry':
      return readJson(req, 200, ({ id }) => {
        const item = room.queue.find(q => q.id === id && q.status === 'failed');
        if (item) { Object.assign(item, { status: 'waiting', tries: 0, error: null, retryAt: null }); room.addLog(who, `retried "${item.title}"`); downloads.pump(); }
        done(res);
      });

    case 'POST /chat':
      return readJson(req, 2000, ({ text, gif }) => {
        text = String(text || '').trim().slice(0, 500);
        if (gif !== undefined) {
          gif = chatGif(gif);
          if (!gif) { res.writeHead(400); return res.end(GIFS ? 'That GIF can\'t be sent' : 'GIFs are off on this Couchwave'); }
          text = '';
        }
        const wait = text || gif ? limits.chatWait(who) : 0;
        if (wait) {
          const s = Math.ceil(wait / 1000);
          res.writeHead(429, { 'Retry-After': s });
          return res.end(`Slow down: you can chat again in ${s} second${s === 1 ? '' : 's'}`);
        }
        if (text && room.dj && room.dj.command(who, text)) return done(res);
        if (gif) room.addChat(who, '', gif);
        else if (text) room.addChat(who, text);
        done(res);
      });

    case 'POST /color':
      return readJson(req, 200, ({ color, quiet }) => {
        color = String(color || '').toLowerCase();
        if (/^#[0-9a-f]{6}$/.test(color) && room.colors[who] !== color) {
          room.colors[who] = color;
          if (!quiet) room.logLook(who, 'changed their colour');
        }
        done(res);
      });

    case 'POST /face':
      return readJson(req, 200, ({ face, quiet }) => {
        face = String(face || '');
        if (face.length <= 16 && /\p{Extended_Pictographic}/u.test(face) && !/[<>&"'\s]/.test(face) && room.faces[who] !== face) {
          room.faces[who] = face;
          if (!quiet) room.logLook(who, `changed their emoji to ${face}`);
        }
        done(res);
      });

    case 'POST /react':
      return readJson(req, 300, r => {
        const e = String(r.e || '');
        if (e.length <= 16 && /\p{Extended_Pictographic}/u.test(e) && !/[<>&"']/.test(e)) {
          const now = Date.now();
          room.reactions.push({ id: ++room.reactId, t: now, e, n: Math.max(1, Math.min(50, Math.round(Number(r.n)) || 1)), cid: String(r.cid || '').slice(0, 20) });
          room.reactions = room.reactions.filter(x => now - x.t < secs(8)).slice(-300);
          room.nudge();
        }
        res.writeHead(204); res.end();
      });
  }

  const media = /^\/(video|audio)\/(\d+)$/.exec(url.pathname);
  if (req.method === 'GET' && media) {
    const id = +media[2], current = room.current;
    const item = current && current.id === id ? current : room.queue.find(q => q.id === id && q.status === 'ready');
    if (!item) { res.writeHead(404); return res.end(); }
    if (media[1] === 'audio' && item.audio && fs.existsSync(item.audio)) return sendFile(req, res, item.audio, 'audio/mp4', item.duration);
    return sendFile(req, res, item.file, 'video/mp4', item.duration);
  }

  res.writeHead(404); res.end();
}

// ---------- The web server ----------
function serve() {
  http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
    req.on('error', () => {});
    req.failed = err => {
      console.error(`${req.method} ${url.pathname} failed: ${err.stack || err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    };
    try { route(req, res, url); } catch (err) { req.failed(err); }
  }).on('error', err => fatal(err.code === 'EADDRINUSE'
    ? `Can't start: port ${PORT} is already in use. Is Couchwave already running? Close it, or set another "port" in config.json`
    : `Can't start: ${err.message}`)).listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
}

Object.assign(exports, { serve });
