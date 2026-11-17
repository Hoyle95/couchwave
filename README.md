<p align="center"><img src="public/icons/icon.svg" alt="Couchwave logo: a couch whose back is a sound wave" width="96"></p>

<h1 align="center">Couchwave</h1>

<p align="center"><b>Watch YouTube together with your friends, from your own computer.</b></p>

Couchwave is a watch party you host yourself. Paste a YouTube link or just type what you want to hear, and
it joins a shared queue where everyone takes turns. Videos play in sync on every screen, with chat, emoji
reactions and votes to skip, on a laptop or a phone. A DJ keeps the music going when the queue runs dry,
and every song plays at an even volume.

Set it up once and leave it: Couchwave keeps yt-dlp up to date, retries stuck downloads, won't fill your
disk, and tells you when there's a new version. Everyone has their own nickname and password, and password
guessing is shut down. All it needs is Node.js, yt-dlp and ffmpeg: no database, no npm packages.

![Couchwave in a browser: a video playing with emoji reactions floating over it, a skip vote in progress, the chat and online friends on the right, and below them the activity log, the history of songs played with thumbnails, and the queue](docs/screenshot.png)

<p align="center">
  <b><a href="docs/INSTALL.md">Getting started and setup guide</a></b>
  &nbsp;·&nbsp;
  <b><a href="docs/FEATURES.md">Full feature list and commands</a></b>
  &nbsp;·&nbsp;
  <b><a href="CHANGELOG.md">What's new</a></b>
</p>

## Install in one line

**Windows** (in PowerShell):

```powershell
irm https://raw.githubusercontent.com/Hoyle95/couchwave/main/install.ps1 | iex
```

**Linux** (Debian, Ubuntu, Raspberry Pi OS):

```sh
curl -fsSL https://raw.githubusercontent.com/Hoyle95/couchwave/main/install.sh | bash
```

It installs what Couchwave needs, makes it start with the computer, starts it, and shows you its address and
room password. Run it again to update. More in the [setup guide](docs/INSTALL.md#one-line-install).

## Feedback

Ideas, bugs, or just saying hi: join our [Discord](https://discord.com/invite/pNtyzNkch6) or [open an issue](https://github.com/Hoyle95/couchwave/issues).

## Credits

- Designed by [Matt Hoyle](https://matthoyle.me/) using Claude Opus 5.5.
- The screenshots show [Big Buck Bunny](https://peach.blender.org/) and other
  [Blender open movies](https://studio.blender.org/films/), © Blender Foundation, under the
  Creative Commons Attribution licence (CC BY).
- The font is [Inter](https://rsms.me/inter/) (SIL Open Font License, see `public/fonts/OFL.txt`), included so the
  site never loads anything from Google.

## Licence

The code is open source under the [Apache License 2.0](LICENSE), copyright 2026
[Hoyle95](https://github.com/Hoyle95). **The name "Couchwave" and its logo aren't covered**: if you share
your own version, please give it a different name and logo ("based on Couchwave" is fine).
