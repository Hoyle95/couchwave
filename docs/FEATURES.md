# Features and commands

- [Features](#features)
- [Server commands](#server-commands)
- [Chat commands and the DJ](#chat-commands-and-the-dj)
- [About the tests](#about-the-tests)

## Features

**Watching together**

- **Shared queue**: paste YouTube links or playlists, or just type a song name. People take turns, so one
  person's big playlist doesn't keep everyone else waiting.
- **In sync** for everyone: play, pause and the current song are the same on every screen.
- **Votes**: skipping a song or removing someone else's is a vote ("1 out of 3 voted to skip"). Your own
  songs go straight away, and only you can move through your song. How many votes it takes is a setting.
- **History** of the last 100 songs played, with thumbnails, who asked and when, a copy link and a + to
  queue a song again.
- **A DJ** that keeps the music going with songs like the ones you've played (see
  [below](#chat-commands-and-the-dj)).

**Together**

- **Chat and emoji reactions** that float over the video, all instant.
- **Who's online**, and who joined or left in the Activity log, with a sound (its own volume and mute).
- **Profile pictures**: an emoji and a colour of your choice.
- **Your own nickname** with its own password, so nobody can join as you.

**Watching**

- **Full screen like Twitch**: the video edge to edge, with the chat alongside (or hidden).
- **Works on phones**: keeps playing when the screen locks, installs as an app, and has an audio-only mode
  to save data.
- **Light and dark** themes.

**Hosting**

- **Runs on your own computer** with just Node.js, yt-dlp and ffmpeg: no database, no npm packages, no
  account anywhere.
- **Gentle on your connection**: videos are sent at a steady pace, so the chat doesn't stall, and only the
  next few songs are downloaded ahead.
- **Limits you choose**: the longest video allowed, how many songs download ahead and at once (see
  [settings](INSTALL.md#settings)).
- **Keeps yt-dlp up to date** by itself, since YouTube changes often.

## Server commands

Run these in the Couchwave folder. They work while Couchwave is running (it notices straight away) or not.

| Command | What it does |
|---|---|
| `node server.js` | Starts Couchwave. On Windows, `start.cmd` does this, and restarts it when you save `config.json`. |
| `node server.js --logout-everyone` | Everyone has to log in again. Accounts and passwords are kept. |
| `node server.js --set-password <name> <password>` | For a forgotten password (4+ characters). Logs them out everywhere; send them the new one. |
| `node server.js --delete-account <name>` | Deletes an account and logs it out. Whoever takes the nickname next starts fresh. |
| `node --test` | After changing the code: checks nothing broke (under 10 seconds). |

Nicknames ignore capitals and extra spaces (`lvj` is `LVJ`). Changing the room password in `config.json`
also logs everyone out.

## Chat commands and the DJ

Anyone can type these in the chat (they aren't posted as messages):

| Command | What it does |
|---|---|
| `!dj on` | Turns the DJ on: it keeps up to 10 songs queued, like the ones people have asked for. |
| `!dj off` | Turns it off. What it already queued stays (people can vote it out). |
| `!dj` | Says whether the DJ is on. |

The DJ picks from YouTube's Mix of songs people requested or played (never its own picks), prefers other
artists, and skips repeats, albums and hour-long mixes. Its songs go after everyone else's, as "DJ" 🎧; skipping
or removing them is a vote, like any song. With nothing to go on, it asks in the chat for a song. It's off
until someone turns it on, and stays on or off across restarts. It only plays music: YouTube has no Mix for
other videos. It lives in `dj.js`.

## About the tests

`node --test` runs each test against its own throwaway Couchwave (temporary folder, password and port), so
your real server and data are never touched, even while it's running. Instead of yt-dlp and ffmpeg it uses
stand-ins in `tests/fakes/`, so it needs no internet. The test servers run their clock 4x faster
(`COUCHWAVE_TIME_SCALE`), so waiting for someone to count as "left" takes 2.5 seconds, not 10.
