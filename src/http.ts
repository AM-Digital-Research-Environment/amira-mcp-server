#!/usr/bin/env node
// Remote MCP transport entry: listens and handles signals. The application —
// routing, validation, CORS, rate limiting and the MCP handler — lives in
// src/httpApp.ts so tests can drive it in-process. This makes the server
// reachable by ChatGPT (Developer Mode / Deep Research connectors), the OpenAI
// and Anthropic APIs, Claude.ai's remote connectors and any other remote MCP
// client by pasting one URL. Same snapshot and tools as the stdio entry, plus
// the OpenAI `search`/`fetch` tools.
import { createServer } from "node:http";
import { createHttpApp, MCP_PATH } from "./httpApp.js";
import { VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { ensureStore, stopBackgroundRefresh } from "./data.js";

let startupError: string | null = null;
const app = createHttpApp({ startupError: () => startupError });
const httpServer = createServer(app.listener);

// Warm the snapshot (and kick off the background refresh) before traffic.
void ensureStore()
  .then((store) => {
    console.error(
      `[amira] loaded ${store.items.length} research items / ${store.projects.length} projects / ` +
        `${store.videos.length} videos from ${store.source} snapshot (fetchedAt=${store.manifest.fetchedAt})`,
    );
  })
  .catch((err) => {
    startupError = (err as Error).message;
    console.error(`[amira] initial data load failed: ${startupError}`);
  });

httpServer.listen(config.httpPort, config.httpHost, () => {
  const address = httpServer.address();
  const port = address && typeof address === "object" ? address.port : config.httpPort;
  console.error(
    `[amira] AMIRA MCP server v${VERSION} on http://${config.httpHost}:${port}${MCP_PATH} ` +
      `(site: ${config.siteBase}, live refresh: ${config.liveRefresh}, trust proxy: ${config.trustProxy})`,
  );
});

httpServer.on("error", (err) => {
  console.error("[amira] http server error:", err);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(`[amira] ${signal} received; closing HTTP server and MCP exchanges`);
  const httpClosed = new Promise<void>((resolve, reject) => {
    httpServer.close((err) => (err ? reject(err) : resolve()));
  });
  try {
    const deadline = setTimeout(() => { httpServer.closeAllConnections(); process.exitCode = 1; }, 10_000);
    deadline.unref();
    try { await Promise.all([stopBackgroundRefresh(), app.close(), httpClosed]); }
    finally { clearTimeout(deadline); }
  } catch (err) {
    console.error("[amira] HTTP shutdown failed:", err);
    process.exitCode = 1;
  }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
