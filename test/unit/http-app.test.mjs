// The Streamable HTTP application (src/httpApp.ts), driven IN-PROCESS: the
// exported listener mounted on node:http on an OS-chosen port. Covers what the
// child-process test (http.test.mjs) cannot reach cheaply: health shapes,
// CORS preflight, Origin/Host validation, routing, body limits, and the
// rate-limit key (proxy trust, forged X-Forwarded-For, IPv6 /64 buckets).
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
await lib.writeSnapshot(dataDir, fixture);
// NOTE: the store is deliberately NOT loaded yet — the first test observes
// /healthz before ensureStore() resolves.

const servers = new Set();
test.after(async () => {
  for (const s of servers) await s.close();
});

/** Mount createHttpApp(opts) on an ephemeral port. */
async function serve(opts = {}) {
  const app = lib.createHttpApp(opts);
  const server = createServer(app.listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle = {
    app,
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      servers.delete(handle);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await app.close();
    },
  };
  servers.add(handle);
  return handle;
}

/** One raw HTTP exchange (node:http, so Host and Origin can be set freely). */
function send(base, { method = "GET", path = "/healthz", headers = {}, body, chunks } = {}) {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = request(target, { method, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (chunks) for (const chunk of chunks) req.write(chunk);
    else if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_POST = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const postMcp = (base, headers = {}, body = "{}") => send(base, { method: "POST", path: "/mcp", headers: { ...JSON_POST, ...headers }, body });

// --- health -------------------------------------------------------------------------

test("/healthz is 503 'loading' before the snapshot loads, 'error' with a startup error", async () => {
  assert.equal(lib.currentStore(), null, "precondition: nothing has loaded the store yet");
  const loading = await serve();
  const res = await send(loading.base);
  assert.equal(res.status, 503);
  assert.equal(res.headers["content-type"], "application/json");
  assert.deepEqual(res.json, {
    name: "amira-mcp-server", version: res.json.version, status: "loading", transport: "streamable-http", mcp_endpoint: "/mcp",
    site: lib.config.siteBase, refresh: { last_attempt: null, last_success: null, error_class: null, in_flight: false, enabled: false },
  });
  const failed = await serve({ startupError: () => "ENOENT: no snapshot" });
  const err = await send(failed.base, { path: "/" });
  assert.equal(err.status, 503);
  assert.equal(err.json.status, "error");
  assert.equal(err.json.error, "Data snapshot unavailable; check server logs.", "the raw startup error is not leaked");
  assert.equal(err.json.data_snapshot, undefined);
});

test("/healthz and / report the loaded snapshot with 200", async () => {
  await lib.ensureStore();
  const { base } = await serve({ startupError: () => "stale error from a previous attempt" });
  for (const path of ["/healthz", "/", "/healthz?probe=1"]) {
    const res = await send(base, { path });
    assert.equal(res.status, 200, path);
    assert.match(res.json.version, /^\d+\.\d+\.\d+/);
    assert.deepEqual(res.json, {
      name: "amira-mcp-server", version: res.json.version, status: "ok", transport: "streamable-http", mcp_endpoint: "/mcp",
      site: lib.config.siteBase, refresh: { last_attempt: null, last_success: null, error_class: null, in_flight: false, enabled: false },
      data_snapshot: { source: "bundled", fetched_at: fixture.manifest.fetchedAt, schema_version: lib.SNAPSHOT_SCHEMA_VERSION,
        research_items: 4, projects: 2, publications: 2, youtube_videos: 2 },
    }, path);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
  }
});

// --- CORS, Origin, Host, routing ------------------------------------------------------

test("OPTIONS preflight answers 204 with both protocol revisions' headers", async () => {
  const { base } = await serve({ allowedOriginHostnames: lib.parseAllowedOriginHostnames("chatgpt.com") });
  for (const origin of [undefined, "https://chatgpt.com", "http://localhost:6274"]) {
    const res = await send(base, { method: "OPTIONS", path: "/mcp", headers: {
      ...(origin ? { Origin: origin } : {}), "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, mcp-method, mcp-name" } });
    assert.equal(res.status, 204, String(origin));
    assert.equal(res.text, "");
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(res.headers["access-control-allow-methods"], "GET, POST, DELETE, OPTIONS");
    const allowed = res.headers["access-control-allow-headers"].split(",").map((h) => h.trim().toLowerCase());
    for (const header of ["content-type", "accept", "authorization", "mcp-session-id", "mcp-protocol-version", "last-event-id",
      "mcp-method", "mcp-name", "x-mcp-header"]) {
      assert.ok(allowed.includes(header), `preflight allows ${header}`);
    }
    assert.equal(res.headers["access-control-expose-headers"], "Mcp-Session-Id");
    assert.equal(res.headers["access-control-max-age"], "86400");
  }
});

test("a disallowed or unparsable Origin is refused with 403 on every path; allowed origins pass", async () => {
  const { base } = await serve({ allowedOriginHostnames: lib.parseAllowedOriginHostnames("https://chatgpt.com") });
  for (const origin of ["https://evil.example", "https://chatgpt.com.evil.example", "null"]) {
    for (const req of [{ path: "/healthz" }, { method: "OPTIONS", path: "/mcp" }, { method: "POST", path: "/mcp", headers: JSON_POST, body: "{}" }]) {
      const res = await send(base, { ...req, headers: { ...req.headers, Origin: origin } });
      assert.equal(res.status, 403, `${origin} ${req.method ?? "GET"} ${req.path}`);
      assert.equal(res.json.jsonrpc, "2.0");
      assert.equal(res.json.error.code, -32000);
      assert.equal(res.json.id, null);
      assert.equal(res.headers["access-control-allow-origin"], undefined, "refusals carry no CORS grant");
    }
  }
  for (const origin of ["https://chatgpt.com", "http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:9000"]) {
    assert.equal((await send(base, { headers: { Origin: origin } })).status, 200, origin);
  }
});

test("bound to loopback, the Host header must be loopback too (DNS-rebinding guard)", async () => {
  const local = await serve({ host: "127.0.0.1" });
  for (const host of ["evil.example", "evil.example:80", "10.0.0.5"]) {
    const res = await send(local.base, { headers: { Host: host } });
    assert.equal(res.status, 403, host);
    assert.equal(res.json.error.code, -32000);
  }
  for (const host of ["localhost", "localhost:8787", "127.0.0.1", "[::1]:8787"]) {
    assert.equal((await send(local.base, { headers: { Host: host } })).status, 200, host);
  }
  // A public bind (behind a proxy) does not apply the loopback Host guard.
  const pub = await serve({ host: "0.0.0.0" });
  assert.equal((await send(pub.base, { headers: { Host: "amira.example.org" } })).status, 200);
});

test("unknown paths are 404 with the endpoint hint", async () => {
  const { base } = await serve();
  for (const req of [{ path: "/nope" }, { path: "/mcp/extra", method: "POST", headers: JSON_POST, body: "{}" }, { path: "/healthz/x" }]) {
    const res = await send(base, req);
    assert.equal(res.status, 404, req.path);
    assert.deepEqual(res.json, { error: "not found", mcp_endpoint: "/mcp" });
    assert.equal(res.headers["access-control-allow-origin"], "*");
  }
});

// --- body size ----------------------------------------------------------------------------

test("request bodies over 64 KiB are refused with 413, declared or chunked; 64 KiB exactly is not", async () => {
  const { base } = await serve({ rateLimitPerMinute: 0 });
  const declared = await postMcp(base, {}, " ".repeat(64 * 1024 + 1));
  assert.equal(declared.status, 413);
  assert.equal(declared.json.jsonrpc, "2.0");
  assert.equal(declared.json.error.code, -32000);
  assert.match(declared.json.error.message, /65536 bytes/);
  const chunked = await send(base, { method: "POST", path: "/mcp", headers: { ...JSON_POST, "Transfer-Encoding": "chunked" },
    chunks: Array.from({ length: 70 }, () => " ".repeat(1024)) });
  assert.equal(chunked.status, 413, "no Content-Length does not bypass the limit");
  const exact = await postMcp(base, {}, " ".repeat(64 * 1024));
  assert.notEqual(exact.status, 413, "the limit is inclusive");
});

// --- rate limiting ----------------------------------------------------------------------------

test("the request after the per-minute budget gets 429 with Retry-After; health is never limited", async () => {
  const { base, app } = await serve({ rateLimitPerMinute: 2 });
  for (let i = 0; i < 2; i++) assert.notEqual((await postMcp(base)).status, 429, `request ${i + 1}`);
  const limited = await postMcp(base);
  assert.equal(limited.status, 429);
  const retry = Number(limited.headers["retry-after"]);
  assert.ok(Number.isInteger(retry) && retry >= 1 && retry <= 60, `Retry-After ${limited.headers["retry-after"]}`);
  assert.deepEqual(limited.json, { error: "rate limited", message: `More than 2 requests/minute from this client. Retry in ${retry}s.` });
  assert.equal(limited.headers["access-control-allow-origin"], "*", "a browser client can read the 429");
  assert.equal((await send(base)).status, 200, "/healthz is outside the limiter");
  assert.equal((await send(base, { method: "OPTIONS", path: "/mcp" })).status, 204, "preflight is outside the limiter");
  assert.equal(app.limiter.size, 1);
});

test("without trustProxy every forwarded header is ignored: one bucket per socket peer", async () => {
  const { base, app } = await serve({ rateLimitPerMinute: 2, trustProxy: false });
  const statuses = [];
  for (let i = 0; i < 3; i++) {
    statuses.push((await postMcp(base, { "X-Forwarded-For": `198.51.100.${i}`, "X-Real-IP": `203.0.113.${i}` })).status);
  }
  assert.deepEqual(statuses.map((s) => s === 429), [false, false, true], `statuses ${statuses}`);
  assert.equal(app.limiter.size, 1);
});

test("with trustProxy a forged leftmost X-Forwarded-For hop cannot pick a fresh bucket; X-Real-IP wins", async () => {
  const { base } = await serve({ rateLimitPerMinute: 2, trustProxy: true, proxyHops: 1 });
  // nginx appends the address it saw: the client controls everything to its left.
  const forged = [];
  for (let i = 0; i < 3; i++) forged.push((await postMcp(base, { "X-Forwarded-For": `10.9.9.${i}, 192.0.2.7` })).status);
  assert.deepEqual(forged.map((s) => s === 429), [false, false, true], `forged leftmost hops share the rightmost bucket: ${forged}`);
  // A different real client (rightmost hop) has its own budget.
  assert.notEqual((await postMcp(base, { "X-Forwarded-For": "10.9.9.0, 192.0.2.8" })).status, 429);
  // X-Real-IP takes precedence over X-Forwarded-For.
  const real = [];
  for (let i = 0; i < 3; i++) real.push((await postMcp(base, { "X-Real-IP": "198.51.100.77", "X-Forwarded-For": `192.0.2.${100 + i}` })).status);
  assert.deepEqual(real.map((s) => s === 429), [false, false, true], `X-Real-IP keyed: ${real}`);
});

test("clientAddress: socket peer unless trusted; X-Real-IP, then the hop proxyHops from the right", () => {
  const req = (headers, remoteAddress = "10.0.0.1") => ({ headers, socket: { remoteAddress } });
  const untrusted = { trustProxy: false, proxyHops: 1 };
  const trusted = { trustProxy: true, proxyHops: 1 };
  const xff = "203.0.113.1, 198.51.100.2, 192.0.2.3";
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": xff, "x-real-ip": "192.0.2.50" }), untrusted), "10.0.0.1");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": xff, "x-real-ip": "192.0.2.50" }), trusted), "192.0.2.50");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": xff }), trusted), "192.0.2.3", "rightmost, never the client-supplied leftmost");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": xff }), { trustProxy: true, proxyHops: 2 }), "198.51.100.2");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": xff }), { trustProxy: true, proxyHops: 9 }), "10.0.0.1", "too few hops: socket peer");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": ["203.0.113.1", "192.0.2.3"] }), trusted), "192.0.2.3", "repeated headers join");
  assert.equal(lib.clientAddress(req({ "x-real-ip": ["192.0.2.1", "192.0.2.2"] }), trusted), "192.0.2.2", "last X-Real-IP");
  assert.equal(lib.clientAddress(req({ "x-real-ip": "not-an-ip", "x-forwarded-for": "192.0.2.9" }), trusted), "192.0.2.9", "invalid X-Real-IP falls through");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": "192.0.2.9, garbage" }), trusted), "10.0.0.1", "an invalid hop is not a key");
  assert.equal(lib.clientAddress(req({ "x-forwarded-for": " 2001:db8::1 " }), trusted), "2001:db8::1");
  assert.equal(lib.clientAddress({ headers: {}, socket: {} }, trusted), "unknown", "a destroyed socket has no address");
});

