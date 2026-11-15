// The DJ: keeps the music going. While it's on, it keeps up to 10 songs of its own in the queue, like the
// ones people have been asking for: from YouTube's Mix (its radio playlist) for songs people requested (in
// the queue, or recently played: the History), preferring other artists, and skipping anything in the
// History or the queue, and anything too short, too long or not really a song (full albums, hour-long
// mixes, live sets...). When there's nothing new to find from people's songs, it carries on from its own.
//
// Off until someone types "!dj on" in the chat; "!dj off" stops it adding songs (what it queued stays);
// "!dj" says whether it's on. Its songs go in as "DJ", always after everyone else's (server.js), and anyone
// can delete them from the queue (skipping the one playing is a vote, as for anyone's). It remembers whether
// it's on in data/dj.json.
//
// It only uses what server.js hands it (`app`, see "The DJ" there), so it can be changed or swapped out
// without touching the rest.
const fs = require('fs');
const path = require('path');

const NAME = 'DJ', FACE = '🎧';
const KEEP_QUEUED = 10;                    // the DJ's own songs waiting in the queue, at most
const MIN_SECONDS = 90, MAX_SECONDS = 600; // a song, not a jingle or an hour-long mix
const NOT_A_SONG = /full album|\bhours?\b|compilation|\bmix\b|playlist|\blive\b|non-?stop|megamix/i;
const IDEAS_FROM = 5;                      // starting points: the last this-many songs people asked for
const FROM_ONE_MIX = 3;                    // songs taken from one Mix at most, for variety
const CHECK_EVERY = 3000, RETRY_AFTER = 30000;

const idOf = url => (/[?&]v=([\w-]{11})/.exec(url || '') || /youtu\.be\/([\w-]{11})/.exec(url || '') || [])[1];
const artist = title => String(title).split(/\s[-–—|:]\s/)[0].trim().toLowerCase(); // "Queen - Don't Stop Me Now" -> "queen"
const short = title => String(title).replace(/\s*[[(].*$/, '');                      // without "(Official Video)" etc.
const shuffle = list => { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } return list; };

module.exports = function startDj(app) {
  const file = path.join(app.dataDir, 'dj.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch {}
  let on = saved.on === true; // off by default
  const recentArtists = [];   // the DJ's own last few, to keep some variety
  let busy = false, nextTry = 0, saidNothingToGoOn = false;
  if (!app.faces[NAME]) app.faces[NAME] = FACE;

  function save() {
    try { app.writeAtomic(file, JSON.stringify({ on })); }
    catch (err) { console.error('DJ: saving failed:', err.message); }
  }

  // A chat message starting with "!dj" (called by the server). Returns true if it was one: it isn't posted.
  function command(who, text) {
    const m = /^!dj(?:\s+(\S+))?\s*$/i.exec(text.trim());
    if (!m) return false;
    const want = (m[1] || '').toLowerCase();
    if (want === 'on' || want === 'off') {
      if ((want === 'on') === on) app.say(NAME, `${FACE} I'm already ${want}.`);
      else {
        on = want === 'on';
        saidNothingToGoOn = false;
        nextTry = 0;
        save();
        app.log(who, `turned the DJ ${want}`);
        if (on) {
          app.say(NAME, `${FACE} DJ on! I'll keep up to ${KEEP_QUEUED} songs queued, like what you've been asking for, always after yours. Anyone can delete mine from the queue. Type !dj off to stop me.`);
          tick();
        } else {
          // What it already queued stays, until someone deletes it.
          const n = app.queue().filter(q => q.by === NAME).length;
          app.say(NAME, `${FACE} DJ off: I won't add any more${n ? `. My ${n} song${n === 1 ? '' : 's'} already queued stay${n === 1 ? 's' : ''} (anyone can delete them)` : ''}. Type !dj on to bring me back.`);
        }
      }
    } else {
      app.say(NAME, `${FACE} The DJ is ${on ? 'on' : 'off'}. Type !dj ${on ? 'off' : 'on'} to turn it ${on ? 'off' : 'on'}.`);
    }
    return true;
  }

  // Starting points, best first: the last few songs people asked for (queued, then played), then the DJ's own.
  function ideas() {
    const people = [], own = [], seen = new Set();
    for (const q of [...app.queue()].reverse().concat(app.history())) {
      const id = idOf(q.url);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (q.by === NAME) own.push({ id, title: q.title, by: q.by });
      else if (people.length < IDEAS_FROM) people.push({ id, title: q.title, by: q.by });
    }
    return [...shuffle(people), ...own.slice(0, IDEAS_FROM)];
  }

  async function tick() {
    if (!on || busy || Date.now() < nextTry) return;
    if (app.queue().filter(q => q.by === NAME).length >= KEEP_QUEUED) return;
    busy = true;
    try {
      const starts = ideas();
      if (!starts.length) {
        if (!saidNothingToGoOn) app.say(NAME, `${FACE} Nothing to go on yet: add a song, and I'll take it from there.`);
        saidNothingToGoOn = true;
        nextTry = Date.now() + RETRY_AFTER;
        return;
      }
      let added = 0;
      for (const seed of starts) {
        const wanted = KEEP_QUEUED - app.queue().filter(q => q.by === NAME).length;
        if (!on || wanted <= 0) break;
        const current = app.current();
        const avoid = new Set([...app.history().map(h => idOf(h.url)), ...app.queue().map(q => idOf(q.url)), current && idOf(current.url)]);
        const songs = (await app.mix(seed.id)).filter(s => !avoid.has(s.id) && s.duration >= MIN_SECONDS
          && s.duration <= MAX_SECONDS && !NOT_A_SONG.test(s.title));
        // Other artists first (not the starting song's, not the DJ's last few), then the rest; the closest few of each.
        const fresh = songs.filter(s => artist(s.title) !== artist(seed.title) && !recentArtists.includes(artist(s.title)));
        const choices = [...shuffle(fresh.slice(0, 8)), ...shuffle(songs.filter(s => !fresh.includes(s)).slice(0, 4))];
        const artistsTaken = new Set();
        let fromThisMix = 0;
        for (const pick of choices) {
          if (!on || fromThisMix >= Math.min(FROM_ONE_MIX, wanted)) break;
          if (fresh.length > 1 && artistsTaken.has(artist(pick.title))) continue; // one each, while there's a choice
          if (app.queue().some(q => idOf(q.url) === pick.id)) continue;
          artistsTaken.add(artist(pick.title));
          fromThisMix++;
          app.addSong(`https://www.youtube.com/watch?v=${pick.id}`, pick.title, NAME,
            `added "${pick.title}" (like "${short(seed.title)}"${seed.by === NAME ? '' : `, from ${seed.by}`})`);
          recentArtists.unshift(artist(pick.title));
          recentArtists.length = Math.min(recentArtists.length, 4);
          added++;
        }
      }
      if (!added) nextTry = Date.now() + RETRY_AFTER; // nothing new anywhere: try again in a while
    } catch (err) {
      console.error('DJ:', err.message);
      nextTry = Date.now() + RETRY_AFTER;
    } finally {
      busy = false;
    }
  }
  setInterval(tick, CHECK_EVERY);

  return { name: NAME, isOn: () => on, command };
};
