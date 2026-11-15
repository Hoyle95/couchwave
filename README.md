<p align="center"><img src="icons/icon.svg" alt="Couchwave logo: a couch whose back is a sound wave" width="96"></p>

<h1 align="center">Couchwave</h1>

<p align="center"><b>Watch YouTube together with your friends, from your own computer.</b></p>

Everyone opens the same page, pastes YouTube links (or just types a song name) into a shared queue, and
the videos play in sync for everybody, with chat and emoji reactions on the side. It's like sitting on
the same couch, wherever you are. You host it yourself, it's password-protected, and it needs nothing
but Node.js, yt-dlp and ffmpeg. No accounts, no database, no npm packages.

![Couchwave in a browser: a video playing with emoji reactions floating over it, the chat and online friends on the right, the activity log and queue below](docs/screenshot.png)

<details>
<summary>On a phone</summary>

<img src="docs/screenshot-phone.png" alt="Couchwave on a phone" width="320">

</details>

## What it does

- **Shared queue**: paste a link, a playlist, or a song name. People take turns: one person's 100-song
  playlist doesn't drown out everyone else. Drag to reorder, delete (with undo), copy links.
- **In sync**: play, pause, seek and skip for everyone. Your own volume stays yours.
- **Chat, reactions and who's online**, with emoji profile pictures and colours.
- **Keeps playing on a locked phone**, and can be installed as an app ("Add to Home screen").
- **Remembers everything** across restarts: the queue, what was playing and where, the chat and the activity log.

Songs are downloaded to your computer with [yt-dlp](https://github.com/yt-dlp/yt-dlp) a few at a time
ahead of when they play, and deleted after they've played.

## Setup

You need **Node.js 18 or newer**, **yt-dlp** and **ffmpeg**.

### Windows

1. Install the tools. Open PowerShell and run:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install yt-dlp.yt-dlp
   ```

   (The yt-dlp package brings ffmpeg with it.) Close and reopen PowerShell afterwards.

2. Get Couchwave: download it from GitHub (**Code → Download ZIP**, then unzip it), or
   `git clone https://github.com/Hoyle95/couchwave.git`.

3. Double-click **`start.cmd`** in the Couchwave folder and keep the window open.

4. Open <http://localhost:3000>. The password is in **`config.json`**, which is created the first time
   it runs. Change the password or the port there; the server restarts by itself when you save.

### Linux (Debian, Ubuntu, Raspberry Pi OS)

1. Install the tools:

   ```sh
   sudo apt update
   sudo apt install -y nodejs ffmpeg python3 git curl
   node --version    # needs v18 or newer
   mkdir -p ~/.local/bin
   curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp
   chmod +x ~/.local/bin/yt-dlp
   export PATH="$HOME/.local/bin:$PATH"
   ```

   yt-dlp is installed from its own release rather than `apt` so that Couchwave can keep it up to date
   (YouTube changes often, and old versions stop working). If `node --version` is older than 18, install a
   newer Node from [nodejs.org](https://nodejs.org/en/download). On other distros, install the same
   things with your package manager.

2. Get Couchwave and start it:

   ```sh
   git clone https://github.com/Hoyle95/couchwave.git
   cd couchwave
   node server.js
   ```

3. Open <http://localhost:3000> (or `http://<this machine's IP>:3000` from another device). The password
   is printed on the first run and saved in **`config.json`**. Change the password or the port there and restart.

## Keep it running

### Windows: start with the PC

Open PowerShell **as administrator** in the Couchwave folder and run:

```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c start.cmd' -WorkingDirectory "$PWD"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName Couchwave -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U) -Settings $settings -Force
```

It then starts at boot (no need to log in) and restarts itself if it ever crashes. Stop or start it with
`Stop-ScheduledTask Couchwave` / `Start-ScheduledTask Couchwave`. If you move the Couchwave folder, run
the same commands again from its new place.

### Linux: run as a service

From the Couchwave folder:

```sh
sudo tee /etc/systemd/system/couchwave.service > /dev/null <<EOF
[Unit]
Description=Couchwave
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$PWD
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env node server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now couchwave
```

Restart it after changing `config.json` or updating: `sudo systemctl restart couchwave`.

## Letting friends in

On your home network, friends open `http://<this machine's IP>:3000` (or the port you set in
`config.json`).

To host it publicly, we recommend either:

- **[Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/)**: free, gives you an `https://`
  address, and needs no ports opened on your router.
- **[Caddy](https://caddyserver.com/docs/quick-starts/reverse-proxy)**: a web server that gets an
  `https://` certificate for your domain automatically. This Caddyfile is all it needs:

  ```
  couch.example.com {
      reverse_proxy localhost:3000
  }
  ```

Either way, use `https://`: the password is sent with every request, and phones only offer "Install app"
on secure sites.

## Settings, data and backups

- **`config.json`**: the password and port (3000 unless you change it). Made on the first run. Not in git.
- **`data/`**: everything Couchwave saves: the queue, chat, activity log and profile pictures
  (`state.json`), the downloaded songs, and the logs. Not in git.

**To back up, copy the `data/` folder.** To restore, stop Couchwave and put it back.

**To update**, download the new version (or `git pull`) over the old one. `config.json` and `data/` are
kept. On Windows it restarts by itself; on Linux, restart the service.

## Troubleshooting

- **Songs fail with "Blocked by YouTube" or "bot check"**: yt-dlp updates itself once a day, but YouTube
  sometimes changes faster. Run `yt-dlp -U` and press the retry button on the song.
- **Won't start**: look at `data/server.log` and `data/server-console.log`. A broken `config.json` is the
  usual cause; the log says what's wrong.

## Licence

Copyright 2026 Hoyle95. The code is open source under the [Apache License 2.0](LICENSE): you can use,
change and share it, including in your own projects.

**The name and logo are not included.** "Couchwave" and the couch-and-wave logo (in `icons/` and in
the page itself) are not covered by the licence. If you share your own version, please give it a
different name and logo. Saying it's "based on Couchwave" is fine.

---

Only queue videos you're allowed to watch and share. Screenshot shows
[Big Buck Bunny](https://peach.blender.org/) © Blender Foundation, CC BY 3.0. The font is [Inter](https://rsms.me/inter/)
(SIL Open Font License, see `fonts/OFL.txt`), included so the site never loads anything from Google.
