#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { ensureStore } from "./data.js";

async function main(): Promise<void> {
  // Warm the in-memory snapshot (and kick off the background refresh) without
  // blocking startup. Tool calls await ensureStore() and surface any load error.
  void ensureStore()
    .then((store) =>
      console.error(
        `[amira] loaded ${store.items.length} research items / ${store.projects.length} projects / ` +
          `${store.videos.length} videos from ${store.source} snapshot (fetchedAt=${store.manifest.fetchedAt})`,
      ),
    )
    .catch((err) => console.error(`[amira] initial data load failed: ${(err as Error).message}`));

  // `serveStdio` owns the era decision: the opening exchange picks 2026-07-28
  // (`server/discover`) or the legacy `initialize` ladder, then pins ONE
  // instance from the factory for the connection's lifetime. Connecting a bare
  // StdioServerTransport by hand would serve the 2025 era only — the modern
  // methods answer `-32601` because nothing marked the connection's era.
  const stdio = serveStdio(() => createAmiraServer()); // stdio surface: the 26 rich tools
  console.error(
    `[amira] AMIRA MCP server v${VERSION} running on stdio (site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[amira] ${signal} received; closing stdio transport`);
    try {
      await stdio.close();
    } catch (err) {
      console.error("[amira] stdio shutdown failed:", err);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[amira] fatal:", err);
  process.exit(1);
});
