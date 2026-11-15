<p align="center"><img src="icons/icon.svg" alt="Couchwave logo: a couch whose back is a sound wave" width="96"></p>

<h1 align="center">Couchwave</h1>

<p align="center"><b>Watch YouTube together with your friends, from your own computer.</b></p>

Everyone opens the same page, adds YouTube links or song names to a shared queue, and the videos play in
sync for everybody, with chat and reactions on the side. You host it yourself; it needs only Node.js,
yt-dlp and ffmpeg (no database, no npm packages).

![Couchwave in a browser: a video playing with emoji reactions floating over it, a skip vote in progress, the chat and online friends on the right, and below them the activity log, the history of songs played with thumbnails, and the queue](docs/screenshot.png)

<details>
<summary>On a phone</summary>

<img src="docs/screenshot-phone.png" alt="Couchwave on a phone" width="320">

</details>

## What it does

- **Shared queue**: links, playlists or song names. People take turns, so one big playlist doesn't hog it.
- **In sync** for everyone, with **votes** to skip or remove a song (your own go straight away).
- **Chat, reactions and who's online**, all instant, with emoji profile pictures.
- **A DJ** (`!dj on` in the chat) that keeps the music going with songs like the ones you've played.
- **History** of the last 100 songs played, and a **Twitch-style full screen** with the chat alongside.
- **Your own nickname** with its own password, so nobody can join as you.
- **Works on phones**: keeps playing when locked, installs as an app, and has an audio-only mode.

## Getting started

1. Install it and start it: **[docs/INSTALL.md](docs/INSTALL.md)** (Windows and Linux).
2. Open <http://localhost:3000>. The room password is in `config.json`, made on the first run.
3. Send your friends the address and the room password. The first time they join, they pick a nickname
   and a password for it.

Admin commands (log everyone out, delete an account, reset a password) and chat commands are in
**[docs/COMMANDS.md](docs/COMMANDS.md)**.

## Your data

Everything Couchwave saves is in `data/`: the queue, chat and history, the accounts (passwords scrambled,
never stored as typed), the downloaded songs and the logs. **To back up, copy `data/`.** Settings (room
password and port) are in `config.json`.

## Troubleshooting

- **Songs fail with "Blocked by YouTube" or "bot check"**: run `yt-dlp -U`, then press the song's retry
  button. (Couchwave updates yt-dlp daily, but YouTube sometimes changes faster.)
- **Won't start**: the reason is in `data/server.log`. Usually it's a broken `config.json`.
- **"Logins are paused"**: `data/accounts.json` can't be read (e.g. a bad hand edit). The log says why.

## Feedback

Ideas, bugs, or just saying hi: join our [Discord](https://discord.com/invite/pNtyzNkch6) or
[open an issue](https://github.com/Hoyle95/couchwave/issues).

## Credits

Designed by [Matt Hoyle](https://matthoyle.me/) using Claude Opus 5.5. The screenshots show
[Big Buck Bunny](https://peach.blender.org/) and other [Blender open movies](https://studio.blender.org/films/), © Blender Foundation, CC BY. The font is
[Inter](https://rsms.me/inter/) (SIL Open Font License, `fonts/OFL.txt`), included so the site never loads
anything from Google.

## Licence

Copyright 2026 [Hoyle95](https://github.com/Hoyle95). The code is open source under the
[Apache License 2.0](LICENSE): use it, change it and share it, in your own projects too.

**The name and logo aren't included.** "Couchwave" and the couch-and-wave logo are not covered by the
licence: if you share your own version, please give it a different name and logo ("based on Couchwave"
is fine).
