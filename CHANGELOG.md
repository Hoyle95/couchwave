# Changelog

Changes to Couchwave, newest first. "Unreleased" is what's been added since the last release.

## Unreleased

### Added

- **Even volume**: each song's loudness is measured when it downloads (in the same step that makes the
  audio-only copy), and loud songs are turned down to match, aiming for YouTube's usual level. Songs already
  downloaded are measured once when Couchwave starts.
- **No duplicates**: a song that's already queued or playing can't be added again, whatever kind of link it
  comes as. Playlists leave such songs out and searches don't add them; both say so in Activity.
- **Speed limits**: each person can send 8 chat messages in 10 seconds and add 10 songs a minute. Going over
  the chat limit pauses that person's chat for 30 seconds, twice as long each time it happens again within 10
  minutes (up to 5 minutes); the chat box counts down and keeps the unsent message. Adding a song over the
  limit explains why it didn't go in.

- **Security headers**: a content security policy lets browsers run only Couchwave's own scripts (any
  injected script, like an `onerror="…"` slipped into a message, is refused), other sites can't show
  Couchwave inside theirs, browsers don't second-guess file types, and YouTube isn't told your room's
  address when someone opens a link. The page's buttons are wired up in `app.js` instead of `onclick="…"`,
  and the saved-theme line moved to `js/theme.js`.

### Changed

- **Moving through a song when its owner has gone**: only whoever added a song can move through it while
  they're online (so nobody skips it without a vote by jumping to the end), but once they've gone, anyone
  can. The DJ's songs can be moved by someone who's the only one online.
- **Fewer checks with the server**: while instant updates are connected, pages check in every 10 seconds
  instead of every 2 (changes still arrive straight away). Without them, it's every 2 seconds as before.
- **Links are stored one way**: share links (`youtu.be/…?si=…`), Shorts, `music.youtube.com` and other YouTube
  links are saved as a standard `youtube.com/watch` link, so the same song is always recognised as the same song.
- **The page's files are in `public/`**: `index.html`, with `css/`, `js/`, `fonts/` and `icons/` folders
  inside. The server and its settings stay at the top. `git` moves them by itself; after updating from a
  release zip, the old `index.html`, `style.css`, `app.js`, `fonts/` and `icons/` at the top are no longer
  used and can be deleted.
- **Reading a playlist or search gives up after 2 minutes** if YouTube doesn't answer, instead of waiting
  forever.
- **The DJ waits longer between tries** when it has run out of new songs: 30 seconds, then twice as long each
  time up to 10 minutes, starting over as soon as someone adds a song.
- **The DJ picks songs between 1 and 20 minutes long** (it was 1½ to 10).
- **Faster and lighter pages**: the page, its style and script are compressed (about a quarter of the size),
  and browsers reuse their copy when nothing has changed instead of downloading it again. Big status updates
  are compressed too. A page in the background (a locked phone, another tab) only loads a song's sound, not
  its video, until it's looked at again.
- **Settings only come from `config.json`**: the room password and port can no longer be overridden by the
  `YTP_PASSWORD` and `PORT` environment variables, a leftover from early on that was never documented.
- **Tidier code** (nothing changes for anyone using it): the page is split into `index.html`, `style.css` and
  `app.js`, every file is grouped into sections with short headers instead of long comments, and leftovers
  for data and pages from before v0.1.0 are gone.

### Fixed

- **Playlists lost when Couchwave restarted** while it was still reading them (saving `config.json` or
  updating is enough): the songs never went in and Activity said "is adding a playlist…" for good. Playlists
  being read are now remembered and read again after a restart, and entries left stuck from before say they
  didn't finish.
- **The DJ getting stuck on videos that aren't music**: with only non-music videos (Shorts or not) to go on,
  it asked YouTube for their Mix again every 30 seconds, forever. Now it remembers which videos have no Mix,
  says once that it needs a song, and goes back further in the History to songs that do have one.
- **Songs added as Shorts links** were never used as the DJ's starting points, and weren't recognised as
  repeats. (Music Shorts have a Mix like any song.)
- **The DJ's Activity entries** showed a raw link ("like "https://…"") when the song it started from hadn't
  finished downloading; they now say "like a song".
- **YouTube's "Please sign in" check** showed in the queue as a cut-off error message. It's now "YouTube bot
  check", and retried by itself like the other one.
- **Mute wasn't remembered**: after a refresh the player came back unmuted (the volume level and the chat's
  mute were remembered). Now mute is too.
- **Undo could put a song back twice**, if someone had added it again while it was removed. It now says the
  song is already in the queue.
