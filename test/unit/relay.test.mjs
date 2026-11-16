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
import { spawnSync } from "node:child_process";
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
        reply({ tools: ["slow", "boom", "hang"].map((name) => ({ name, inputSchema: { type: "object" } })) });
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

  const controller = new AbortController();
  const pending = relay.client.callTool({ name: "hang", arguments: {} }, { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await assert.rejects(pending);
  for (let i = 0; i < 50 && !fake.seen.aborted.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(fake.seen.aborted.length, 1, "the cancellation aborted the request's HTTP exchange");
  assert.ok(posts.some((p) => p.method === "notifications/cancelled"), "and was forwarded too");
});

// Last: every relay child has run.
test("the token appears in no stderr line, and no relay wrote a cache", async () => {
  for (const { text } of stderrLog) {
    for (const secret of [ALICE, BOGUS]) assert.ok(!text.includes(secret), `stderr leaked a token:\n${text}`);
  }
  assert.ok(stderrLog.some(({ text }) => text.includes("[redacted]")), "the 5xx body that echoed the token was redacted");
  assert.ok(cacheDirs.length >= 6);
  for (const dir of cacheDirs) assert.deepEqual(readdirSync(dir), [], `relay cache ${dir} stays empty`);
});
