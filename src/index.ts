#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config, envValue } from "./config.js";
import { ensureStore, stopBackgroundRefresh } from "./data.js";
import { refuseMisconfiguration } from "./access.js";
import { normalizeCuratorToken, redactToken, startRelay } from "./relay.js";

// The stdio server (and the .mcpb) is public (#26): it refuses curator mode,
// and an Omeka key, before touching any data. With AMIRA_CURATOR_TOKEN it
// relays to a curator server instead, and still holds no private data itself.
refuseMisconfiguration("stdio");

/** Relay mode: forward stdio to the curator endpoint; no snapshot, no cache. */
async function relay(): Promise<void> {
  let token: string;
  try {
    token = normalizeCuratorToken(envValue("AMIRA_CURATOR_TOKEN") ?? "");
  } catch (err) {
    console.error(`[amira] refusing to start: ${(err as Error).message}`);
    process.exit(1);
  }
  // Nothing else in this process needs it; keep it out of the environment.
  delete process.env.AMIRA_CURATOR_TOKEN;
  const url = new URL(config.curatorUrl);
  let handle: Awaited<ReturnType<typeof startRelay>>;
  try {
    handle = await startRelay({ url, token });
  } catch (err) {
    console.error(`[amira] relay failed to start: ${redactToken(String((err as Error)?.message ?? err), token)}`);
    process.exit(1);
  }
  console.error(
    `[amira] AMIRA MCP server v${VERSION} relaying stdio to the curator server at ${url.origin}${url.pathname} ` +
      "(curator token set; no local data is loaded or cached)",
  );
  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`[amira] ${signal} received; closing the relay`);
    void handle.close();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  await handle.closed;
}

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
  const stdio = serveStdio(() => createAmiraServer()); // stdio surface: the 34 core tools
  console.error(
    `[amira] AMIRA MCP server v${VERSION} running on stdio (site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[amira] ${signal} received; closing stdio transport`);
    try {
      await Promise.all([stopBackgroundRefresh(), stdio.close()]);
    } catch (err) {
      console.error("[amira] stdio shutdown failed:", err);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.once("end", () => void stopBackgroundRefresh());
}

(config.curatorRelay ? relay() : main()).catch((err) => {
  console.error("[amira] fatal:", err);
  process.exit(1);
});
