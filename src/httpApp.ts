// The Streamable HTTP application: request routing, Origin/Host validation,
// CORS, rate limiting, health and the MCP handler. Kept apart from the process
// entry (src/http.ts, which only listens and handles signals) so tests can drive
// it in-process on an ephemeral port.
//
//   POST /mcp      — JSON-RPC over Streamable HTTP (the MCP endpoint)
//   GET  /healthz  — liveness probe (also served at /)
//
// Stateless: a fresh server instance per request, so concurrent clients can
// never collide on JSON-RPC ids. The data lives in a process-wide singleton, so
// per-request setup is just cheap handler wiring, not a data reload. Since
// 2026-07-28 (SEP-2567) that is also what the protocol itself prescribes.
import { isIP } from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { localhostHostValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import { createAmiraServer, VERSION } from "./mcpServer.js";
import { config } from "./config.js";
import { currentStore, refreshStatus } from "./data.js";

export const MCP_PATH = "/mcp";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_BUCKETS = 10_000;

export interface HttpAppOptions {
  rateLimitPerMinute?: number;
  trustProxy?: boolean;
  proxyHops?: number;
  allowedOriginHostnames?: string[];
  host?: string;
  /** Reported by /healthz while the snapshot is unavailable. */
  startupError?: () => string | null;
}

/** "a:b::c" → eight hextets; null for anything else. */
function expandIPv6(address: string): string[] | null {
  const [head, tail, extra] = address.split("::");
  if (extra !== undefined) return null;
  const left = head ? head.split(":") : [];
  const right = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = tail !== undefined ? 8 - left.length - right.length : 0;
  const parts = [...left, ...Array<string>(Math.max(0, fill)).fill("0"), ...right];
  return parts.length === 8 ? parts.map((p) => p.toLowerCase().replace(/^0+(?=.)/, "")) : null;
}

/** The rate-limit bucket for an address: IPv4 as is, IPv6 by /64 prefix (one
 * subscriber typically controls a whole /64, so per-address keys are free to evade). */
export function addressBucket(address: string): string {
  const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4mapped) return v4mapped[1]!;
  if (isIP(address) === 6) {
    const hextets = expandIPv6(address.replace(/%.*$/, ""));
    if (hextets) return `${hextets.slice(0, 4).join(":")}::/64`;
  }
  return address;
}

/**
 * The client address a request is attributed to.
 *
 * Without `trustProxy` it is the socket peer. Behind the AMIRA nginx that is the
 * proxy container for EVERY request, so the whole public endpoint shared one
 * bucket. With `trustProxy`, the address the trusted proxy itself observed is
 * used: `X-Real-IP` (nginx sets it to `$remote_addr`), otherwise the entry
 * `proxyHops` from the RIGHT of `X-Forwarded-For`. The leftmost entry — which
 * 1.18 used — is whatever the client sent, because nginx's
 * `$proxy_add_x_forwarded_for` appends to the client's own header.
 */
