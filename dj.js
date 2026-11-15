// The DJ: keeps the music going. While it's on, it keeps up to 10 songs of its own in the queue, like the
// ones people have been asking for: from YouTube's Mix (its radio playlist) for songs people requested (in
// the queue, or recently played: the History), preferring other artists, and skipping anything in the
// History or the queue, and anything too short, too long or not really a song (full albums, hour-long
// mixes, live sets...). Its ideas only ever come from songs people asked for, never its own picks, so it
// doesn't feed on itself. With nothing to go on (nobody has asked for anything yet, or nothing new turns
// up) it asks in the chat, once, when the queue is about to run dry, and starts again as soon as someone
// adds a song.
//
// Off until someone types "!dj on" in the chat; "!dj off" stops it adding songs (what it queued stays);
// "!dj" says whether it's on. Its songs go in as "DJ", always after everyone else's (server.js), and anyone
// can vote to remove them from the queue or skip them, as for anyone's songs. It remembers whether
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
const IDEAS_FROM = 10;                     // starting points: the last this-many songs people asked for
const FROM_ONE_MIX = 3;                    // songs taken from one Mix at most, for variety
// (COUCHWAVE_TIME_SCALE: the tests run the clock faster, see server.js)
const TIME_SCALE = Number(process.env.COUCHWAVE_TIME_SCALE) > 0 ? Number(process.env.COUCHWAVE_TIME_SCALE) : 1;
const CHECK_EVERY = 3000 * TIME_SCALE, RETRY_AFTER = 30000 * TIME_SCALE;

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
  let busy = false, nextTry = 0, asked = false, lastIdeas = '';
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
        asked = false;
        nextTry = 0;
        save();
        app.log(who, `turned the DJ ${want}`);
        if (on) {
          app.say(NAME, `${FACE} DJ on! I'll keep up to ${KEEP_QUEUED} songs queued, like what you've been asking for, always after yours. You can vote mine out of the queue like anyone's. Type !dj off to stop me.`);
          tick();
        } else {
          // What it already queued stays, until someone deletes it.
          const n = app.queue().filter(q => q.by === NAME).length;
          app.say(NAME, `${FACE} DJ off: I won't add any more${n ? `. My ${n} song${n === 1 ? '' : 's'} already queued stay${n === 1 ? 's' : ''} (you can vote them out of the queue)` : ''}. Type !dj on to bring me back.`);
        }
      }
    } else {
      app.say(NAME, `${FACE} The DJ is ${on ? 'on' : 'off'}. Type !dj ${on ? 'off' : 'on'} to turn it ${on ? 'off' : 'on'}.`);
    }
    return true;
  }

  // Starting points: the last few songs people asked for (queued, then played), in random order. Never the
  // DJ's own: it would end up going round in circles on its own picks.
  function ideas() {
    const people = [], seen = new Set();
    for (const q of [...app.queue()].reverse().concat(app.history())) {
      const id = idOf(q.url);
      if (!id || seen.has(id) || q.by === NAME) continue;
      seen.add(id);
      people.push({ id, title: q.title, by: q.by });
      if (people.length === IDEAS_FROM) break;
    }
    return shuffle(people);
  }

  // Says something in the chat, once, if the music's about to stop (nothing else waiting in the queue).
  function ask(text) {
    if (asked || app.queue().some(q => q.status !== 'failed')) return;
    app.say(NAME, `${FACE} ${text}`);
    asked = true;
  }

  async function tick() {
    if (!on || busy) return;
    if (app.queue().filter(q => q.by === NAME).length >= KEEP_QUEUED) return;
    const starts = ideas();
    const now = starts.map(s => s.id).sort().join(',');
    if (now !== lastIdeas) { lastIdeas = now; nextTry = 0; asked = false; } // someone asked for something new: go
    if (Date.now() < nextTry) return;
    if (!starts.length) return ask('Nothing to go on yet: add a song you like, and I\'ll keep the music going with more like it.');
    busy = true;
    try {
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
            `added "${pick.title}" (like "${short(seed.title)}", from ${seed.by})`);
          recentArtists.unshift(artist(pick.title));
          recentArtists.length = Math.min(recentArtists.length, 4);
          added++;
        }
      }
      if (added) asked = false;
      else if (app.queue().filter(q => q.by === NAME).length < KEEP_QUEUED) { // nothing new from anyone's songs
        nextTry = Date.now() + RETRY_AFTER; // try again in a while (or as soon as someone adds a song)
        ask('I\'ve run out of new songs like the ones you\'ve played: add one, and I\'ll keep going from there.');
      }
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