test("addressBucket: IPv4 as is, IPv4-mapped unwrapped, IPv6 by /64 prefix", () => {
  const b = lib.addressBucket;
  assert.equal(b("192.0.2.1"), "192.0.2.1");
  assert.equal(b("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(b("::FFFF:192.0.2.1"), "192.0.2.1");
  const prefix = "2001:db8:abcd:12::/64";
  for (const address of ["2001:db8:abcd:12::1", "2001:db8:abcd:12:ffff:ffff:ffff:ffff", "2001:0DB8:ABCD:0012:0000:0000:0000:0001",
    "2001:db8:abcd:12:1:2:3:4"]) {
    assert.equal(b(address), prefix, address);
  }
  assert.notEqual(b("2001:db8:abcd:13::1"), prefix, "the neighbouring /64 is another subscriber");
  assert.equal(b("fe80::1%eth0"), "fe80:0:0:0::/64", "zone index dropped");
  assert.equal(b("::1"), "0:0:0:0::/64");
  assert.equal(b("unknown"), "unknown");
});

test("IPv6 clients in one /64 share a rate-limit bucket through the app's own key", async () => {
  const app = lib.createHttpApp({ rateLimitPerMinute: 2, trustProxy: true });
  try {
    const req = (ip) => ({ headers: { "x-real-ip": ip }, socket: { remoteAddress: "10.0.0.1" } });
    assert.equal(app.limiter.check(req("2001:db8:1:2::a")), 0);
    assert.equal(app.limiter.check(req("2001:db8:1:2::b")), 0);
    assert.ok(app.limiter.check(req("2001:db8:1:2:dead:beef:0:1")) > 0, "third address in the same /64 is limited");
    assert.equal(app.limiter.check(req("2001:db8:1:3::a")), 0, "another /64 is not");
    assert.equal(app.limiter.size, 2);
  } finally {
    await app.close();
  }
});

test("createRateLimiter: fixed window, Retry-After seconds, bounded key set, 0 disables", () => {
  const limiter = lib.createRateLimiter(2, (req) => req.key);
  const t0 = 1_000_000;
  assert.equal(limiter.check({ key: "a" }, t0), 0);
  assert.equal(limiter.check({ key: "a" }, t0 + 1), 0);
  assert.equal(limiter.check({ key: "a" }, t0 + 1_500), 59, "ceil of the remaining window");
  assert.equal(limiter.check({ key: "a" }, t0 + 59_999), 1, "never 0 while limited");
  assert.equal(limiter.check({ key: "a" }, t0 + 60_000), 0, "a new window");

  // The key set is bounded: when full, expired buckets are swept first; if
  // none expired, a NEW client is refused rather than growing the map.
  const bounded = lib.createRateLimiter(1, (req) => req.key);
  for (let i = 0; i < 10_000; i++) bounded.check({ key: `k${i}` }, t0);
  assert.equal(bounded.size, 10_000);
  assert.equal(bounded.check({ key: "newcomer" }, t0 + 1), 60);
  assert.equal(bounded.size, 10_000, "the map did not grow");
  assert.equal(bounded.check({ key: "k1" }, t0 + 1), 60, "existing clients keep their own bucket");
  assert.equal(bounded.check({ key: "newcomer" }, t0 + 60_000), 0, "after the window, expired buckets are swept");
  assert.equal(bounded.size, 1);

  const off = lib.createRateLimiter(0, (req) => req.key);
  for (let i = 0; i < 5; i++) assert.equal(off.check({ key: "a" }, t0), 0);
  assert.equal(off.size, 0);
});

// --- a real MCP exchange --------------------------------------------------------------------

test("a modern (2026-07-28) client completes an exchange in-process, with the HTTP-only tools", async (t) => {
  const { base, app } = await serve({ rateLimitPerMinute: 1000 });
  const client = new Client({ name: "http-app-modern", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("search") && names.includes("fetch"), "search/fetch are served over HTTP");
  const fetched = await client.callTool({ name: "fetch", arguments: { id: "item:500" } });
  assert.equal(fetched.structuredContent.title, "Yoruba Architecture Study");
  const missing = await client.callTool({ name: "fetch", arguments: { id: "item:999999" } });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent, undefined, "errors stay text-only over HTTP too");
  assert.equal(JSON.parse(missing.content[0].text).error.code, "not_found");
  assert.equal(app.limiter.size, 1, "MCP traffic went through the limiter");
});
