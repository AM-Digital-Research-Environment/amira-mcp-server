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
# never silently goes stale.

ARG SNAPSHOT_STAGE=fetch
FROM node:26-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY .claude/skills ./.claude/skills
RUN npm run skills:check
RUN npm run build:strict

# Default convenience target still fetches current public data.
FROM build AS fetch
RUN node server/fetchCli.js

# Reproducible build using an already reviewed snapshot; no Omeka request.
FROM build AS bundled
COPY data ./data
RUN node --input-type=module -e "import {loadSnapshot} from './server/lib.js'; await loadSnapshot('./data')"

FROM ${SNAPSHOT_STAGE} AS snapshot

FROM node:26-slim@sha256:930557a230abacbc3f4fd9b8648abf8f4bee1e17cb72195dcdfb2f709bc85b33 AS run
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