export function clientAddress(req: IncomingMessage, opts: { trustProxy: boolean; proxyHops: number }): string {
  if (opts.trustProxy) {
    const realIp = req.headers["x-real-ip"];
    const real = (Array.isArray(realIp) ? realIp[realIp.length - 1] : realIp)?.trim();
    if (real && isIP(real)) return real;
    const xff = req.headers["x-forwarded-for"];
    const hops = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const candidate = hops[hops.length - Math.max(1, opts.proxyHops)];
    if (candidate && isIP(candidate)) return candidate;
  }
  return req.socket.remoteAddress ?? "unknown";
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** A fixed-window per-client limiter with a bounded key set. */
export function createRateLimiter(perMinute: number, keyOf: (req: IncomingMessage) => string) {
  const buckets = new Map<string, Bucket>();
  return {
    /** Seconds to wait, or 0 when the request is within budget. */
    check(req: IncomingMessage, now = Date.now()): number {
      if (perMinute <= 0) return 0;
      if (buckets.size >= MAX_BUCKETS) {
        for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
      }
      const key = keyOf(req);
      const bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        if (!bucket && buckets.size >= MAX_BUCKETS) return 60;
        buckets.set(key, { count: 1, resetAt: now + 60_000 });
        return 0;
      }
      bucket.count += 1;
      if (bucket.count <= perMinute) return 0;
      return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    },
    get size(): number {
      return buckets.size;
    },
  };
}

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
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function healthBody(startupError: string | null): Record<string, unknown> {
  // Read the store through currentStore() rather than caching a reference: the
  // background refresh hot-swaps it.
  const store = currentStore();
  return {
    name: "amira-mcp-server",
    version: VERSION,
    status: store ? "ok" : startupError ? "error" : "loading",
    transport: "streamable-http",
    mcp_endpoint: MCP_PATH,
    site: config.siteBase,
    refresh: refreshStatus(),
    ...(store
      ? {
          data_snapshot: {
            source: store.source,
            fetched_at: store.manifest.fetchedAt,
            schema_version: store.manifest.schemaVersion,
            research_items: store.items.length,
            projects: store.projects.length,
            publications: store.publications.length,
            youtube_videos: store.videos.length,
          },
        }
      : {}),
    ...(!store && startupError ? { error: "Data snapshot unavailable; check server logs." } : {}),
  };
}

/**
 * Build the HTTP request listener. `createMcpHandler` owns the era decision per
 * request: modern (2026-07-28) exchanges are served from the envelope, and
 * `legacy: 'stateless'` — the default — answers 2025-era traffic with a fresh
 * instance per request, so ChatGPT's connector and anything pinned to
 * 2025-11-25 keep working while new clients get `server/discover`.
 */
export function createHttpApp(opts: HttpAppOptions = {}) {
  const rateLimitPerMinute = opts.rateLimitPerMinute ?? config.rateLimitPerMinute;
  const keyOpts = { trustProxy: opts.trustProxy ?? config.trustProxy, proxyHops: opts.proxyHops ?? config.proxyHops };
  const limiter = createRateLimiter(rateLimitPerMinute, (req) => addressBucket(clientAddress(req, keyOpts)));
  const host = opts.host ?? config.httpHost;
  // The MCP Streamable HTTP specification requires Origin validation. Requests
  // without Origin (normal for server-to-server MCP clients) pass; browser
  // clients must use localhost or a hostname configured in AMIRA_ALLOWED_ORIGINS.
  // When bound to loopback, also apply the SDK's Host-header guard.
  const validateOrigin = originValidation(opts.allowedOriginHostnames ?? config.allowedOriginHostnames);
  const validateHost = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host) ? localhostHostValidation() : null;
  const mcpEntry = createMcpHandler(() => createAmiraServer({ openai: true }), { maxRequestBodySize: MAX_REQUEST_BYTES });
  const mcpHandler = toNodeHandler(mcpEntry, {
    maxRequestBodySize: MAX_REQUEST_BYTES,
    onerror: (err) => console.error("[amira] mcp handler error:", err),
  });

  const listener = (req: IncomingMessage, res: ServerResponse): void => {
    if ((validateHost && !validateHost(req, res)) || !validateOrigin(req, res)) return;
    const path = (req.url ?? "/").split("?")[0];
    setCors(res);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/" || path === "/healthz") {
      sendJson(res, currentStore() ? 200 : 503, healthBody(opts.startupError?.() ?? null));
      return;
    }
    if (path === MCP_PATH) {
      const retryAfter = limiter.check(req);
      if (retryAfter) {
        res.setHeader("Retry-After", String(retryAfter));
        sendJson(res, 429, {
          error: "rate limited",
          message: `More than ${rateLimitPerMinute} requests/minute from this client. Retry in ${retryAfter}s.`,
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
  };

  return { listener, close: () => mcpEntry.close(), limiter };
}
