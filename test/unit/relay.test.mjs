// Curator relay (#26): the stdio server with AMIRA_CURATOR_TOKEN forwards to a
// curator server over Streamable HTTP and serves nothing of its own.
//
// The remote is a real curator-mode server, in this process, over the Omeka
// stub (as in curator.test.mjs); the relay is the shipped server/index.js,
// spawned over stdio as Claude Desktop runs it. A raw fake server covers what
// the curator server does not exercise: progress notifications, the headers the
// relay sends, a 5xx and a cancellation. Checked: the remote's tools,
// instructions and serverInfo come through unchanged; a private record comes
// through; a bad or revoked token and an unreachable server give clear errors
// and never public data; the token is in no log line and nothing is cached; an
// empty or unsubstituted token is public mode; a non-local http URL, a
// malformed token, HTTP mode and AMIRA_ACCESS=curator are refused at startup.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { childEnv, hermeticEnv, SERVER_STDIO, tempDir } from "../helpers/env.mjs";
import { expectedToolNames, readManifest } from "../helpers/mcp.mjs";
import { IDS, KEY, PRIVATE, startOmekaStub } from "../helpers/omeka-stub.mjs";
import { buildFixture } from "../fixtures/fixture-data.mjs";

hermeticEnv();
const secrets = tempDir("relay-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const ALICE = "amira_cur_alice-relay-token-0123456789abcdefghijklmno";
const BOGUS = "amira_cur_not-a-valid-token-0123456789abcdefghijklmn";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `alice ${sha256(ALICE)}\n`);

const stub = await startOmekaStub();
test.after(() => stub.close());
const SITE = "https://amira.example";
Object.assign(process.env, {
  AMIRA_ACCESS: "curator",
  AMIRA_SITE_BASE: SITE,
  AMIRA_API_BASE: stub.api,
  AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile,
  AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
  AMIRA_SEMANTIC_RELEASE: "off",
});
const lib = await import("../../server/lib.js");
await lib.refreshNow();

// The curator server the relay forwards to.
const app = lib.createHttpApp({ rateLimitPerMinute: 0, tokenReloadMs: 0, audit: () => {} });
const httpServer = createServer(app.listener);
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const REMOTE = `http://127.0.0.1:${httpServer.address().port}/mcp`;
test.after(async () => {
  httpServer.closeAllConnections();
  await new Promise((r) => httpServer.close(r));
  await app.close();
});

// A public fixture snapshot for the children that must serve public data.
const publicData = tempDir("relay-public-data");
await lib.writeSnapshotAtomic(publicData, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

/** Everything every relay child wrote to stderr, for the token check. */
const stderrLog = [];
const cacheDirs = [];

/** Spawn server/index.js with `env` and connect a client over stdio. */
async function stdioClient(env, clientOptions = {}) {
  const cacheDir = tempDir("relay-cache");
  if ((env.AMIRA_CURATOR_TOKEN ?? "").startsWith("amira_cur_")) cacheDirs.push(cacheDir);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_STDIO],
    env: childEnv({ AMIRA_CACHE_DIR: cacheDir, ...env }),
    stderr: "pipe",
  });
  const entry = { text: "" };
  stderrLog.push(entry);
  transport.stderr.on("data", (chunk) => (entry.text += chunk));
  const client = new Client({ name: "relay-test", version: "0.0.0" }, clientOptions);
  const handle = { client, transport, stderr: () => entry.text, close: () => client.close().catch(() => {}) };
  test.after(handle.close);
  return handle;
}

