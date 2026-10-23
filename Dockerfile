# OpenMausBot for Railway: the web app, the harness server, Claude Code and the
# Caddy edge in one container. Build context is the repository root
# (railway.json points here).
#
#   docker build -t openmausbot-railway .
#   docker run --rm -p 8080:8080 -e OMB_EDGE_SCHEME=http -e OMB_ADMIN_PASSWORD=... \
#     -v omb-data:/data openmausbot-railway
#
# HOME is /data: attach a Railway volume there, so Claude Code's login
# (~/.claude) and OpenMausBot's own state (~/.openmausbot) survive deploys.

FROM caddy:2.10.2 AS edge
# A plain copy to a fresh inode drops the image's privileged-port capability;
# the edge listens on Railway's unprivileged $PORT.
RUN cp /usr/bin/caddy /caddy

FROM node:24-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@10.33.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY cloudflare/control-plane/package.json ./cloudflare/control-plane/package.json
# package.json's `prepare` runs during install and must be loadable without .git.
COPY scripts/install-git-hooks.mjs ./scripts/install-git-hooks.mjs
RUN pnpm install --frozen-lockfile
COPY . .
RUN node scripts/prepare-duckdb.mjs && mv dist-native/duckdb/linux-* /src/duckdb && chmod -R go-w /src/duckdb
RUN pnpm build:server && pnpm exec vite build && chmod -R go-w dist dist-server skills

FROM node:24-bookworm-slim
# git + curl: Claude Code shells out to git; curl backs the healthcheck.
# tini is PID 1: bots' browsers and shells leave exited processes to reap.
# python3, poppler-utils, unzip: what bots reach for in their shell.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git tini \
    python3 poppler-utils unzip \
    libxcb-shm0 libx11-xcb1 libx11-6 libxcb1 libxext6 libxrandr2 \
    libxcomposite1 libxcursor1 libxdamage1 libxfixes3 libxi6 libgtk-3-0 \
    libpangocairo-1.0-0 libpango-1.0-0 libatk1.0-0 libcairo-gobject2 \
    libcairo2 libgdk-pixbuf-2.0-0 libxrender1 libasound2 libfreetype6 \
    libfontconfig1 libdbus-1-3 libnss3 libnss3-tools libnspr4 \
    libatk-bridge2.0-0 libdrm2 libxkbcommon0 libatspi2.0-0 libcups2 \
    libxshmfence1 libgbm1 fonts-noto-color-emoji fonts-noto-cjk fonts-freefont-ttf \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --home-dir /data --shell /bin/bash maus
# The bots' browser: pinned with server/browser-engine-release.ts.
ARG AGENT_BROWSER_VERSION=0.37.0
RUN npm install -g --cache /tmp/npm-cache agent-browser@${AGENT_BROWSER_VERSION} \
  && HOME=/opt/openmausbot-browser agent-browser install \
  && ln -s /opt/openmausbot-browser/.agent-browser/browsers/chrome-*/chrome /opt/openmausbot-browser/chrome \
  && native="$(readlink -f "$(command -v agent-browser)")" \
  && for binary in "${native%/*}"/agent-browser-*; do [ "$binary" = "$native" ] || rm "$binary"; done \
  && agent-browser --version \
  && rm -rf /tmp/npm-cache /tmp/node-compile-cache
COPY --from=edge /caddy /usr/local/bin/caddy
# Claude Code, the only engine. It cannot update itself here (root owns the
# install); rebuild the image to move to a newer version.
ARG CLAUDE_CODE_VERSION=latest
RUN HOME=/tmp/omb-build-home npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
  && HOME=/tmp/omb-build-home claude --version \
  && rm -rf /tmp/omb-build-home /tmp/node-compile-cache
ENV AGENT_BROWSER_EXECUTABLE_PATH=/opt/openmausbot-browser/chrome \
    OMB_DUCKDB_DIR=/app/duckdb \
    OMB_DATA_DIR=/data/.openmausbot \
    OMB_STATIC_DIR=/app/dist \
    DISABLE_AUTOUPDATER=1 \
    NODE_ENV=production \
    PORT=8080
WORKDIR /app
# The root supervisor runs /app's code, so none of it may be a file `maus` can
# change: these copies stay root's (server/railway-start.ts refuses otherwise).
COPY --from=build /src/duckdb ./duckdb
COPY --from=build /src/dist-server ./dist-server
COPY --from=build /src/dist ./dist
COPY --from=build /src/skills ./skills
COPY deploy/railway/Caddyfile /app/railway/Caddyfile
RUN chmod -R go-w /app \
  && PORT=8080 OMB_EDGE_SCHEME=https caddy validate --config /app/railway/Caddyfile --adapter caddyfile \
  && test -f /app/dist-server/railway-start.js
ENV HOME=/data
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD curl -sf "http://127.0.0.1:${PORT}/api/health" | grep -q openmausbot || exit 1
USER root
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist-server/railway-start.js"]
