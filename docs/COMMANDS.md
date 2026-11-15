# Server commands

Run these in the Couchwave folder. The account and login commands work whether Couchwave is running or
not: a running server notices the change straight away.

| Command | What it does |
|---|---|
| `node server.js` | Starts Couchwave (on Windows, `start.cmd` does this for you). |
| `node server.js --logout-everyone` | Everyone has to log in again. |
| `node server.js --delete-account <name>` | Deletes an account nobody wants any more. |
| `node server.js --set-password <name> <new password>` | Gives an account a new password, e.g. a forgotten one. |
| `node --test` | Checks nothing is broken, after changing the code. |

## Starting Couchwave

```sh
node server.js
```

On Windows, double-click `start.cmd` instead: it also restarts Couchwave by itself when you save
`config.json` or update it. To start it with the computer, see [Keep it running](INSTALL.md#keep-it-running).

## Log everyone out

```sh
node server.js --logout-everyone
```

Everyone's browser is logged out and has to join again (room password, nickname and its password).
Accounts and passwords are kept. Changing the room password in `config.json` does the same.

## Delete an account

```sh
node server.js --delete-account LVJ
```

For an account nobody wants any more. It's logged out everywhere straight away, and the nickname is free:
whoever joins with it next chooses its password and starts fresh, with their own profile picture. The old
account's chat messages and activity stay, as history, and songs it queued stay in the queue.

Nicknames ignore capitals and extra spaces, so `lvj` works too. If there's no such account, it lists the
ones there are.

## Set a new password

```sh
node server.js --set-password LVJ new-password-here
```

For a forgotten password (at least 4 characters). The account is logged out everywhere, and only the new
password works from now on: send it to them. Everything else about the account (picture, songs) is kept,
and nobody else can take the nickname in the meantime.

The new password ends up in your terminal's history; that's fine for a temporary one they'll be told.

## Chat commands

Anyone in the room can type these in the chat (they aren't posted as messages):

| Command | What it does |
|---|---|
| `!dj on` | Turns the DJ on: it keeps up to 10 songs queued, like what people have been asking for (from YouTube's Mix of songs people requested or played, other artists first; never from its own picks). With nothing to go on, it asks in the chat for a song. Its songs always go after everyone else's, and removing or skipping them is a vote, like any song. |
| `!dj off` | Turns it off: it stops adding songs. What it already queued stays, until someone deletes it. |
| `!dj` | Says whether the DJ is on. |

The DJ is off until someone turns it on, and stays on or off when Couchwave restarts. Its songs show as
"DJ" 🎧, a nickname nobody can take. It lives in `dj.js`.

## Run the tests

```sh
node --test
```

After changing the code, this checks nothing broke. It takes about 25 seconds and needs nothing
installed. Each test starts its own throwaway Couchwave in a temporary folder, with its own password and
port, so your real server, accounts, songs and chat are never touched (it can run while Couchwave is
running). Instead of yt-dlp and ffmpeg it uses stand-ins in `tests/fakes/` that act like them in a split
second, without YouTube, including failures, livestreams and playlists.

The tests cover joining and accounts (nicknames, passwords, the admin commands above), adding songs
(links, searches, playlists), downloads failing and retrying, deleting with undo, the fair queue,
pause/seek/skip, voting to skip, who's online and joined/left, chat and instant updates, the video files
and their pacing, and that the page's scripts have no syntax errors.
