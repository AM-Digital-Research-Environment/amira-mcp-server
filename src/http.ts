#!/usr/bin/env node
// Remote MCP transport: a stateless Streamable HTTP endpoint that makes the
// server reachable by ChatGPT (Developer Mode / Deep Research connectors), the
// OpenAI + Anthropic APIs, Claude.ai's remote connectors, and any other remote
// MCP client — all by pasting one URL, no download. Same in-memory snapshot and
// tools as the stdio entry, plus the OpenAI `search`/`fetch` tools.
//
//   POST /mcp      — JSON-RPC over Streamable HTTP (the MCP endpoint)
//   GET  /healthz  — liveness probe (also served at /)
//
// Stateless: a fresh server + transport per request, so concurrent clients can
// never collide on JSON-RPC ids. The data lives in a process-wide singleton, so
// per-request setup is just cheap handler wiring, not a data reload.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { ensureStore } from "./data.js";

const MCP_PATH = "/mcp";

/** Public, read-only data → permissive CORS so browser-based clients can connect. */
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const server = createAmiraServer({ openai: true }); // 24 rich tools + search/fetch
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/" || path === "/healthz") {
    sendJson(res, 200, {
      name: "amira-mcp-server",
      version: VERSION,
      transport: "streamable-http",
      mcp_endpoint: MCP_PATH,
      site: config.siteBase,
    });
    return;
  }

  if (path === MCP_PATH) {
    handleMcp(req, res).catch((err) => {
      console.error("[amira] http request error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }

  sendJson(res, 404, { error: "not found", mcp_endpoint: MCP_PATH });
});

// Warm the snapshot (and kick off the background refresh) before traffic.
void ensureStore()
  .then((store) =>
    console.error(
      `[amira] loaded ${store.items.length} research items / ${store.projects.length} projects / ` +
        `${store.videos.length} videos from ${store.source} snapshot (fetchedAt=${store.manifest.fetchedAt})`,
    ),
  )
  .catch((err) => console.error(`[amira] initial data load failed: ${(err as Error).message}`));

httpServer.listen(config.httpPort, config.httpHost, () => {
  console.error(
    `[amira] AMIRA MCP server v${VERSION} on http://${config.httpHost}:${config.httpPort}${MCP_PATH} ` +
      `(site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );
});

httpServer.on("error", (err) => {
  console.error("[amira] http server error:", err);
  process.exit(1);
});