/** A direct client of the curator server, to compare against. */
async function directClient(token) {
  const client = new Client({ name: "relay-direct", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(REMOTE), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  test.after(() => client.close());
  return client;
}

/** Run server/index.js to exit (stdin closed at once); for the startup refusals. */
function runToExit(env) {
  const r = spawnSync(process.execPath, [SERVER_STDIO], { env: childEnv(env), input: "", encoding: "utf8", timeout: 30_000 });
  stderrLog.push({ text: r.stderr });
  return r;
}

const textOf = (result) => result.content?.[0]?.text ?? "";
const relayEnv = (token = ALICE, url = REMOTE) => ({ AMIRA_CURATOR_TOKEN: token, AMIRA_CURATOR_URL: url });

test("relay: the client sees the curator server as it is — tools, instructions, serverInfo, capabilities, prompts", async () => {
  const direct = await directClient(ALICE);
  const relay = await stdioClient(relayEnv());
  await relay.client.connect(relay.transport);
  assert.deepEqual(relay.client.getServerVersion(), direct.getServerVersion());
  // The icon Claude shows over the app's views: an inline PNG it accepts (64-128 px, under 10 KB).
  const [icon] = direct.getServerVersion().icons;
  assert.equal(icon.mimeType, "image/png");
  assert.match(icon.src, /^data:image\/png;base64,/);
  const png = Buffer.from(icon.src.slice(icon.src.indexOf(",") + 1), "base64");
  assert.ok(png.length < 10_240, `${png.length} bytes`);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [96, 96], "IHDR width and height");
  assert.ok(JSON.stringify(direct.getServerVersion()).length < 16_000, "Claude drops a larger serverInfo");
  assert.deepEqual(relay.client.getServerCapabilities(), direct.getServerCapabilities());
  assert.equal(relay.client.getInstructions(), lib.curatorInstructions());
  assert.ok(relay.client.getInstructions().startsWith("CURATOR MODE"));
  const [viaRelay, viaDirect] = [await relay.client.listTools(), await direct.listTools()];
  assert.deepEqual(viaRelay, viaDirect, "the remote tool list, unchanged");
  assert.ok(viaRelay.tools.some((t) => t.name === "search"), "the hosted surface (with the OpenAI adapter), not the local one");
  assert.deepEqual(await relay.client.listPrompts(), await direct.listPrompts());
  assert.deepEqual(await relay.client.listResourceTemplates(), await direct.listResourceTemplates());
  assert.match(relay.stderr(), /relaying stdio to the curator server at http:\/\/127\.0\.0\.1:\d+\/mcp/);
});

test("relay: a private record, its restricted values and a private export come through", async () => {
  const relay = await stdioClient(relayEnv());
  await relay.client.connect(relay.transport);
  const item = JSON.parse(textOf(await relay.client.callTool({ name: "get_research_item", arguments: { id: IDS.privateItem } })));
  assert.equal(item.title, PRIVATE.itemTitle);
  assert.equal(item.visibility, "private");
  assert.equal(item.admin_url, `${SITE}/admin/item/${IDS.privateItem}`);
  const pub = JSON.parse(textOf(await relay.client.callTool({ name: "get_research_item", arguments: { id: IDS.publicItem, include_fulltext: true } })));
  assert.equal(pub.restricted.security_level, PRIVATE.security);
  assert.match(pub.restricted.fulltext, new RegExp(PRIVATE.fulltext));
  const csv = await relay.client.readResource({ uri: lib.exportUri("research_items", "csv", { keyword: PRIVATE.fulltext }) });
  assert.match(csv.contents[0].text, new RegExp(`^${IDS.publicItem},`, "m"), "found by its curator-only full text");
});

test("relay: a 2026-era client goes through as well (server/discover and enveloped requests)", async () => {
  const relay = await stdioClient(relayEnv(), { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await relay.client.connect(relay.transport);
  const item = JSON.parse(textOf(await relay.client.callTool({ name: "get_research_item", arguments: { id: IDS.privateItem } })));
  assert.equal(item.title, PRIVATE.itemTitle);
});

test("relay: a bad token is a clear initialize error, never public data", async () => {
  const relay = await stdioClient(relayEnv(BOGUS));
  await assert.rejects(relay.client.connect(relay.transport), (err) => {
    assert.match(err.message, /curator token rejected or revoked \(HTTP 401\)/);
    assert.match(err.message, /extension settings, or clear it for the public dataset/);
    assert.ok(!err.message.includes(BOGUS));
    return true;
  });
  assert.match(relay.stderr(), /initialize failed: AMIRA curator relay: curator token rejected or revoked/);
});

test("relay: a token revoked mid-session fails the next call clearly; no fallback", async (t) => {
  const relay = await stdioClient(relayEnv());
  await relay.client.connect(relay.transport);
  await relay.client.listTools();
  writeFileSync(tokensFile, "# alice revoked\n");
  t.after(() => writeFileSync(tokensFile, `alice ${sha256(ALICE)}\n`));
  await assert.rejects(relay.client.callTool({ name: "get_research_item", arguments: { id: IDS.publicItem } }), /curator token rejected or revoked/);
  await assert.rejects(relay.client.listTools(), /curator token rejected or revoked/);
});

test("relay: an unreachable curator server is a clear error, never public data", async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const relay = await stdioClient({ ...relayEnv(ALICE, `http://127.0.0.1:${port}/mcp`), AMIRA_DATA_DIR: publicData });
  await assert.rejects(relay.client.connect(relay.transport), /cannot reach the curator server at http:\/\/127\.0\.0\.1:\d+\/mcp \(ECONNREFUSED\).*No public data/s);
});

test("relay: an empty or unsubstituted token is public mode, unchanged", async () => {
  const expected = expectedToolNames();
  for (const token of ["", "  ", "${user_config.curator_token}"]) {
    const relay = await stdioClient({ AMIRA_CURATOR_TOKEN: token, AMIRA_CURATOR_URL: "${user_config.curator_url}", AMIRA_DATA_DIR: publicData });
    await relay.client.connect(relay.transport);
    const names = (await relay.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...expected].sort(), `token ${JSON.stringify(token)}`);
    assert.ok(!relay.client.getInstructions().startsWith("CURATOR MODE"));
    const missing = JSON.parse(textOf(await relay.client.callTool({ name: "get_research_item", arguments: { id: IDS.privateItem } })));
    assert.ok(missing.error, "the private record does not exist in public mode");
    assert.match(relay.stderr(), /running on stdio/);
    assert.ok(!relay.stderr().includes("relaying"));
    await relay.close();
  }
});

test("startup refusals: non-local http, credentials in the URL, a malformed token, HTTP mode and curator access", () => {
  for (const url of ["http://example.org/curator/mcp", "http://10.0.0.5/mcp", "ftp://localhost/mcp", "https://user:pw@example.org/mcp", "not a url"]) {
    const r = runToExit(relayEnv(ALICE, url));
    assert.equal(r.status, 1, url);
    assert.match(r.stderr, /refusing to start: AMIRA_CURATOR_URL/, url);
    assert.ok(!r.stderr.includes("pw@"), "credentials are never quoted");
  }
  for (const url of ["http://localhost:1/mcp", "http://127.0.0.1:1/mcp", "https://example.org/curator/mcp"]) {
    assert.equal(lib.curatorUrlError(url), null, url);
  }
  const malformed = runToExit(relayEnv("short token"));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /AMIRA_CURATOR_TOKEN is malformed/);
  assert.ok(!malformed.stderr.includes("short token"));

  const base = { ...lib.config, access: "public", accessSetting: "public", omekaKeyFile: null, tokensFile: null, curatorRelay: true, curatorUrl: REMOTE };
  assert.deepEqual(lib.accessConfigErrors("stdio", base), []);
  assert.match(lib.accessConfigErrors("http", base).join("\n"), /AMIRA_CURATOR_TOKEN \(the curator relay\) is for the stdio server/);
  assert.match(lib.accessConfigErrors("fetch", base).join("\n"), /is for the stdio server/);
  const curator = lib.accessConfigErrors("stdio", { ...lib.config, curatorRelay: true, curatorUrl: REMOTE });
  assert.match(curator.join("\n"), /AMIRA_CURATOR_TOKEN and AMIRA_ACCESS=curator exclude each other/);
  const r = runToExit({ ...relayEnv(), AMIRA_ACCESS: "curator" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exclude each other/);
});

test("manifest: an optional, masked curator token and the curator URL reach the server as AMIRA_CURATOR_*", () => {
  const manifest = readManifest();
  const { curator_token: token, curator_url: url } = manifest.user_config;
  assert.equal(token.type, "string");
  assert.equal(token.sensitive, true, "masked in the settings and kept in the OS keychain");
  assert.equal(token.required, false);
  assert.equal(token.default, "", "empty by default: public mode");
  assert.equal(url.default, lib.config.curatorUrl);
  assert.equal(lib.curatorUrlError(url.default), null);
  assert.equal(manifest.server.mcp_config.env.AMIRA_CURATOR_TOKEN, "${user_config.curator_token}");
  assert.equal(manifest.server.mcp_config.env.AMIRA_CURATOR_URL, "${user_config.curator_url}");
});

test("token helpers: a pasted Bearer prefix is dropped, redaction catches the token and any bearer value", () => {
  assert.equal(lib.normalizeCuratorToken(`  Bearer ${ALICE}\n`), ALICE);
  assert.throws(() => lib.normalizeCuratorToken("abc def ghi jkl mno"), (err) => !err.message.includes("abc"));
  assert.equal(lib.redactToken(`x ${ALICE} y`, ALICE), "x [redacted] y");
  assert.equal(lib.redactToken("Authorization: Bearer something-else", ALICE), "Authorization: Bearer [redacted]");
  const url = new URL("https://curator.example/curator/mcp");
  assert.equal(lib.describeRelayError(Object.assign(new Error("x"), { status: 403 }), url).reason, "unauthorized");
  assert.equal(lib.describeRelayError(Object.assign(new Error("x"), { status: 502 }), url).reason, "http_error");
  assert.equal(lib.describeRelayError(new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }), url).reason, "unreachable");
});

