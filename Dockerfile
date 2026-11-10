# syntax=docker/dockerfile:1
# Remote AMIRA MCP server (Streamable HTTP). Crawls a fresh snapshot from the
# public Omeka S API at build time, then runs the self-contained esbuild bundle
# — no node_modules needed at runtime.
#   docker build -t amira-mcp .
#   docker run -p 8787:8787 amira-mcp     # → http://localhost:8787/mcp
#
# Both base images are pinned to the multi-arch index digest of node:26-slim;
# the tag is kept for readability. Dependabot's `docker` ecosystem
# (.github/dependabot.yml) opens a PR whenever that digest moves, so the pin
# never silently goes stale. The digest alone lags Debian's security fixes, so
# the runtime stage also applies them at build time (see below); CI and
# .github/workflows/image-scan.yml check the result with Trivy.

ARG SNAPSHOT_STAGE=fetch
FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY tsconfig.json ./
COPY src ./src
# Only the build scripts: copying all of scripts/ rebuilt this layer whenever
# weigh, census or a release helper changed.
COPY scripts/build.mjs scripts/skills.mjs ./scripts/
COPY .claude/skills ./.claude/skills
# --strict also validates the companion skill (it subsumes `skills:check`).
RUN npm run build:strict

# Default convenience target still fetches current public data.
FROM build AS fetch
RUN node server/fetchCli.js

# Reproducible build using an already reviewed snapshot; no Omeka request.
FROM build AS bundled
COPY data ./data
RUN node --input-type=module -e "import {loadSnapshot} from './server/lib.js'; await loadSnapshot('./data')"

FROM ${SNAPSHOT_STAGE} AS snapshot

FROM node:26-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS run
# Releases push this image to ghcr.io (.github/workflows/release.yml).
LABEL org.opencontainers.image.source="https://github.com/AM-Digital-Research-Environment/amira-mcp-server" \
      io.modelcontextprotocol.server.name="io.github.AM-Digital-Research-Environment/amira-mcp-server"
# Debian security updates published since the base image was built (node's
# image refreshes only every few weeks), and no npm: the server runs a
# self-contained bundle, so npm and the dependencies it vendors are never
# loaded, yet they carried most of the image's fixable CVEs. This layer varies
# with the build date by design; releases push the exact bytes CI tested.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    AMIRA_LIVE_REFRESH=true \
    AMIRA_CACHE_DIR=/tmp/amira-cache
# Self-contained bundles + the JSON snapshot; nothing from node_modules.
COPY --from=snapshot /app/server ./server
COPY --from=snapshot /app/data ./data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/http.js"]
