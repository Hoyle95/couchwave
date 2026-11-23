#!/usr/bin/env bash
# ---------- Couchwave installer for Linux (Debian, Ubuntu, Raspberry Pi OS) ----------
# In a terminal:  curl -fsSL https://raw.githubusercontent.com/Hoyle95/couchwave/main/install.sh | bash
# Installs Node.js, ffmpeg and yt-dlp, downloads the newest Couchwave release into ~/couchwave, runs it as a
# service that starts with the computer, lets friends on your home network in (if ufw is on), and starts it.
# Run it again to update: config.json and data/ are kept. Optional: COUCHWAVE_DIR (where to install),
# COUCHWAVE_PORT (the port for a new install; otherwise the first free one from 3000).
set -euo pipefail

DIR="${COUCHWAVE_DIR:-$HOME/couchwave}"
SERVICE="${COUCHWAVE_SERVICE:-couchwave}"
step() { printf '\n\033[36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
as_root() { if [ "$(id -u)" -eq 0 ]; then "$@"; else sudo "$@"; fi; }
node_ok() { command -v node >/dev/null && node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 18 || (a === 18 && b >= 11) ? 0 : 1)'; }
config() { node -e 'try { const c = require(process.argv[1]); console.log(c[process.argv[2]] ?? "") } catch { console.log("") }' "$DIR/config.json" "$1"; }
free() { node -e 'const s = require("net").createServer(); s.once("error", () => process.exit(1)); s.listen(Number(process.argv[1]), () => s.close(() => process.exit(0)))' "$1"; }
is_couchwave() { curl -fs "http://localhost:$1/manifest.json" 2>/dev/null | node -e 'let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => { try { process.exit(JSON.parse(s).name === "Couchwave" ? 0 : 1) } catch { process.exit(1) } })'; }

command -v apt-get >/dev/null || die "This installer is for Debian, Ubuntu and Raspberry Pi OS. On other systems, follow docs/INSTALL.md."

step "Installing what Couchwave needs (Node.js, ffmpeg, and Python for yt-dlp)"
as_root apt-get update -qq
as_root apt-get install -y -qq curl unzip ffmpeg python3 ca-certificates >/dev/null
node_ok || as_root apt-get install -y -qq nodejs >/dev/null || true
if ! node_ok; then
  echo "  this system's Node.js is too old: getting a newer one from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | as_root bash - >/dev/null
  as_root apt-get install -y -qq nodejs >/dev/null
fi
node_ok || die "Couldn't install Node.js 18.11 or newer. Install it from https://nodejs.org, then run this again."

step "Installing yt-dlp (its own copy, so Couchwave can keep it up to date)"
mkdir -p "$HOME/.local/bin"
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$HOME/.local/bin/yt-dlp"
chmod +x "$HOME/.local/bin/yt-dlp"
export PATH="$HOME/.local/bin:$PATH"
echo "  Node.js $(node --version), yt-dlp $(yt-dlp --version)"

step "Downloading the newest Couchwave"
AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
FOUND=$(curl -fsSL "${AUTH[@]}" -H 'User-Agent: Couchwave installer' 'https://api.github.com/repos/Hoyle95/couchwave/releases?per_page=10' | node -e '
  let s = ""; process.stdin.on("data", d => (s += d)).on("end", () => {
    const r = JSON.parse(s).find(r => !r.draft), a = r && r.assets.find(a => /^couchwave-.*\.zip$/.test(a.name));
    if (!a) process.exit(1);
    console.log(a.browser_download_url, (/^sha256:([0-9a-f]{64})$/i.exec(a.digest || "") || [, "none"])[1].toLowerCase());
  });') || die "Couldn't find the Couchwave download on GitHub. Try again in a few minutes."
URL=${FOUND% *}; SUM=${FOUND##* }
[ "$SUM" != none ] || die "GitHub gave no checksum to check the Couchwave download against, so it wasn't installed. Try again in a few minutes."
TMP=$(mktemp -d)
curl -fsSL "$URL" -o "$TMP/couchwave.zip"
[ "$(sha256sum "$TMP/couchwave.zip" | cut -d' ' -f1)" = "$SUM" ] || { rm -rf "$TMP"; die "The Couchwave download doesn't match its checksum, so it wasn't installed. Try again in a few minutes."; }
echo "  $(basename "$URL" .zip)"

HAS_SYSTEMD=0
[ -d /run/systemd/system ] && HAS_SYSTEMD=1
if [ -f "$DIR/server.js" ]; then
  step "Stopping the Couchwave in $DIR, to update it"
  [ "$HAS_SYSTEMD" = 1 ] && as_root systemctl stop "$SERVICE" 2>/dev/null || true
  if grep -q "'--stop'" "$DIR/server.js"; then (cd "$DIR" && node server.js --stop >/dev/null 2>&1) || true; fi
fi

step "Installing it in $DIR"
mkdir -p "$DIR"
unzip -o -q "$TMP/couchwave.zip" -d "$DIR"
rm -rf "$TMP"
if [ ! -f "$DIR/config.json" ]; then
  NEW_PORT="${COUCHWAVE_PORT:-3000}"
  if [ -z "${COUCHWAVE_PORT:-}" ]; then
    while ! free "$NEW_PORT" && [ "$NEW_PORT" -lt 3100 ]; do NEW_PORT=$((NEW_PORT + 1)); done
    [ "$NEW_PORT" != 3000 ] && echo "  port 3000 is already used by something else, so Couchwave gets port $NEW_PORT"
  fi
  node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ password: require("crypto").randomBytes(6).toString("base64url"), port: Number(process.argv[2]) }, null, 2) + "\n")' "$DIR/config.json" "$NEW_PORT"
