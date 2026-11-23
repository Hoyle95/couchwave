// ---------- Settings ----------
const fs = require('fs');
const path = require('path');
const { secs, videoId, watchUrl } = require('./common');

const NAME = 'DJ', FACE = '🎧';
const KEEP_QUEUED = 10;
const MIN_SECONDS = 60, MAX_SECONDS = 20 * 60;
const rightLength = seconds => seconds >= MIN_SECONDS && seconds <= MAX_SECONDS;
const IDEAS_FROM = 10;
const FROM_ONE_MIX = 3;
const CHECK_EVERY = secs(3), RETRY_AFTER = secs(30), LONGEST_WAIT = secs(600);
const NO_MIX_FOR = secs(3600), MIX_GAP = secs(10);
const SAY_NOTHING = 'Nothing to go on yet: add a song you like, and I\'ll keep the music going with more like it.';
const SAY_NO_MUSIC = 'I can only find songs like music, and YouTube has no Mix for the other videos here. Add a song you like, and I\'ll keep the music going from there.';
const SAY_WRONG_LENGTH = 'I only find songs like ones between 1 and 20 minutes long. Add one you like, and I\'ll keep the music going from there.';
const SAY_RUN_OUT = 'I\'ve run out of new songs like the ones you\'ve played: add one, and I\'ll keep going from there.';