// --- a fake remote for notifications, headers, errors and cancellation -----------

async function startFake() {
  const seen = { posts: [], aborted: [] };
  const server = createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      seen.posts.push({ method: msg.method, headers: req.headers });
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      };
      if (msg.method === "initialize") {
        reply({
          protocolVersion: msg.params.protocolVersion,
          capabilities: { tools: { listChanged: true }, logging: {} },
          serverInfo: { name: "fake-curator", version: "9.9.9" },
          instructions: "FAKE CURATOR",
        });
      } else if (msg.method === "tools/list") {
        reply({ tools: ["slow", "boom", "hang", "redirect", "portal", "notjson", "silent"].map((name) => ({ name, inputSchema: { type: "object" } })) });
      } else if (msg.method === "tools/call" && msg.params.name === "redirect") {
        res.writeHead(302, { Location: "https://login.example.invalid/portal" }).end();
      } else if (msg.method === "tools/call" && msg.params.name === "portal") {
        res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body>Sign in to the hotel Wi-Fi</body></html>");
      } else if (msg.method === "tools/call" && msg.params.name === "notjson") {
        res.writeHead(200, { "Content-Type": "application/json" }).end("<html>not json</html>");
      } else if (msg.method === "tools/call" && msg.params.name === "silent") {
        // An event stream that ends without the answer.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "bye" } })}\n\n`);
      } else if (msg.method === "tools/call" && msg.params.name === "slow") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const event = (m) => res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        const progressToken = msg.params._meta?.progressToken;
        event({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken, progress: 1, total: 2, message: "half" } });
        event({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "from the fake" } });
        // The SDK client dispatches notifications a tick after responses: give
        // the notifications a head start, as a real tool's work would.
        setTimeout(() => {
          event({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "done" }] } });
          res.end();
        }, 100);
      } else if (msg.method === "tools/call" && msg.params.name === "boom") {
        res.writeHead(502, { "Content-Type": "text/plain" }).end(`upstream echoed Bearer ${ALICE}`);
      } else if (msg.method === "tools/call" && msg.params.name === "hang") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        res.on("close", () => seen.aborted.push(msg.id));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, seen };
}

