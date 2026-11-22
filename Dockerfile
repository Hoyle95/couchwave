# ---------- Couchwave in Docker (see docs/INSTALL.md#docker) ----------
FROM node:22-bookworm-slim
ARG TARGETARCH
LABEL org.opencontainers.image.source="https://github.com/Hoyle95/couchwave" \
      org.opencontainers.image.description="Watch YouTube together: a self-hosted shared queue, synced playback, chat and reactions" \
      org.opencontainers.image.licenses="Apache-2.0"

# ---------- ffmpeg, and yt-dlp in a folder Couchwave can update it in ----------
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir /opt/yt-dlp \
 && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$([ "$TARGETARCH" = arm64 ] && echo yt-dlp_linux_aarch64 || echo yt-dlp_linux)" -o /opt/yt-dlp/yt-dlp \
 && chmod 755 /opt/yt-dlp/yt-dlp \
 && chown -R node:node /opt/yt-dlp \
 && /opt/yt-dlp/yt-dlp --version
ENV PATH="/opt/yt-dlp:${PATH}"

# ---------- Couchwave, with its settings in the data folder (one volume holds everything) ----------
WORKDIR /app
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/couchwave-start
RUN chmod 755 /usr/local/bin/couchwave-start
ENV COUCHWAVE_CONFIG=/app/data/config.json
VOLUME /app/data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const c = require(process.env.COUCHWAVE_CONFIG); fetch('http://127.0.0.1:' + (c.port || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["tini", "--", "couchwave-start"]
