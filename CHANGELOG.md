# Changelog

Changes to Couchwave. The newest are at the top; "Unreleased" is what's been added since the last release.

## Unreleased

### Added

- **Your own nickname**: joining now takes the room password plus your nickname's own password, chosen the
  first time you use the nickname. Nobody else can join as you (before, anyone with the room password could
  type any name), and the login cookie can't be edited to be someone else. Nicknames ignore capitals.
  `node server.js --forget-name <name>` frees a nickname, e.g. for a forgotten password. Everyone has to
  log in once more after updating; whoever logs in first with an existing nickname claims it.

- **Audio only**: a video button (camera icon) next to full screen turns the video off just for you, so
  only the sound plays and the video isn't downloaded (saves data). While it's on, the camera shows
  crossed out. Click it again to bring the picture back, in sync with the sound. It's remembered in your
  browser.
- **Loading spinner** on the video while the picture loads (after turning audio only off, when a song
  starts, or while it buffers), instead of a plain black screen.
- **Joined / left in the activity log**: shows when someone opens the site and when they leave (after a
  minute without their page checking in, or straight away when they log out). Reloading the page or a
  short drop-out isn't logged, and people already there aren't re-announced when the server restarts.
- **Vote to skip**: Skip is now a vote. Once someone clicks it, the button shows e.g. "1 out of 3 voted
  to skip" for everyone, and the song is skipped when more than half of the people online have voted (on
  your own, one click still skips). Click it again to take your vote back; hover over it to see who voted.
  Votes start over with each song, only count while the voter is online, and survive a server restart.
  The lock-screen "next" button votes too. Whoever added the song can skip it straight away, no vote.
- **Instant updates**: chat messages, votes, songs changing, people joining and reactions now show up for
  everyone the moment they happen, instead of within 2 seconds. Your own messages appear as soon as you
  press send (faded until the server has them).
- **Tests**: `node --test` checks the whole app in about 25 seconds, using stand-ins for yt-dlp and ffmpeg
  so it needs no internet and never touches your real server. See "Running the tests" in the README.
- **Log everyone out**: `node server.js --logout-everyone` makes everyone enter the password again,
  without changing it. Works while Couchwave is running.

### Changed

- **Only whoever added a song can delete it** from the queue (and undo deleting it). Other people's songs
  have no delete button, and the server refuses it too.
- **Chat and page loads no longer stall while video plays**: songs are now sent to each viewer at a steady
  pace (the first 20 seconds at full speed, so songs and seeks still start straight away, then 3× what the
  video needs) instead of as fast as the connection allows. Several browsers grabbing video at full speed
  filled the host's upload, and through a Cloudflare Tunnel that made chat messages and page loads hang for
  10+ seconds.
- **"Left" in the activity log** now shows about 10 seconds after someone closes the page (it was a
  minute; a reload or closing one of two tabs doesn't count), and is no longer lost when the server
  restarts: who's here is now saved with everything else. If the server was off for a while, people are
  logged as leaving at the time they were last seen.
- **Safer logins**: the join screen now sends the password once, and the server answers with a login
  cookie, so browsers no longer keep the password itself. Everyone has to log in once more after updating.