test("relay (fake remote): progress and logging notifications, the auth and version headers, a 5xx, a cancellation", async () => {
  const fake = await startFake();
  const relay = await stdioClient(relayEnv(ALICE, fake.url));
  const logged = [];
  relay.client.setNotificationHandler("notifications/message", (n) => void logged.push(n.params.data));
  await relay.client.connect(relay.transport);
  assert.equal(relay.client.getServerVersion().name, "fake-curator");
  assert.equal(relay.client.getInstructions(), "FAKE CURATOR");
  assert.deepEqual(relay.client.getServerCapabilities(), { tools: { listChanged: true }, logging: {} });

  const progress = [];
  const done = await relay.client.callTool({ name: "slow", arguments: {} }, { onprogress: (p) => progress.push(p) });
  assert.equal(textOf(done), "done");
  assert.deepEqual(progress, [{ progress: 1, total: 2, message: "half" }]);
  assert.deepEqual(logged, ["from the fake"]);

  const posts = fake.seen.posts;
  assert.ok(posts.every((p) => p.headers.authorization === `Bearer ${ALICE}`), "every request carries the token");
  const init = posts.find((p) => p.method === "initialize");
  assert.equal(init.headers["mcp-protocol-version"], undefined);
  const call = posts.find((p) => p.method === "tools/call");
  assert.match(call.headers["mcp-protocol-version"] ?? "", /^\d{4}-\d{2}-\d{2}$/, "the negotiated version rides on later requests");
  assert.ok(posts.some((p) => p.method === "notifications/initialized"));

  await assert.rejects(relay.client.callTool({ name: "boom", arguments: {} }), (err) => {
    assert.match(err.message, /answered HTTP 502/);
    assert.ok(!err.message.includes(ALICE));
    return true;
  });
  await new Promise((r) => setTimeout(r, 100)); // the deferred onerror line, had there been one
  assert.equal(relay.stderr().split("\n").filter((l) => l.includes("502")).length, 1, `the failure is logged once:\n${relay.stderr()}`);
  assert.ok(!relay.stderr().includes("upstream echoed"), "the upstream body never reaches the log");

  const controller = new AbortController();
  const pending = relay.client.callTool({ name: "hang", arguments: {} }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await assert.rejects(pending);
  for (let i = 0; i < 50 && !fake.seen.aborted.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.seen.aborted.length, 1, "the cancellation aborted the request's HTTP exchange");
  assert.ok(posts.some((p) => p.method === "notifications/cancelled"), "and was forwarded too");
});

test("relay (fake remote): a redirect, a captive portal, a non-JSON body and a stream ending without an answer", async () => {
  const fake = await startFake();
  const relay = await stdioClient(relayEnv(ALICE, fake.url));
  await relay.client.connect(relay.transport);
  const fails = (name, pattern) => assert.rejects(relay.client.callTool({ name, arguments: {} }), (err) => {
    assert.match(err.message, pattern, name);
    assert.match(err.message, /No public data is served in its place/);
    return true;
  });
  await fails("redirect", /answered HTTP 302 \(it redirected; check the curator URL\)/);
  await fails("portal", /answered, but not with an MCP response \(a captive portal/);
  await fails("notjson", /answered, but not with an MCP response/);
  await fails("silent", /closed the response without answering/);
  assert.ok(!relay.stderr().includes("hotel Wi-Fi"), "a portal page never reaches the log");
});

test("relay (fake remote): a request the server never answers gets the relay's own timeout", async () => {
  const fake = await startFake();
  const relay = await stdioClient({ ...relayEnv(ALICE, fake.url), AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS: "1" });
  await relay.client.connect(relay.transport);
  const started = Date.now();
  await assert.rejects(relay.client.callTool({ name: "hang", arguments: {} }),
    /did not answer within 1 s \(AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS\)\. No public data/);
  assert.ok(Date.now() - started < 10_000);
  for (let i = 0; i < 50 && !fake.seen.aborted.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.seen.aborted.length, 1, "the timed-out exchange is aborted");
});

test("relay: stdin closing with a request in flight shuts the relay down and aborts the request", async () => {
  const fake = await startFake();
  const child = spawn(process.execPath, [SERVER_STDIO], { env: childEnv({ AMIRA_CACHE_DIR: tempDir("relay-cache"), ...relayEnv(ALICE, fake.url) }),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((r) => child.once("exit", r));
  const line = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  line({ jsonrpc: "2.0", method: "notifications/initialized" });
  line({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "hang", arguments: {} } });
  for (let i = 0; i < 100 && !fake.seen.posts.some((p) => p.method === "tools/call"); i++) await new Promise((r) => setTimeout(r, 50));
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  const code = await exited;
  clearTimeout(timer);
  assert.equal(code, 0, stderr);
  for (let i = 0; i < 50 && !fake.seen.aborted.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.seen.aborted.length, 1, "the pending exchange was aborted");
  assert.ok(!stderr.includes(ALICE));
});

test("relay: a client reusing an id in flight aborts the older exchange; only the newer request answers (#55)", async () => {
  const fake = await startFake();
  const child = spawn(process.execPath, [SERVER_STDIO], { env: childEnv({ AMIRA_CACHE_DIR: tempDir("relay-cache"), ...relayEnv(ALICE, fake.url) }),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((r) => child.once("exit", r));
  const line = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const answers = () => stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.id === 7);
  line({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
  line({ jsonrpc: "2.0", method: "notifications/initialized" });
  line({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "hang", arguments: {} } });
  for (let i = 0; i < 100 && !fake.seen.posts.some((p) => p.method === "tools/call"); i++) await new Promise((r) => setTimeout(r, 50));
  line({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "slow", arguments: {} } });
  for (let i = 0; i < 100 && !answers().length; i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 200)); // a late second answer would arrive here
  // Checked before stdin closes: shutting the relay down would abort it anyway.
  const abortedWhileRunning = fake.seen.aborted.includes(7);
  child.stdin.end();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
  assert.deepEqual(answers().map((m) => m.result?.content?.[0]?.text ?? m.error?.message), ["done"], stderr);
  assert.ok(abortedWhileRunning, "the displaced exchange was aborted when its id was reused");
});

test("the token appears in no relay's stderr, an upstream body echoing it is never logged, and no relay writes a cache", async () => {
  // Self-contained: its own relay, against the fake remote whose 502 body echoes the token.
  const fake = await startFake();
  const relay = await stdioClient(relayEnv(ALICE, fake.url));
  await relay.client.connect(relay.transport);
  await assert.rejects(relay.client.callTool({ name: "boom", arguments: {} }));
  await relay.client.listTools();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(!relay.stderr().includes(ALICE));
  assert.ok(cacheDirs.length > 0);
});

// Every relay child spawned in this file, whichever tests ran: no token in any
// stderr, and every relay cache dir still empty.
test.after(() => {
  for (const { text } of stderrLog) {
    for (const secret of [ALICE, BOGUS]) assert.ok(!text.includes(secret), `stderr leaked a token:\n${text}`);
  }
  for (const dir of cacheDirs) assert.deepEqual(readdirSync(dir), [], `relay cache ${dir} stays empty`);
});
