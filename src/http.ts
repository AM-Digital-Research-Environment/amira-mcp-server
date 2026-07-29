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
// Stateless: a fresh server instance per request, so concurrent clients can
// never collide on JSON-RPC ids. The data lives in a process-wide singleton, so
// per-request setup is just cheap handler wiring, not a data reload. Since
// 2026-07-28 (SEP-2567) that is also what the protocol itself prescribes —
// sessions are gone — so the shape this file always had is now the default.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { currentStore, ensureStore } from "./data.js";

const MCP_PATH = "/mcp";
let startupError: string | null = null;

/** Public, read-only data → permissive CORS so browser-based clients can connect.
 *
 * The allow-list spans both protocol revisions: `Mcp-Session-Id`,
 * `MCP-Protocol-Version` and `Last-Event-ID` for clients on 2025-11-25 and
 * earlier, `Mcp-Method` / `Mcp-Name` / `X-Mcp-Header` for the stateless
 * 2026-07-28 revision, which requires them on every Streamable HTTP POST
 * (SEP-2243). Omitting the new pair fails preflight for browser clients. */
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, " +
      "Mcp-Method, Mcp-Name, X-Mcp-Header",
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

// --- rate limiting ------------------------------------------------------------
//
// A fixed-window cap per client on /mcp (health probes are exempt). Every query
// scans the whole in-memory snapshot, so an unauthenticated public endpoint
// wants at least a courtesy limit; a proxy in front should still do the real
// one, since the client key is only as trustworthy as the network path.

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

function clientKey(req: IncomingMessage): string {
  if (config.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Seconds to wait, or 0 when the request is within budget. */
function rateLimited(req: IncomingMessage): number {
  if (config.rateLimitPerMinute <= 0) return 0;
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const key = clientKey(req);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return 0;
  }
  bucket.count += 1;
  if (bucket.count <= config.rateLimitPerMinute) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function healthBody(): Record<string, unknown> {
  // Read the store through currentStore() rather than caching a reference: the
  // background refresh hot-swaps it, and a captured one made /healthz report
  // the boot-time snapshot forever on a long-running container.
  const store = currentStore();
  return {
    name: "amira-mcp-server",
    version: VERSION,
    status: startupError ? "error" : store ? "ok" : "loading",
    transport: "streamable-http",
    mcp_endpoint: MCP_PATH,
    site: config.siteBase,
    ...(store
      ? {
          data_snapshot: {
            source: store.source,
            fetched_at: store.manifest.fetchedAt,
            research_items: store.items.length,
            projects: store.projects.length,
            publications: store.publications.length,
            youtube_videos: store.videos.length,
          },
        }
      : {}),
    ...(startupError ? { error: startupError } : {}),
  };
}

/**
 * The MCP entry, built once and reused for every request.
 *
 * `createMcpHandler` owns the era decision per request: modern (2026-07-28)
 * exchanges are served from the envelope, and `legacy: 'stateless'` — the
 * default — answers 2025-era traffic exactly the way this file used to by hand,
 * a fresh instance per request over a transport with `sessionIdGenerator:
 * undefined`. So old clients (ChatGPT's connector, anything pinned to
 * 2025-11-25) keep working unchanged while new ones get `server/discover`.
 *
 * The factory runs per request, so the per-request statelessness that keeps
 * concurrent clients from colliding on JSON-RPC ids is preserved; the data
 * still lives in the process-wide snapshot singleton, so this stays cheap.
 */
const mcpHandler = toNodeHandler(
  createMcpHandler(() => createAmiraServer({ openai: true })), // 26 rich tools + search/fetch
  { onerror: (err) => console.error("[amira] mcp handler error:", err) },
);

const httpServer = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  setCors(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (path === "/" || path === "/healthz") {
    sendJson(res, currentStore() && !startupError ? 200 : 503, healthBody());
    return;
  }

  if (path === MCP_PATH) {
    const retryAfter = rateLimited(req);
    if (retryAfter) {
      res.setHeader("Retry-After", String(retryAfter));
      sendJson(res, 429, {
        error: "rate limited",
        message: `More than ${config.rateLimitPerMinute} requests/minute from this client. Retry in ${retryAfter}s.`,
      });
      return;
    }
    void Promise.resolve(mcpHandler(req, res)).catch((err) => {
      console.error("[amira] http request error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    });
    return;
  }

  sendJson(res, 404, { error: "not found", mcp_endpoint: MCP_PATH });
});

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
  console.error(
    `[amira] AMIRA MCP server v${VERSION} on http://${config.httpHost}:${config.httpPort}${MCP_PATH} ` +
      `(site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );
});

httpServer.on("error", (err) => {
  console.error("[amira] http server error:", err);
  process.exit(1);
});
