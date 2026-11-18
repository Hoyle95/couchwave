# Changelog

Changes to Couchwave, newest first. "Unreleased" is what's been added since the last release.

## Unreleased

### Added

- **One-line install**: paste one line into PowerShell (Windows) or a terminal (Debian, Ubuntu, Raspberry Pi
  OS), and it installs Node.js, yt-dlp and ffmpeg if they're missing, downloads the newest Couchwave, makes it
  start with the computer, lets friends on your home network in, starts it, and shows the address and room
  password. If port 3000 is already taken, it picks the next free one. Running it again updates Couchwave,
  keeping your settings and data. See
  [docs/INSTALL.md](docs/INSTALL.md#one-line-install).
- **How long each song is, in the played history**: shown on its picture, like on YouTube. The time under it,
  now with a little clock, is when it played. Songs over an hour now show as hours, like 2:01:00 instead of 121:00.
- **Which version of Couchwave this is**: under the footer once you've joined (like v0.3.0-beta), and with
  `node server.js --version`.
- **A thumbs-up for the DJ's songs**: in the played history, like a song the DJ picked and it finds more
  like it, as if someone had asked for it. Click again to take the like back. Likes are private: you see
  only your own.

### Changed

- **The code is reorganised** into smaller files in a new `lib/` folder (the DJ moved there too), so it's
  easier to work on. Couchwave works just the same, and `node server.js` still starts it. If you update by
  copying files over by hand, copy the new `lib/` folder too; the old `dj.js` can be deleted.

### Fixed

- **The DJ followed long videos**: it found "more like" a 2-hour focus-music playlist, and queued ambient
  tracks and drone videos. It now only goes on songs that have played (so it knows how long they are) and
  are between 1 and 20 minutes long, the same rule as for the songs it picks (if nothing fits, it says so in
  the chat). It no longer judges songs by their titles: it used to skip any with words like "mix", "live" or
  "playlist" in them.
- **A video longer than the limit stayed in the queue** as failed, with a Retry button that couldn't help.
  It's now taken out as soon as its length is known (before anything downloads), and its Activity line
  says why, like "tried to add …, but it's longer than 3 hours". Any left over from before are cleared when
  Couchwave starts.

## v0.3.0 beta (2026-11-17)

Still a beta. Tools for whoever runs Couchwave (`--status`, `--stop` and `stop.cmd`, `--remove-song`,
`--clear`), a backup every day, a gentler DJ, and an important fix: one malformed request could stop Couchwave.
**Download `couchwave-v0.3.0-beta.zip`** from the release (not "Source code"). **Updating?** Stop Couchwave,
unzip it into your Couchwave folder, replacing the old files, and start it again: settings, data and logins
are kept. On Windows, stop it the old way this one time (close the `start.cmd` window, or
`Stop-ScheduledTask Couchwave` and end Node.js in Task Manager); from now on, `stop.cmd` does it.

### Added

- **`node server.js --remove-song <song>`**, for whoever runs Couchwave: takes a song out of the queue
  straight away, with no vote, by its number in the queue, its YouTube link or part of its name. It shows
  the song and asks first, and works whether Couchwave is running or not (no restart needed). On its own,
  it lists the queue with the numbers. Handy for a song that will never download, like one YouTube only
  shows to signed-in accounts.
- **`node server.js --clear <what>`**, for whoever runs Couchwave: clears the chat, the Activity log or the
  played history (any or all of them: `--clear chat activity`, `--clear all`) for everyone, straight away.
  It asks first, and Activity notes that it was cleared. On its own, it says how much there is of each.
- **`node server.js --status`**: how Couchwave is doing at a glance, whether it's running or not: who's
  online, what's playing, the queue, the DJ, the free disk space, the versions of its tools and whether
  there's a newer Couchwave.
- **`youtubeCookies` in config.json**, for when YouTube keeps stopping downloads with its bot check, or a
  video only shows to signed-in accounts: yt-dlp can use a signed-in account's cookies, from a file or a
  browser on the same computer (see [docs/INSTALL.md](docs/INSTALL.md#settings); use a spare account).
- **A backup every day** in `data/backups/`: the accounts and logins, the queue, chat and history, and
  `config.json`, keeping the last 7 days.
- **A warning when yt-dlp can't update itself** (installed with pip or a package manager), in Activity and
  the log, since an out-of-date yt-dlp stops downloading as YouTube changes.
- **A proper way to stop Couchwave on Windows**: double-click the new `stop.cmd` (or run
  `node server.js --stop`). It saves everything and stops Couchwave, including when it starts with the PC.
  Before, stopping the scheduled task left Couchwave running until you found it in Task Manager.

### Changed

- **The DJ fills up gently**: turning it on brings its first songs straight away, then it asks YouTube for
  one more Mix every 10 seconds until it has 10 queued, instead of asking for them all within a few seconds
  (a burst like that can make YouTube start checking for bots).
- **YouTube's bot check and rate limit are given time**: a song that hits one is tried again after a minute,
  then 5 minutes, instead of 10 and 20 seconds, so Couchwave doesn't keep pushing while YouTube is pushing back.
- **The DJ drops its own songs that can't be downloaded** (Activity says why), instead of leaving them in the
  queue, where they took up its 10 places. Other people's stay, with their Retry button.

### Fixed

- **One malformed request could stop Couchwave**, for anyone who could reach it, without logging in (it
  restarted by itself a few seconds later). Requests it can't read are now turned away, and anything that goes
  wrong while answering one is written to the log instead of stopping the server.
- **A `port` that's already in use** (say, Couchwave already running) now says so plainly in the log, instead
  of an error dump every few seconds. A `port` that isn't a whole number from 1 to 65535 falls back to 3000,
  and the log says so.

## v0.2.1 beta (2026-11-17)

Still a beta. Safer logins (each device its own, and a proper limit on password guessing), a Couchwave that
looks after itself (stuck downloads, a full disk, missing tools), and security fixes. **Download
`couchwave-v0.2.1-beta.zip`** from the release (not "Source code"). **Updating?** Stop Couchwave, unzip it
into your Couchwave folder, replacing the old files, and start it again: everyone stays logged in. Behind
nginx, add the `X-Forwarded-For` line from [docs/INSTALL.md](docs/INSTALL.md#letting-friends-in).

### Added

- **A limit on wrong passwords for each nickname**: after 20 wrong passwords for the same nickname within 15
  minutes, from anywhere, new logins with it wait 15 minutes. Devices already logged in with it carry on as
  normal.
- **`trustProxy` in config.json**, for a proxy that isn't on your computer or home network (like one on a
  rented server). Most setups don't need it: see [docs/INSTALL.md](docs/INSTALL.md#letting-friends-in).
- **A warning in the log if the room password is short** (under 8 characters), since it's easy to guess.
- **Other websites can't use Couchwave through your friends' browsers**: a page elsewhere (even another one
  on your own computer or home network) can no longer send chat messages, votes or songs as someone who's
  logged in to Couchwave.
- **Stuck downloads are stopped and tried again**: a download that gets nowhere for 5 minutes shows
  "Download stalled" and is retried, instead of holding up every download after it until a restart. ffmpeg
  getting stuck on a song is stopped too (after 30 minutes), and the song still plays.
- **Downloads pause before the disk fills up**: with under 2 GB free, songs show "Disk full" in the queue and
  Activity says so. They carry on by themselves once there's room.
- **Missing tools are named when Couchwave starts**: if yt-dlp, ffmpeg or ffprobe can't be found (or Node.js
  is too old), Activity and the log say so and point to the setup guide, instead of every song just failing.
- **"A newer Couchwave is out"** in Activity and the log when there's a new release (checked daily on
  GitHub; nothing is installed or sent about you). `"updateCheck": false` in config.json turns it off.
- **The log notes lockouts**: when someone's had 20 wrong passwords, for an address or a nickname.
- **A warning in the log if friends reach Couchwave over plain http from the internet** (a port opened on
  the router), since passwords then travel unencrypted.
- **New nicknames are limited to 10 an hour from any one address**, so nobody can make endless accounts.
  The computer running Couchwave isn't limited.
- **Speed limits on pausing, moving through songs and reactions**, like the ones on chat and adding songs.
- **Over `https://`, browsers are told to always use it** for your Couchwave address.
- **`--set-password` asks for the new password** when you leave it off, hidden as you type, so it stays out
  of your command history.

### Changed

- **Logging out only logs out that device**: use your nickname on your phone and your computer at once, and
  logging out on one leaves the other logged in. Logging out now also really ends that login: before, a copy
  of it (say, on a shared computer) kept working.
- **Logins last a year from when they were last used**, instead of a year from logging in, so people who
  come back regularly never have to log in again. Everyone stays logged in through this update; anyone who
  doesn't come back within 30 days logs in once more.
- **Undo is just for your own songs**: removed one of your own songs by mistake? Put it back from Activity
  within 10 minutes, now even if Couchwave restarts in between (it's ready to play straight away, without
  downloading again). Songs voted out of the queue stay out: before, whoever cast the deciding vote could
  put them back, undoing everyone else's vote.
- **Lots of people logging in at once** no longer slows songs and the page down for everyone else: a few at
  a time are checked, and the rest are asked to try again in a moment.
- **Each person can have up to 10 pages getting instant updates at once.** Any more still work; they just
  check in every few seconds.
- **The join screen shows why a login was refused** when it's a limit, instead of always "Too many wrong
  tries".
- **Release zips are built automatically** when a release is published, after the tests pass, with
  `start.cmd` in the format Windows expects (the v0.2.0 zip's `start.cmd` wasn't).
- **Clearer install and update steps** for the release zip: unzip it into a new folder of its own, and stop
  Couchwave before unzipping an update over it.

### Fixed

- **The limit on wrong passwords could be dodged behind Caddy or nginx**, or by changing address on IPv6, so
  someone who knew the room password could keep guessing a nickname's password. Couchwave now works out
  who's visiting the way proxies actually report it.
- **Everyone locked out at once behind some proxies**: with a proxy in Docker, on another computer or over
  Tailscale, every visitor looked like the same one, so 20 wrong passwords from anyone stopped everyone
  logging in for 15 minutes. Those proxies now work like one on the same computer (logins through them are
  marked HTTPS-only too). Plain nginx needs one extra line: see
  [docs/INSTALL.md](docs/INSTALL.md#letting-friends-in).
- **Logging out on one device showed you leaving and joining again** on your other devices, with the sounds.
- **A damaged `data/state.json` emptied the queue, chat and history without a word**, and was then saved
  over. Now the log says so, and the old file is kept beside it as `state.json.broken-…`. A file with only
  some parts missing keeps the parts that are fine, instead of stopping Couchwave from starting.
- **A long nickname ending in an emoji** could be cut in the middle of the emoji, leaving a nickname that
  could never log in.

## v0.2.0 beta (2026-11-17)

Still a beta. Even volume, no duplicate songs, chat speed limits, security headers, a sturdier DJ, and a lot
of fixes. **Download `couchwave-v0.2.0-beta.zip`** from the release (not "Source code"): its files are at the
top of the zip, so it unzips straight into your Couchwave folder.

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
- **Under the hood** (nothing changes for anyone using it): tidier code grouped into sections, leftovers
  from before v0.1.0 removed, and steadier tests.

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
