# Installing Couchwave

You need **Node.js 18 or newer**, **yt-dlp** and **ffmpeg**.

- [Windows](#windows)
- [Linux (Debian, Ubuntu, Raspberry Pi OS)](#linux-debian-ubuntu-raspberry-pi-os)
- [Keep it running](#keep-it-running)
- [Letting friends in](#letting-friends-in)
- [Updating](#updating)

## Windows

1. Install the tools. Open PowerShell and run:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install yt-dlp.yt-dlp
   ```

   (The yt-dlp package brings ffmpeg with it.) Close and reopen PowerShell afterwards.

2. Get Couchwave: download it from GitHub (**Code → Download ZIP**, then unzip it), or
   `git clone https://github.com/Hoyle95/couchwave.git`.

3. Double-click **`start.cmd`** in the Couchwave folder and keep the window open.

4. Open <http://localhost:3000>. The room password is in **`config.json`**, which is created the first
   time it runs. Change the password, the port or the vote percentage there; the server restarts by itself
   when you save.

## Linux (Debian, Ubuntu, Raspberry Pi OS)

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

3. Open <http://localhost:3000> (or `http://<this machine's IP>:3000` from another device). The room
   password is printed on the first run and saved in **`config.json`**. Change the password, the port or the
   vote percentage there and restart.

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

Either way, use `https://`: the passwords and everyone's login are sent over it, and phones only offer
"Install app" on secure sites. Both tell Couchwave the visit came over `https://`, so it marks logins
HTTPS-only (never sent unencrypted). Another proxy has to run on the same machine and send
`X-Forwarded-Proto` (nginx: `proxy_set_header X-Forwarded-Proto $scheme;`).

Then send your friends the address and the room password. The first time they join, they pick a nickname
and a password for it.

## Updating

Download the new version (or `git pull`) over the old one. `config.json` and `data/` are kept. On Windows
it restarts by itself (if the page doesn't come back, stop and start it as above); on Linux,
`sudo systemctl restart couchwave`. Everyone just needs to refresh the page.
