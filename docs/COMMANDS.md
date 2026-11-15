# Commands

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

## Chat commands

Anyone can type these in the chat (they aren't posted as messages):

| Command | What it does |
|---|---|
| `!dj on` | Turns the DJ on: it keeps up to 10 songs queued, like the ones people have asked for. |
| `!dj off` | Turns it off. What it already queued stays (people can vote it out). |
| `!dj` | Says whether the DJ is on. |

The DJ picks from YouTube's Mix of songs people requested or played (never its own picks), prefers other
artists, and skips repeats, albums and hour-long mixes. Its songs go after everyone else's, as "DJ" 🎧; skipping
or removing them is a vote, like any song. With nothing to go on, it asks in the chat for a song. It's off
until someone turns it on, and stays on or off across restarts. It lives in `dj.js`.

## About the tests

`node --test` runs each test against its own throwaway Couchwave (temporary folder, password and port), so
your real server and data are never touched, even while it's running. Instead of yt-dlp and ffmpeg it uses
stand-ins in `tests/fakes/`, so it needs no internet. The test servers run their clock 4x faster
(`COUCHWAVE_TIME_SCALE`), so waiting for someone to count as "left" takes 2.5 seconds, not 10.
