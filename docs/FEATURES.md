# Features and commands

- [Features](#features)
- [Server commands](#server-commands)
- [Chat commands and the DJ](#chat-commands-and-the-dj)
- [For developers](#for-developers)

## Features

**Watching together**

- **Shared queue**: paste YouTube links (share links and Shorts too) or playlists, or just type a song name
  (the best match of YouTube's top results goes in). People take turns, so one person's big playlist
  doesn't keep everyone else waiting. A playlist link asks whether to add the whole playlist (up to 100
  songs) or just the one song. A song already queued or playing can't go in twice, and livestreams can't
  go in at all. The queue holds up to 500 songs, and YouTube is read for at most 3 searches or playlists
  at a time (the rest wait their turn).
- **In sync** for everyone: the song and where it's up to are the same on every screen. Anyone can pause or
  resume for everyone with the pause button, or by clicking the video (double-clicking goes full screen).
  While it's paused, the video says who paused it. The pause button in your phone's lock-screen controls (or
  on your headphones) pauses just you.
- **Votes**: skipping a song or removing someone else's is a vote ("1 out of 3 voted to skip"), counted
  among the people online; the lock screen's "next" button votes too. Your own songs go straight away. How
  many votes it takes is a setting.
- **Moving through a song**: while you're online, only you can move through your song, so nobody can skip
  it by jumping to the end. Once you've gone, anyone can. The DJ's songs can only be moved by someone who's
  the only one online.
- **Undo**: removed one of your own songs by mistake? Put it back from the Activity log within 10 minutes
  (even if Couchwave restarts in between). Songs voted out of the queue stay out.
- **Failed downloads** show why in the queue (unavailable, private, age-restricted, members only…), with a
  retry button. YouTube's hiccups, and downloads that stop getting anywhere, are retried by themselves. When
  YouTube's bot check or rate limit comes up, downloads pause for everyone, then go one song at a time until
  one works; the queue shows when each song tries again.
- **History** of the last 100 songs played, with thumbnails, who asked and when, a copy link and a + to
  queue a song again.
- **A DJ** that keeps the music going with songs like the ones you've played (see
  [below](#chat-commands-and-the-dj)).

**Together**

- **Chat and emoji reactions** that float over the video, all instant. Chatting, adding songs, pausing,
  voting, reactions and changing your look have a speed limit, so nobody can flood the room.
- **GIFs in the chat**, searched from [KLIPY](https://klipy.com), with trending ones first, once you add your
  own free KLIPY key (see [GIFs in the chat](INSTALL.md#gifs-in-the-chat)).
- **Who's online** (anyone with the page open, even in a background tab), and an **Activity log** of who
  added, removed or skipped songs, paused, and joined or left, with a sound for comings and goings (its own
  volume and mute). Activity is a tab beside the chat (the page remembers which you had), newest at the
  bottom; a dot on the Chat tab shows a new message.
- **Profile pictures**: an emoji and a colour of your choice. It shows all over the page as you choose, and
  everyone else sees it once you click off the picker.
- **Your own nickname** with its own password, so nobody can join as you. Use it on as many devices as you
  like, at the same time; logging out only logs out that one. A login lasts a year from when you last used
  it, and wrong passwords are limited (for each visitor and each nickname), so nobody can sit there guessing.

**Watching**

- **Even volume**: each song's loudness is measured when it downloads, and loud ones are turned down to
  match the rest, so you're not reaching for the volume between songs.
- **Full screen like Twitch**: the video edge to edge, with the chat alongside (or hidden).
- **Works on phones**: keeps playing when the screen locks, installs as an app, and has an audio-only mode
  to save data. **Known issue:** playing on with the phone locked or the browser minimised is buggy at the
  moment: the song playing carries on, but the next one doesn't always start. We're looking into it.
- **Light and dark** themes.

**Hosting**

- **Runs on your own computer** with just Node.js, yt-dlp and ffmpeg: no database, no npm packages, no
  account anywhere.
- **Gentle on your connection**: videos are sent at a steady pace, so the chat doesn't stall, and only the
  songs near the top of the queue are downloaded ahead. The page and its updates are compressed, browsers
  reuse what they already have, and a phone in your pocket gets just the sound, not the video.
- **Limits you choose**: the longest video allowed, how many songs download ahead and at once (see
  [settings](INSTALL.md#settings)).
- **Keeps yt-dlp up to date** by itself, since YouTube changes often (and says so if it can't), and says in
  Activity when there's a new Couchwave (see `updateCheck` in the [settings](INSTALL.md#settings)). If
  YouTube keeps asking it to sign in, it can use a signed-in account (see `youtubeCookies`).
- **Looks after itself**: a download or ffmpeg that gets stuck is stopped and tried again, downloads pause
  before the disk fills up, a missing yt-dlp or ffmpeg is named in Activity when Couchwave starts, a damaged
  save file is kept aside instead of stopping Couchwave, its log file trims itself, and it backs itself up
  every day (the last 7 days, in `data/backups/`). `/health` tells an uptime monitor whether it's well.
- **Easy to get going**: the first start says where to open Couchwave, the address for friends at home and
  the room password, and the join screen, opened on the computer running it, shows the address to share.
- **Locked down**: browsers only run Couchwave's own scripts (so even a bug letting code into a chat message
  couldn't run it), other sites can't show it inside theirs or act as someone who's logged in, and YouTube
  isn't told your room's address. Over `https://`, browsers are told to always use it; if friends reach it
  over plain http from the internet, the log warns you. Wrong passwords and new nicknames are limited.

## Server commands

Run these in the Couchwave folder. They work while Couchwave is running (it notices straight away) or not.

| Command | What it does |
|---|---|
| `node server.js` | Starts Couchwave. On Windows, `start.cmd` does this, and restarts it when you save `config.json`. |
| `node server.js --stop` | Saves everything and stops Couchwave, and on Windows keeps `start.cmd` (or the startup task) from starting it again; `stop.cmd` does the same with a double-click. For the Linux service, use `sudo systemctl stop couchwave`. |
| `node server.js --logout-everyone` | Everyone has to log in again. Accounts and passwords are kept. |
| `node server.js --set-password <name>` | For a forgotten password: asks for the new one (4+ characters, hidden as you type, and kept out of your command history). Logs them out everywhere; send them the new one. You can also put the password after the name. |
| `node server.js --delete-account <name>` | Deletes an account and logs it out. Whoever takes the nickname next starts fresh. |
| `node server.js --remove-song <song>` | Takes a song out of the queue straight away, with no vote (and no Undo): give its number in the queue, its YouTube link, or part of its name. It shows the song and asks before removing it. On its own, it lists the queue with the numbers. |
| `node server.js --clear <what>` | Clears the `chat`, the `activity` log or the played `history` (one or more, like `--clear chat activity`), or `all` of them, for everyone, straight away. It asks first, since it can't be undone, and Activity notes that it was cleared. On its own, it says how much there is of each. |
| `node server.js --status` | How Couchwave is doing: whether it's running, who's online, what's playing, the queue, the DJ, the free disk space, the versions of yt-dlp, ffmpeg and Node.js, and whether there's a newer Couchwave. |
| `node server.js --update` | Updates to the newest release: checks the download's checksum, tries the new version out first, keeps the old one in `data/update/previous`, restarts Couchwave, and goes back if the new version doesn't start. On Windows `update.cmd` does the same with a double-click. Not in a git copy (use `git pull`) or Docker. See [Updating](INSTALL.md#updating). |
| `node server.js --version` | Shows which version of Couchwave this is. |

Nicknames ignore capitals and extra spaces (`lvj` is `LVJ`). Changing the room password in `config.json`
also logs everyone out.

## Chat commands and the DJ

Anyone can type these in the chat (they aren't posted as messages):

| Command | What it does |
|---|---|
| `!dj on` | Turns the DJ on: it keeps up to 10 songs queued, like the ones people have asked for. |
| `!dj off` | Turns it off. What it already queued stays (people can vote it out). |
| `!dj` | Says whether the DJ is on. |

The DJ:

- **Picks** from YouTube's Mix of songs people asked for, once they've played (the played history, not
  songs still waiting in the queue), preferring other artists. It only goes on songs between 1 and 20
  minutes long, and only picks songs that long. It skips repeats, and anything it added in the last hour
  (so a song that couldn't download, or was voted out, doesn't come straight back). It never goes on its own
  picks unless someone likes them (below).
- **Learns from 👍**: its songs in the played history (including the one playing now) have a thumbs-up
  button. Once someone likes one, the DJ finds more like it too ("a liked song" in Activity). Click it again
  to take the like back. Likes are private: you see only your own, and only the DJ uses them.
- **Fills up gently**: its first songs come straight away, then it asks YouTube for one more Mix every 10
  seconds until it has 10 queued, so it doesn't rush YouTube.
- **Queues its songs after everyone else's**, as "DJ" 🎧. Skipping or removing them is a vote, like any song.
  If one of its songs can't be downloaded, it drops it (Activity says why) and picks another.
- **Only plays music**: YouTube has no Mix for other videos (music Shorts work, other Shorts don't). With
  nothing to go on, or only other videos, it says so once in the chat and waits for a song.
- **Is off until someone turns it on**, and stays on or off across restarts.

## For developers

| Where | What's there |
|---|---|
| `server.js` | Where it starts: the version, then either one of the commands above or the server. |
| `lib/start.js` | Starts the server, in order: settings, the saved room, the DJ, upkeep, then the web server. |
| `lib/room.js` | Everything the room has (the queue, what's playing, history, chat, Activity, votes, who's here), loading and saving it, and telling pages something changed. |
| `lib/songs.js` | Adding songs (links, playlists, searches), where they go in the queue, removing them, and votes to remove. |
| `lib/downloads.js` | Reading YouTube with yt-dlp, downloading, loudness, retries, and the disk space check. |
| `lib/playback.js` | Playing the next song, votes to skip, and what happens every second. |
| `lib/presence.js` | Who's here, joining and leaving. |
| `lib/routes.js` | Everything pages ask for, logging in, and the web server. |
| `lib/web.js` | Sending the page and songs (paced to playing speed), JSON, and the security headers. |
| `lib/accounts.js`, `lib/logins.js` | Nicknames and their passwords, and the login cookies on each device. |
| `lib/addresses.js`, `lib/limits.js` | Visitors' addresses behind proxies, and the limits on guessing and going too fast. |
| `lib/settings.js`, `lib/log.js` | `config.json`, and `data/server.log`. |
| `lib/admin.js`, `lib/commands.js` | The commands above, and how the server answers them while it runs. |
| `lib/upkeep.js` | Checking the tools, keeping yt-dlp up to date, the new-version check and daily backups. |
| `lib/update.js` | `--update`: the download, its checksum, the trial run, putting files in place, and going back. |
| `lib/common.js`, `lib/tools.js` | Shared basics (folders, saving files safely, times, YouTube links), and running yt-dlp, ffmpeg and ffprobe. |
| `lib/dj.js` | The DJ. It only uses what `lib/start.js` hands it. |
| `public/` | What browsers load: `index.html`, `css/style.css`, the scripts in `js/`, `fonts/` and `icons/`. |
| `public/js/core.js` | The page's shared basics: helpers, names and profile pictures. |
| `public/js/profile.js` | Joining, logging out, your colour and emoji, and the theme. |
| `public/js/player.js` | Playing in sync, the controls, voting to skip, full screen, reactions and the lock screen. |
| `public/js/chat.js`, `public/js/lists.js` | Chat, emoji, GIFs and sounds; adding songs, the queue, Activity and the history. |
| `public/js/app.js` | Updates from the server, the buttons, and starting it all (it loads last). |
| `Dockerfile`, `docker-entrypoint.sh` | The Docker image: Node.js, ffmpeg and yt-dlp, settings in `data/` (`COUCHWAVE_CONFIG`), running as the `node` user. `.github/workflows/docker.yml` tries it on every change and publishes it with each release. |
| `tests/` | The tests, with stand-ins for yt-dlp, ffmpeg and ffprobe in `tests/fakes/`, and a headless browser for the page (`tests/browser.js`). |

Comments in the code are only short section headers; how things should behave is described in these docs.
Files in `lib/` can need each other, so each adds what it shares to `exports` at the end
(`Object.assign(exports, …)`) and reaches into the others when it runs (`room.queue`, `downloads.pump()`),
never by copying them when it loads. The room's state lives on `room`, so every file sees the same queue.
The page's security policy blocks inline scripts, including `onclick="…"`: give an element
`data-click="name"` (or `data-submit`, `data-dblclick`, `data-enter`) and add `name` to `ACTIONS` in `app.js`.
The page's scripts share one scope and load in order (`core.js` first, `app.js` last, which starts the page):
while loading, a script can only use what earlier ones made.

After changing the code, run `node --test` (about 30 seconds). Each test gets its own throwaway Couchwave
(temporary folder, password and port) with stand-ins for yt-dlp, ffmpeg and ffprobe, so it needs no internet
and never touches your real server or data, even while it runs. The page is tested in a headless Chrome or
Edge (`tests/page-browser.test.js`), found by itself (or set `COUCHWAVE_BROWSER`); without one, those tests are
skipped. Test servers run their clock 4x faster (`COUCHWAVE_TIME_SCALE`); the other `COUCHWAVE_…` variables in
`tests/helpers.js` and `lib/` are only for the tests too. Every push to `main` runs the tests on Linux and
Windows (`.github/workflows/tests.yml`); changes to the one-line installers also try them on fresh machines
(`install.yml`), and changes to the server or Docker files build and try the image (`docker.yml`).

Releasing: set `VERSION` near the top of `server.js` (the "a newer Couchwave is out" check compares it), then
publish a GitHub release: `release-zip.yml` runs the tests and attaches `couchwave-<tag>.zip`, `install.yml`
tries the installers, and `docker.yml` publishes the image.
