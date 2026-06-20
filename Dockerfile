# syntax=docker/dockerfile:1
# Remote AMIRA MCP server (Streamable HTTP). Crawls a fresh snapshot from the
# public Omeka S API at build time, then runs the self-contained esbuild bundle
# — no node_modules needed at runtime.
#   docker build -t amira-mcp .
#   docker run -p 8787:8787 amira-mcp     # → http://localhost:8787/mcp

FROM node:26-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
# Bundles the server (incl. server/http.js) AND writes the data/ snapshot.
RUN npm run fetch-data

FROM node:26-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    AMIRA_LIVE_REFRESH=true \
    AMIRA_CACHE_DIR=/tmp/amira-cache
# Self-contained bundles + the JSON snapshot; nothing from node_modules.
COPY --from=build /app/server ./server
COPY --from=build /app/data ./data
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/http.js"]
