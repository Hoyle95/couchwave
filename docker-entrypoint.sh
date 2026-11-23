#!/bin/sh
# ---------- Starting Couchwave in Docker: the data folder is made Couchwave's, then it runs as the node user ----------
set -e
mkdir -p /app/data
if [ "$(id -u)" = 0 ]; then
  chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups node server.js "$@"
fi
exec node server.js "$@"