- **Emoji or accented letters could arrive garbled** when a message reached the server in two pieces.
- **A song with a missing file could crash the server** when someone's page asked for it.
- **Tests that failed now and then on a busy computer** (pausing, download pacing, instant updates, logging
  everyone out, the DJ stopping, a song ending) now allow for the time the test servers take to start and
  respond. The chat tests run side by side like the others.

### Known issues

- **Playing on with the phone locked or the browser minimised is buggy**: the song playing carries on, but
  the next one doesn't always start. To be looked into.

## v0.1.0 beta (2026-11-16)

The first release. It's a beta: it runs a real room every day, but expect the odd rough edge.

### Added

- **Accounts**: joining takes the room password plus your nickname's own password, chosen the first time
  you use it, so nobody can join as you. Look-alike nicknames are refused, and "DJ" is reserved.
  Everyone logs in once more after updating; whoever logs in first with an existing nickname claims it.
- **Admin commands**: `--set-password`, `--delete-account` and `--logout-everyone`
  (see [docs/FEATURES.md](docs/FEATURES.md#server-commands)). They work while Couchwave is running.
- **DJ**: `!dj on` in the chat keeps up to 10 songs queued, picked from YouTube's Mix of songs people asked
  for (never its own picks), always after people's songs. It asks in the chat when it has nothing to go on.
  Off by default; `!dj off` stops it.
- **History**: the last 100 songs played, under Activity, with thumbnails, who asked, when, a copy link, and
  a + to put a song back in the queue. Scrolls with the mouse wheel; names get up to 3 lines.
- **Vote to remove**: a bin on every queued song. Your own go straight away; anyone else's, and the DJ's,
  go once enough of the people online vote. The vote count shows on the button. If a song plays before
  enough people vote to remove it, their votes count as votes to skip it.
- **Vote to skip**: Skip is a vote ("1 out of 3 voted to skip"). Whoever added the song can skip it straight
  away. A song skipped by a vote shows in Activity as everyone's doing, not the last voter's.
- **`public` in config.json (not recommended)**: `"public": true` removes the room password, so anyone with
  the address can join (nicknames still have their own passwords). Off by default; see the warning in
  [docs/INSTALL.md](docs/INSTALL.md#settings).
- **`votePercent` in config.json**: how many of the people online have to vote, to skip or to remove
  someone else's song: 60% by default, rounded up (2 of 3, 3 of 5). The DJ is never counted.
- **`maxVideoHours` in config.json**: how long any one video can be, 3 hours by default (`1.5` is an hour and
  a half, `0.25` a quarter of an hour). Longer links are refused before anything downloads, with the reason
  in the queue; searches pass over results that are too long, and playlists leave them out.
- **`downloadAhead` and `downloadsAtOnce` in config.json**: how many songs at the top of the queue are
  downloaded ahead of time (20 by default), and how many download at the same time (3). Both were fixed
  before.
- **Instant updates**: chat, votes, songs changing and people joining show up for everyone straight away.
- **Joined / left** in the activity log, with a sound (different from the message ding, and set by the same
  volume slider and mute button).
- **Audio only**: turn the video off just for you, to listen and save data.
- **Loading spinner** while the video loads.
- **Join screen**: eye buttons to show what you typed, and password managers can now fill in your login.
  The footer (GitHub link and credits) shows there too.
- **Tests**: `node --test` checks the whole app in under 10 seconds, without internet or your real data.
- **Docs**: a short README, with setup, settings and troubleshooting in [docs/INSTALL.md](docs/INSTALL.md),
  and every feature and command in [docs/FEATURES.md](docs/FEATURES.md).

### Changed

- **Moving through a song** (the time bar): only whoever added it can, so nobody can skip a song without a
  vote by jumping to the end. On the DJ's songs, nobody can.
- **Full screen, like Twitch**: video edge to edge with the controls over it (they fade when the mouse is
  still), and the chat down the right, which you can hide.
- **Song names keep their place** in the queue while they're searched for, and the best-matching result is
  picked, not just YouTube's first.
- **No drag-to-reorder**: the queue's order comes from people taking turns.
- **Chat no longer stalls while video plays**: songs are sent at a steady pace, so they don't fill the
  host's upload.
- **Titles with accents, dashes, emoji or other alphabets** display properly on Windows.
- **Safer logins**: browsers keep a signed login, never a password. Over `https://` (Cloudflare Tunnel, Caddy)
  it's marked HTTPS-only, so it's never sent unencrypted; plain `http://` on a home network works as before.
- **Names on the light theme** no longer have a black outline.

### Fixed

- **People flickering offline**: someone with Couchwave in a background tab or on a locked phone kept
  dropping off the online list and coming back (browsers slow such pages down). That also left them out of
  vote counts, so fewer votes than needed could remove or skip a song. An open page now always counts.
