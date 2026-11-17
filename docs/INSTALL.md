# Getting started and setup

You need **Node.js 18.11 or newer**, **yt-dlp** and **ffmpeg**.

- [Quick start](#quick-start)
- [Windows](#windows)
- [Linux (Debian, Ubuntu, Raspberry Pi OS)](#linux-debian-ubuntu-raspberry-pi-os)
- [Settings](#settings)
- [Your data](#your-data)
- [Keep it running](#keep-it-running)
- [Letting friends in](#letting-friends-in)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)

> [!NOTE]
> **We recommend downloading a release.** The [Releases page](https://github.com/Hoyle95/couchwave/releases)
> has tested versions. Cloning the repo or `git pull` gets the very latest code instead, which can include
> changes that haven't been fully tested yet. If you'd like to try the latest unreleased code anyway, we'd love
> to hear how it goes: tell us on [Discord](https://discord.com/invite/pNtyzNkch6) or
> [open an issue](https://github.com/Hoyle95/couchwave/issues).

## Quick start

1. Install it and start it: [Windows](#windows) or [Linux](#linux-debian-ubuntu-raspberry-pi-os).
2. Open <http://localhost:3000>. The room password is in `config.json`, made on the first run.
3. Send your friends the address and the room password (see [Letting friends in](#letting-friends-in)).
   The first time they join, they pick a nickname and a password for it.

<p align="center"><img src="screenshot-join.png" alt="The join screen: a profile picture and nickname with its own password under &quot;You&quot;, the room password below, and a Join the party button" width="450"></p>

## Windows

1. Install the tools. Open PowerShell and run:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install yt-dlp.yt-dlp
   ```

   (The yt-dlp package brings ffmpeg with it.) Close and reopen PowerShell afterwards.

2. Get Couchwave: on the [Releases page](https://github.com/Hoyle95/couchwave/releases), download
   **Source code (zip)** under **Assets** of the newest release, and unzip it where you want Couchwave to live.
   The zip holds one folder (like `couchwave-0.1.0-beta`): that's your Couchwave folder, and you can rename it.

3. Double-click **`start.cmd`** in the Couchwave folder and keep the window open.

4. Open <http://localhost:3000>. The room password is in **`config.json`**, which is created the first
   time it runs, along with the other [settings](#settings). The server restarts by itself when you save it.

## Linux (Debian, Ubuntu, Raspberry Pi OS)

1. Install the tools:

   ```sh
   sudo apt update
   sudo apt install -y nodejs ffmpeg python3 git curl
   node --version    # needs v18.11 or newer
   mkdir -p ~/.local/bin
   curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp
   chmod +x ~/.local/bin/yt-dlp
   export PATH="$HOME/.local/bin:$PATH"
   ```

   yt-dlp is installed from its own release rather than `apt` so that Couchwave can keep it up to date
   (YouTube changes often, and old versions stop working). If `node --version` is older than 18.11, install a
   newer Node from [nodejs.org](https://nodejs.org/en/download). On other distros, install the same
   things with your package manager.

2. Get Couchwave (the latest release) and start it:

   ```sh
   git clone https://github.com/Hoyle95/couchwave.git
   cd couchwave
   git checkout "$(git describe --tags --abbrev=0 origin/main)"   # the latest release, not untested code
   node server.js
   ```

   (Or download **Source code (zip)** from the newest release on the [Releases page](https://github.com/Hoyle95/couchwave/releases)
   and unzip it.)

3. Open <http://localhost:3000> (or `http://<this machine's IP>:3000` from another device). The room
   password is printed on the first run and saved in **`config.json`**, along with the other
   [settings](#settings). Restart Couchwave after changing them.

## Settings

Settings are in `config.json`, made on the first run. On Windows (`start.cmd`) Couchwave restarts by
itself when you save it; otherwise, restart it.

- `password`: the room password. Changing it logs everyone out.
- `port`: 3000 by default.
- `votePercent`: how many of the people online have to vote to skip a song or remove someone else's.
  60 by default, so 2 of 3 or 3 of 5.
- `maxVideoHours`: how long any one video can be, in hours (each is downloaded in full to your computer).
  3 by default; any number works, like `1.5` (an hour and a half) or `0.25` (15 minutes).
- `downloadAhead`: how many songs at the top of the queue are downloaded ahead of time, so they play
  without waiting. 20 by default. The rest download as they move up, so a long playlist doesn't fill the disk.
- `downloadsAtOnce`: how many of those download at the same time. 3 by default. Fewer is gentler on a
  slow connection.
- `public`: see below. Keep it `false`.

A setting missing from an older `config.json` uses its default.

> [!WARNING]
> **Keep `public` set to `false`.** With `"public": true` there's no room password: anyone who finds your
> address can join, chat, and add songs that **your computer then downloads**. Nicknames still have their
> own passwords, but strangers can simply make up new ones. We strongly recommend never turning it on,
> especially if Couchwave can be reached from the internet.

## Your data

Everything Couchwave saves is in `data/`: the queue, chat and history, the accounts (passwords scrambled,
never stored as typed), the downloaded songs and the logs. **To back up, copy `data/`** (and `config.json`).

## Keep it running

### Windows: start with the PC

Open PowerShell **as administrator** in the Couchwave folder and run:

```powershell
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c start.cmd' -WorkingDirectory "$PWD"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName Couchwave -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
  -Principal (New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U) -Settings $settings -Force
```

It then starts at boot (no need to log in) and restarts itself if it ever crashes. If you move the
Couchwave folder, run the same commands again from its new place.

To stop it: `Stop-ScheduledTask Couchwave`, then end the leftover **Node.js** process in Task Manager
(stopping the task alone can leave the server running). To start it again: `Start-ScheduledTask Couchwave`.

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
`config.json`). To find the IP, run `ipconfig` on Windows (the **IPv4 Address**, like `192.168.1.20`) or
`hostname -I` on Linux. The first time Couchwave runs, Windows asks whether Node.js may use the network:
allow it on **private networks**, or friends can't connect (see [Troubleshooting](#troubleshooting) if you
missed it).

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

Either way, use `https://`: the passwords and everyone's login are sent over it, and phones only offer
"Install app" on secure sites. Both tell Couchwave the visit came over `https://`, so it marks logins
HTTPS-only (never sent unencrypted). Another proxy has to run on the same machine and send
`X-Forwarded-Proto` (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`).

Then send your friends the address and the room password. The first time they join, they pick a nickname
and a password for it. To log someone out, reset a forgotten password or delete an account, see the
[server commands](FEATURES.md#server-commands).

## Updating

Your settings and everything people have done are kept: `config.json` and `data/` aren't part of the
download, so updating never touches them. To see what's changed first, read the
[changelog](../CHANGELOG.md).

**Recommended: the newest release.**

1. Download **Source code (zip)** from the newest release on the
   [Releases page](https://github.com/Hoyle95/couchwave/releases) and unzip it somewhere else (not into
   your Couchwave folder).
2. Open the folder inside it (like `couchwave-0.1.0-beta`) and copy everything in it into your Couchwave
   folder, replacing the old files. Your `config.json` and `data/` stay as they are.
3. Restart Couchwave. On Windows, `start.cmd` notices the new files and restarts by itself (if the page
   doesn't come back, stop and start it as in [Keep it running](#keep-it-running)). On Linux,
   `sudo systemctl restart couchwave`.

**With `git`, staying on releases** (as set up in the Linux steps above), from the Couchwave folder:

```sh
git fetch --tags
git checkout "$(git describe --tags --abbrev=0 origin/main)"
```

then restart as above.

**The very latest code** (not recommended): `git checkout main`, then `git pull`. This gets every change
as soon as it's made, before it's been released, so now and then something may not work yet. If `git`
says your local changes would be overwritten, you've edited one of Couchwave's own files: `git stash`
puts your changes aside, then try again (`git stash pop` brings them back).

Everyone else just refreshes the page. Settings added in a new version use their defaults until you add
them to `config.json` (see [Settings](#settings)).

## Troubleshooting

- **Songs fail with "Blocked by YouTube" or "bot check"**: run `yt-dlp -U`, then press the song's retry
  button. (Couchwave updates yt-dlp daily, but YouTube sometimes changes faster.) If it keeps happening,
  YouTube may be checking your connection after a lot of downloads at once; it usually passes within a few
  hours.
- **Friends on your network can't connect** (but <http://localhost:3000> works for you): check they're using
  this machine's IP, not `localhost`. On Windows, allow Node.js through the firewall: **Windows Security** →
  **Firewall & network protection** → **Allow an app through firewall** → tick **Private** for Node.js. On
  Linux with `ufw` turned on: `sudo ufw allow 3000/tcp`.
- **Won't start**: the reason is in `data/server.log`. Usually it's a broken `config.json`.
- **"Logins are paused"**: `data/accounts.json` can't be read (e.g. a bad hand edit). The log says why.
