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
  go in at all.
- **In sync** for everyone: the song and where it's up to are the same on every screen. Anyone can pause or
  resume for everyone with the pause button; the pause button in your phone's lock-screen controls (or on
  your headphones) pauses just you.
- **Votes**: skipping a song or removing someone else's is a vote ("1 out of 3 voted to skip"), counted
  among the people online; the lock screen's "next" button votes too. Your own songs go straight away. How
  many votes it takes is a setting.
- **Moving through a song**: while you're online, only you can move through your song, so nobody can skip
  it by jumping to the end. Once you've gone, anyone can. The DJ's songs can only be moved by someone who's
  the only one online.
- **Undo**: a removed song can be put back from the Activity log for 10 minutes, by whoever removed it.
- **Failed downloads** show why in the queue, with a retry button. YouTube's hiccups are retried by themselves.
- **History** of the last 100 songs played, with thumbnails, who asked and when, a copy link and a + to
  queue a song again.
- **A DJ** that keeps the music going with songs like the ones you've played (see
  [below](#chat-commands-and-the-dj)).

**Together**

- **Chat and emoji reactions** that float over the video, all instant. Chatting and adding songs have a
  speed limit, so nobody can flood the room.
- **Who's online** (anyone with the page open, even in a background tab), and an **Activity log** of who
  added, removed or skipped songs, paused, and joined or left, with a sound for comings and goings (its own
  volume and mute).
- **Profile pictures**: an emoji and a colour of your choice.
- **Your own nickname** with its own password, so nobody can join as you.

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
- **Keeps yt-dlp up to date** by itself, since YouTube changes often.
- **Locked down**: browsers only run Couchwave's own scripts (so even a bug letting code into a chat message
  couldn't run it), other sites can't show it inside theirs, and YouTube isn't told your room's address.

## Server commands

Run these in the Couchwave folder. They work while Couchwave is running (it notices straight away) or not.

| Command | What it does |
|---|---|
| `node server.js` | Starts Couchwave. On Windows, `start.cmd` does this, and restarts it when you save `config.json`. |
| `node server.js --logout-everyone` | Everyone has to log in again. Accounts and passwords are kept. |
| `node server.js --set-password <name> <password>` | For a forgotten password (4+ characters). Logs them out everywhere; send them the new one. |
| `node server.js --delete-account <name>` | Deletes an account and logs it out. Whoever takes the nickname next starts fresh. |

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

- **Picks** from YouTube's Mix of songs people asked for or played, preferring other artists. It never
  starts from its own picks, even after they've played. It only picks songs between 1 and 20 minutes long,
  and skips repeats, albums and mixes.
- **Queues its songs after everyone else's**, as "DJ" 🎧. Skipping or removing them is a vote, like any song.
- **Only plays music**: YouTube has no Mix for other videos (music Shorts work, other Shorts don't). With
  nothing to go on, or only other videos, it says so once in the chat and waits for a song.
- **Is off until someone turns it on**, and stays on or off across restarts.

## For developers

| Where | What's there |
|---|---|
| `server.js` | The server: accounts, the queue, downloads, votes, playback and everything pages ask for. |
| `dj.js` | The DJ. It only uses what `server.js` hands it. |
| `public/` | What browsers load: `index.html`, `css/style.css`, `js/theme.js` and `js/app.js`, `fonts/` and `icons/`. |
| `tests/` | The tests, with stand-ins for yt-dlp, ffmpeg and ffprobe in `tests/fakes/`. |

Comments in the code are only short section headers; how things should behave is described in these docs.
The page's security policy blocks inline scripts, including `onclick="…"`: give an element
`data-click="name"` (or `data-submit`, `data-dblclick`, `data-enter`) and add `name` to `ACTIONS` in `app.js`.

After changing the code, run `node --test` (about 10 seconds). Each test runs against its own throwaway
Couchwave (temporary folder, password and port), so your real server and data are never touched, even while
it's running. The stand-ins mean it needs no internet. The test servers run their clock 4x faster
(`COUCHWAVE_TIME_SCALE`), so waiting for someone to count as "left" takes 2.5 seconds, not 10.