// ---------- Song helpers ----------
const artist = title => String(title).split(/\s[-–—|:]\s/)[0].trim().toLowerCase();
const short = title => String(title).replace(/\s*[[(].*$/, '');
const seedName = title => (/^https?:\/\//.test(title) ? 'a song' : `"${short(title)}"`);
const shuffle = list => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };

// ---------- Start, save and !dj commands ----------
module.exports = function startDj(app) {
  const file = path.join(app.dataDir, 'dj.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  let on = saved.on === true;
  const recentArtists = [];
  let busy = false, nextTry = 0, wait = RETRY_AFTER, asked = false, lastIdeas = '';
  const noMix = new Map();
  if (!app.faces[NAME]) app.faces[NAME] = FACE;

  function save() {
    try { app.writeAtomic(file, JSON.stringify({ on })); }
    catch (err) { console.error('DJ: saving failed:', err.message); }
  }

  function command(who, text) {
    const m = /^!dj(?:\s+(\S+))?\s*$/i.exec(text.trim());
    if (!m) return false;
    const want = (m[1] || '').toLowerCase();
    if (want === 'on' || want === 'off') {
      if ((want === 'on') === on) app.say(NAME, `${FACE} I'm already ${want}.`);
      else {
        on = want === 'on';
        asked = false;
        nextTry = 0;
        save();
        app.log(who, `turned the DJ ${want}`);
        if (on) {
          app.say(NAME, `${FACE} DJ on! I'll keep up to ${KEEP_QUEUED} songs queued, like what you've been asking for, always after yours. You can vote mine out of the queue like anyone's. Type !dj off to stop me.`);
          tick();
        } else {
          const n = app.queue().filter(q => q.by === NAME).length;
          app.say(NAME, `${FACE} DJ off: I won't add any more${n ? `. My ${n} song${n === 1 ? '' : 's'} already queued stay${n === 1 ? 's' : ''} (you can vote them out of the queue)` : ''}. Type !dj on to bring me back.`);
        }
      }
    } else {
      app.say(NAME, `${FACE} The DJ is ${on ? 'on' : 'off'}. Type !dj ${on ? 'off' : 'on'} to turn it ${on ? 'off' : 'on'}.`);
    }
    return true;
  }

  // ---------- Picking songs ----------
  function ideas() {
    const now = Date.now(), latest = [], starts = [], seen = new Set();
    for (const [id, t] of noMix) if (now - t > NO_MIX_FOR) noMix.delete(id);
    let noMusic = false, wrongLength = false;
    for (const q of app.history()) {
      const id = videoId(q.url);
      const likedBy = q.by === NAME && Array.isArray(q.likedBy) && q.likedBy.length ? q.likedBy : null;
      if (!id || seen.has(id) || (q.by === NAME && !likedBy) || !(q.duration > 0)) continue;
      seen.add(id);
      if (latest.length < IDEAS_FROM) latest.push(id);
      if (noMix.has(id)) { noMusic = true; continue; }
      if (!rightLength(q.duration)) { wrongLength = true; continue; }
      starts.push({ id, title: q.title, by: q.by, likedBy });
      if (starts.length === IDEAS_FROM) break;
    }
    return { key: latest.sort().join(','), starts: shuffle(starts), noMusic, wrongLength };
  }

  function ask(text) {
    if (asked || app.queue().some(q => q.status !== 'failed')) return;
    app.say(NAME, `${FACE} ${text}`);
    asked = true;
  }

  async function tick() {
    if (!on || busy) return;
    if (app.queue().filter(q => q.by === NAME).length >= KEEP_QUEUED) return;
    const { key, starts, noMusic, wrongLength } = ideas();
    if (key !== lastIdeas) { lastIdeas = key; nextTry = 0; wait = RETRY_AFTER; asked = false; }
    if (Date.now() < nextTry) return;
    if (!starts.length) return ask(wrongLength ? SAY_WRONG_LENGTH : noMusic ? SAY_NO_MUSIC : SAY_NOTHING);
    busy = true;
    try {
      let added = 0, looked = 0;
      const stillWanted = () => (on ? KEEP_QUEUED - app.queue().filter(q => q.by === NAME).length : 0);
      for (const seed of starts) {
        if (stillWanted() <= 0) break;
        if (looked++) await new Promise(r => setTimeout(r, MIX_GAP));
        const wanted = stillWanted();
        if (wanted <= 0) break;
        const current = app.current();
        const avoid = new Set([...app.history().map(h => videoId(h.url)), ...app.queue().map(q => videoId(q.url)), current && videoId(current.url)]);
        const mix = await app.mix(seed.id);
        if (mix.length && mix.every(s => s.id === seed.id)) { noMix.set(seed.id, Date.now()); continue; }
        const songs = mix.filter(s => !avoid.has(s.id) && rightLength(s.duration));
        const fresh = songs.filter(s => artist(s.title) !== artist(seed.title) && !recentArtists.includes(artist(s.title)));
        const choices = [...shuffle(fresh.slice(0, 8)), ...shuffle(songs.filter(s => !fresh.includes(s)).slice(0, 4))];
        const artistsTaken = new Set();
        let fromThisMix = 0;
        for (const pick of choices) {
          if (!on || fromThisMix >= Math.min(FROM_ONE_MIX, wanted)) break;
          if (fresh.length > 1 && artistsTaken.has(artist(pick.title))) continue;
          if (app.queue().some(q => videoId(q.url) === pick.id)) continue;
          artistsTaken.add(artist(pick.title));
          fromThisMix++;
          app.addSong(watchUrl(pick.id), pick.title, NAME,
            `added "${pick.title}" (like ${seedName(seed.title)}, ${seed.likedBy ? 'a liked song' : `from ${seed.by}`})`);
          recentArtists.unshift(artist(pick.title));
          recentArtists.length = Math.min(recentArtists.length, 4);
          added++;
        }
      }
      if (added) { asked = false; wait = RETRY_AFTER; }
      else if (app.queue().filter(q => q.by === NAME).length < KEEP_QUEUED) {
        nextTry = Date.now() + wait;
        wait = Math.min(wait * 2, LONGEST_WAIT);
        ask(ideas().starts.length ? SAY_RUN_OUT : SAY_NO_MUSIC);
      }
    } catch (err) {
      console.error('DJ:', err.message);
      nextTry = Date.now() + wait;
      wait = Math.min(wait * 2, LONGEST_WAIT);
    } finally {
      busy = false;
    }
  }
  setInterval(tick, CHECK_EVERY);

  return { name: NAME, isOn: () => on, command };
};