fi

if [ "$HAS_SYSTEMD" = 1 ]; then
  step "Starting Couchwave, and with the computer from now on (service \"$SERVICE\")"
  as_root tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=Couchwave
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
Environment=PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  as_root systemctl daemon-reload
  as_root systemctl enable "$SERVICE" >/dev/null 2>&1
  as_root systemctl restart "$SERVICE"
else
  step "Starting Couchwave (this system has no systemd, so it won't start with the computer by itself)"
  (cd "$DIR" && nohup node server.js >/dev/null 2>&1 &)
fi

PORT=$(node -e 'let c = {}; try { c = require(process.argv[1]) } catch {} const p = Number(c.port); console.log(c.port != null && Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 3000)' "$DIR/config.json")
if command -v ufw >/dev/null && as_root ufw status 2>/dev/null | grep -q '^Status: active'; then
  step "Letting friends on your home network in (ufw)"
  for net in 192.168.0.0/16 10.0.0.0/8 172.16.0.0/12; do as_root ufw allow from "$net" to any port "$PORT" proto tcp >/dev/null; done
fi
UP=0
for _ in $(seq 1 60); do is_couchwave "$PORT" && UP=1 && break; sleep 1; done
PASSWORD=$(config password)

echo
if [ "$UP" = 1 ]; then printf '\033[32mCouchwave is running!\033[0m\n'
elif ! free "$PORT"; then
  printf '\033[33mCouchwave is installed, but port %s is used by another program, so it can not start.\033[0m\n' "$PORT"
  echo "  Pick another port: change \"port\" in $DIR/config.json, then run this line again."
else printf '\033[33mCouchwave is installed, but it has not started yet. If it does not, the reason is in %s/data/server.log\033[0m\n' "$DIR"; fi
echo "  Open it:          http://localhost:$PORT"
IPS=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }')
[ -n "$IPS" ] || IPS=$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -v ':' | head -1)
for ip in $IPS; do echo "  Friends at home:  http://$ip:$PORT"; done
[ -n "$PASSWORD" ] && echo "  Room password:    $PASSWORD   (in $DIR/config.json)"
if [ "$HAS_SYSTEMD" = 1 ]; then echo "  It starts with the computer. To stop it: sudo systemctl stop $SERVICE"; fi
if grep -q "'--update'" "$DIR/server.js"; then echo "  To update later: cd $DIR && node server.js --update (or run the same line again)."
else echo "  Run the same line again any time to update."; fi
echo "  To let friends in from the internet, see"
echo "  https://github.com/Hoyle95/couchwave/blob/main/docs/INSTALL.md#letting-friends-in"
