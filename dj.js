// ---------- Settings ----------
const fs = require('fs');
const path = require('path');

const NAME = 'DJ', FACE = '🎧';
const KEEP_QUEUED = 10;
const MIN_SECONDS = 60, MAX_SECONDS = 20 * 60;
const NOT_A_SONG = /full album|\bhours?\b|compilation|\bmix\b|playlist|\blive\b|non-?stop|megamix/i;
const IDEAS_FROM = 10;
const FROM_ONE_MIX = 3;
const TIME_SCALE = Number(process.env.COUCHWAVE_TIME_SCALE) > 0 ? Number(process.env.COUCHWAVE_TIME_SCALE) : 1;
const CHECK_EVERY = 3000 * TIME_SCALE, RETRY_AFTER = 30000 * TIME_SCALE, LONGEST_WAIT = 600000 * TIME_SCALE;
const NO_MIX_FOR = 3600000 * TIME_SCALE, MIX_GAP = 10000 * TIME_SCALE;
const SAY_NOTHING = 'Nothing to go on yet: add a song you like, and I\'ll keep the music going with more like it.';
const SAY_NO_MUSIC = 'I can only find songs like music, and YouTube has no Mix for the other videos here. Add a song you like, and I\'ll keep the music going from there.';
const SAY_RUN_OUT = 'I\'ve run out of new songs like the ones you\'ve played: add one, and I\'ll keep going from there.';

// ---------- Song helpers ----------
const idOf = url => (/(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([\w-]{11})/.exec(url || '') || [])[1];
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
    let noMusic = false;
    for (const q of [...app.queue()].reverse().concat(app.history())) {
      const id = idOf(q.url);
      if (!id || seen.has(id) || q.by === NAME) continue;
      seen.add(id);
      if (latest.length < IDEAS_FROM) latest.push(id);
      if (noMix.has(id)) { noMusic = true; continue; }
      starts.push({ id, title: q.title, by: q.by });
      if (starts.length === IDEAS_FROM) break;
    }
    return { key: latest.sort().join(','), starts: shuffle(starts), noMusic };
  }

  function ask(text) {
    if (asked || app.queue().some(q => q.status !== 'failed')) return;
    app.say(NAME, `${FACE} ${text}`);
    asked = true;
  }

  async function tick() {
    if (!on || busy) return;
    if (app.queue().filter(q => q.by === NAME).length >= KEEP_QUEUED) return;
    const { key, starts, noMusic } = ideas();
    if (key !== lastIdeas) { lastIdeas = key; nextTry = 0; wait = RETRY_AFTER; asked = false; }
    if (Date.now() < nextTry) return;
    if (!starts.length) return ask(noMusic ? SAY_NO_MUSIC : SAY_NOTHING);
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
        const avoid = new Set([...app.history().map(h => idOf(h.url)), ...app.queue().map(q => idOf(q.url)), current && idOf(current.url)]);
        const mix = await app.mix(seed.id);
        if (mix.length && mix.every(s => s.id === seed.id)) { noMix.set(seed.id, Date.now()); continue; }
        const songs = mix.filter(s => !avoid.has(s.id) && s.duration >= MIN_SECONDS
          && s.duration <= MAX_SECONDS && !NOT_A_SONG.test(s.title));
        const fresh = songs.filter(s => artist(s.title) !== artist(seed.title) && !recentArtists.includes(artist(s.title)));
        const choices = [...shuffle(fresh.slice(0, 8)), ...shuffle(songs.filter(s => !fresh.includes(s)).slice(0, 4))];
        const artistsTaken = new Set();
        let fromThisMix = 0;
        for (const pick of choices) {
          if (!on || fromThisMix >= Math.min(FROM_ONE_MIX, wanted)) break;
          if (fresh.length > 1 && artistsTaken.has(artist(pick.title))) continue;
          if (app.queue().some(q => idOf(q.url) === pick.id)) continue;
          artistsTaken.add(artist(pick.title));
          fromThisMix++;
          app.addSong(`https://www.youtube.com/watch?v=${pick.id}`, pick.title, NAME,
            `added "${pick.title}" (like ${seedName(seed.title)}, from ${seed.by})`);
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
