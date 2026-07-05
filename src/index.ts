#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { ensureStore } from "./data.js";

async function main(): Promise<void> {
  const server = createAmiraServer(); // stdio surface: the 26 rich tools

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

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[amira] AMIRA MCP server v${VERSION} running on stdio (site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );
}

main().catch((err) => {
  console.error("[amira] fatal:", err);
  process.exit(1);
});
