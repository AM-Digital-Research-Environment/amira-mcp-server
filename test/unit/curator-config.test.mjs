// Curator mode (#26): it fails closed. Every misconfiguration refuses to start
// (the real entry points, spawned), the key and tokens files parse strictly
// and their errors never quote a secret, the token generator prints a token
// once with the line to add, and data past the maximum staleness is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnv, hermeticEnv, REPO_ROOT, SERVER_HTTP, SERVER_STDIO, tempDir } from "../helpers/env.mjs";
import { spawnHttpServer } from "../helpers/mcp.mjs";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { startOmekaStub } from "../helpers/omeka-stub.mjs";

hermeticEnv();
const lib = await import("../../server/lib.js");

const secrets = tempDir("curator-config");
const IDENTITY = "cfgIdentityAAAAAAAAAAAAAAAAAAAAAA";
const CREDENTIAL = "cfgCredentialBBBBBBBBBBBBBBBBBBBB";
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, JSON.stringify({ key_identity: IDENTITY, key_credential: CREDENTIAL }));
const TOKEN = "amira_cur_config-test-token-0123456789abcdefghijkl";
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `carol ${createHash("sha256").update(TOKEN).digest("hex")}\n`);
const badKeyFile = path.join(secrets, "bad.key");
writeFileSync(badKeyFile, `key_identity=${IDENTITY}\n`);
const emptyTokens = path.join(secrets, "empty-tokens");
writeFileSync(emptyTokens, "# nobody yet\n");

const CURATOR = { AMIRA_ACCESS: "curator", AMIRA_OMEKA_KEY_FILE: keyFile, AMIRA_MCP_TOKENS_FILE: tokensFile, AMIRA_LIVE_REFRESH: "0" };

/** Run an entry point to completion; it must refuse before serving. */
function run(entry, env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: childEnv({ PORT: "0", HOST: "127.0.0.1", ...env }),
      windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${entry} did not exit:\n${stderr}`)); }, 10_000);
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const REFUSALS = [
  ["curator over HTTP without a key file", SERVER_HTTP, { ...CURATOR, AMIRA_OMEKA_KEY_FILE: "" }, /needs AMIRA_OMEKA_KEY_FILE/],
  ["curator over HTTP with a malformed key file", SERVER_HTTP, { ...CURATOR, AMIRA_OMEKA_KEY_FILE: badKeyFile }, /has no key_credential/],
  ["curator over HTTP with an unreadable key file", SERVER_HTTP, { ...CURATOR, AMIRA_OMEKA_KEY_FILE: path.join(secrets, "nope") }, /unreadable \(ENOENT\)/],
  ["curator over HTTP without a tokens file", SERVER_HTTP, { ...CURATOR, AMIRA_MCP_TOKENS_FILE: "" }, /needs AMIRA_MCP_TOKENS_FILE/],
  ["curator over HTTP with no valid token", SERVER_HTTP, { ...CURATOR, AMIRA_MCP_TOKENS_FILE: emptyTokens }, /holds no valid token/],
  ["curator over HTTP with a shared bearer token", SERVER_HTTP, { ...CURATOR, AMIRA_MCP_BEARER_TOKEN: "shared" }, /refused in curator mode/],
  ["curator over HTTP without an explicit cache directory", SERVER_HTTP, { ...CURATOR, AMIRA_CACHE_DIR: "" }, /AMIRA_CACHE_DIR set explicitly/],
  ["curator with a refresh slower than the staleness limit", SERVER_HTTP,
    { ...CURATOR, AMIRA_LIVE_REFRESH: "1", AMIRA_REFRESH_INTERVAL_HOURS: "48" }, /less than AMIRA_CURATOR_MAX_STALE_HOURS/],
  ["curator over stdio", SERVER_STDIO, CURATOR, /HTTP only/],
  ["curator fetch-data", path.join(REPO_ROOT, "server", "fetchCli.js"), CURATOR, /never runs in curator mode/],
  ["public HTTP holding a key", SERVER_HTTP, { AMIRA_OMEKA_KEY_FILE: keyFile }, /a public server never holds an Omeka key/],
  ["public stdio holding a key", SERVER_STDIO, { AMIRA_OMEKA_KEY_FILE: keyFile }, /a public server never holds an Omeka key/],
  ["public HTTP with a tokens file", SERVER_HTTP, { AMIRA_MCP_TOKENS_FILE: tokensFile }, /curator-mode setting/],
  ["an unknown access mode", SERVER_HTTP, { AMIRA_ACCESS: "curater" }, /must be "public" or "curator"/],
  ["curator with an absolute or keyed authentication probe", SERVER_HTTP,
    { ...CURATOR, AMIRA_CURATOR_AUTH_PROBE: "https://evil.example/items" }, /AMIRA_CURATOR_AUTH_PROBE must be an API path/],
];

for (const [name, entry, env, message] of REFUSALS) {
  test(`refuses to start: ${name}`, { timeout: 15_000 }, async () => {
    const { code, stderr, stdout } = await run(entry, env);
    assert.equal(code, 1, `exit code (stderr: ${stderr})`);
    assert.match(stderr, /\[amira\] refusing to start: /);
    assert.match(stderr, message);
    assert.ok(!/listening|running on|on http:\/\//.test(stderr), "nothing was served");
    for (const secret of [IDENTITY, CREDENTIAL, TOKEN]) assert.ok(!(stderr + stdout).includes(secret), "no secret in the refusal");
  });
}

test("a complete curator configuration passes the startup check", () => {
  const cfg = { ...lib.config, access: "curator", accessSetting: "curator", omekaKeyFile: keyFile, tokensFile, cacheDirConfigured: true,
    bearerTokenConfigured: false, liveRefresh: true, refreshIntervalHours: 1, curatorMaxStaleHours: 24 };
  assert.deepEqual(lib.accessConfigErrors("http", cfg), []);
  assert.deepEqual(lib.accessConfigErrors("http", { ...lib.config, omekaKeyFile: null, tokensFile: null }), [], "the default public setup");
});

test("key files: key=value lines or JSON; errors never quote the content", () => {
  assert.deepEqual(lib.parseOmekaKey(`# svc\nkey_identity = ${IDENTITY}\nkey_credential: "${CREDENTIAL}"\n`), { identity: IDENTITY, credential: CREDENTIAL });
  assert.deepEqual(lib.parseOmekaKey(JSON.stringify({ key_identity: IDENTITY, key_credential: CREDENTIAL })), { identity: IDENTITY, credential: CREDENTIAL });
  for (const bad of [`key_identity=${IDENTITY}`, `key_identity=${IDENTITY}\nkey_credential=has space`, `secret ${CREDENTIAL}`, "{not json"]) {
    assert.throws(() => lib.parseOmekaKey(bad), (err) => !err.message.includes(IDENTITY) && !err.message.includes(CREDENTIAL));
  }
});

test("tokens files: name and hash per line; malformed or repeated lines grant nothing", () => {
  const h = (s) => createHash("sha256").update(s).digest("hex");
  const { tokens, invalidLines } = lib.parseTokensFile([
    "# curators", "", `alice ${h("a")}`, `bob ${h("b").toUpperCase()}   # upper-case hex is fine`,
    `alice ${h("c")}`, `carol ${h("a")}`, "dave nothex", `bad/name ${h("d")}`, `erin ${h("e")} extra`,
  ].join("\n"));
  assert.deepEqual(tokens.map((t) => t.name), ["alice", "bob"]);
  assert.deepEqual(invalidLines, [5, 6, 7, 8, 9]);
});

test("the token store accepts exactly the listed tokens and follows the file", () => {
  const file = path.join(secrets, "store-tokens");
  const logs = [];
  writeFileSync(file, `carol ${lib.hashToken(TOKEN)}\n`);
  const store = lib.createTokenStore(file, { reloadMs: 0, log: (m) => logs.push(m) });
  assert.equal(store.check(`Bearer ${TOKEN}`), "carol");
  assert.equal(store.check(`bearer ${TOKEN}`), "carol", "the scheme is case-insensitive");
  for (const header of [undefined, "", TOKEN, `Basic ${TOKEN}`, `Bearer ${TOKEN}x`, "Bearer short"]) assert.equal(store.check(header), null);
  writeFileSync(file, "");
  assert.equal(store.check(`Bearer ${TOKEN}`), null, "revoked once the line is gone");
  writeFileSync(file, `carol ${lib.hashToken(TOKEN)}\n`);
  assert.equal(store.check(`Bearer ${TOKEN}`), "carol");
  assert.ok(logs.every((m) => !m.includes(TOKEN) && !m.includes(lib.hashToken(TOKEN))), "logs never quote a token or hash");
});

test("the token generator prints a 256-bit token once and the line to add", async () => {
  const { code, stdout } = await run(path.join(REPO_ROOT, "server", "tokenCli.js"), {}, ["dora"]);
  assert.equal(code, 0);
  const token = /\n {2}(amira_cur_[A-Za-z0-9_-]{43})\n/.exec(stdout)?.[1];
  assert.ok(token, stdout);
  assert.ok(stdout.includes(`\ndora ${lib.hashToken(token)}\n`), "the tokens-file line carries the token's SHA-256");
  assert.equal(stdout.split(token).length, 2, "the token is printed exactly once");
  assert.equal(Buffer.from(token.slice("amira_cur_".length), "base64url").length, 32);
  const refused = await run(path.join(REPO_ROOT, "server", "tokenCli.js"), {}, ["bad name"]);
  assert.equal(refused.code, 2);
});

// --- staleness ------------------------------------------------------------------------------------

/** A curator snapshot in the curator cache partition of a (never contacted) instance. */
async function curatorCache(fetchedAt) {
  const cacheDir = tempDir("curator-cache");
  const site = "http://curator.invalid";
  const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  Object.assign(fx.manifest, { apiBase: `${site}/api`, fetchedAt, access: "curator" });
  await lib.writeSnapshotAtomic(lib.snapshotCacheDir(cacheDir, `${site}/api`, "curator"), fx);
  return { cacheDir, site };
}

async function health(base) {
  const res = await fetch(`${base}/healthz`);
  return { status: res.status, body: await res.json() };
}

test("curator data unverified for longer than the maximum staleness is refused", { timeout: 30_000 }, async (t) => {
  const { cacheDir, site } = await curatorCache(new Date().toISOString());
  // 0.0005 h = 1.8 s: long enough to load and answer once, then the data lapses.
  const server = await spawnHttpServer({ env: { ...CURATOR, AMIRA_SITE_BASE: site, AMIRA_CACHE_DIR: cacheDir,
    AMIRA_CURATOR_MAX_STALE_HOURS: "0.0005" } });
  t.after(() => server.stop());
  await server.waitForLog(/loaded 4 research items/);
  assert.equal((await health(server.base)).status, 200);
  const call = () => fetch(`${server.base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json",
    Accept: "application/json, text/event-stream", Authorization: `Bearer ${TOKEN}`, "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_collection_overview", arguments: {} } }) });
  await new Promise((r) => setTimeout(r, 2500));
  const lapsed = await health(server.base);
  assert.equal(lapsed.status, 503);
  assert.equal(lapsed.body.status, "unavailable");
  const text = await (await call()).text();
  assert.match(text, /not verified against Omeka for more than/);
  assert.match(server.logs(), /audit curator=carol method=tools\/call tool=get_collection_overview/);
});

test("a curator cache older than the maximum staleness is never loaded", { timeout: 30_000 }, async (t) => {
  const { cacheDir, site } = await curatorCache(new Date(Date.now() - 25 * 3_600_000).toISOString());
  const server = await spawnHttpServer({ env: { ...CURATOR, AMIRA_SITE_BASE: site, AMIRA_CACHE_DIR: cacheDir } });
  t.after(() => server.stop());
  await server.waitForLog(/initial data load failed: curator snapshot unavailable: no curator snapshot recent enough/);
  const h = await health(server.base);
  assert.equal(h.status, 503);
  assert.equal(h.body.status, "unavailable");
  assert.equal(h.body.access, "curator");
});

// --- a key Omeka silently ignores, at startup -------------------------------------------------------
// Omeka serves an unknown key the anonymous data (HTTP 200). The stub does the
// same; this configuration's key is not the stub's, so it is "bogus" there.

/** Every file under `dir`, recursively (none when it does not exist). */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : [e.name]));
}

async function waitForHealth(base, status) {
  let h;
  for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
    h = await health(base);
    if (h.body.status === status) return h;
    await new Promise((r) => setTimeout(r, 100));
  }
  return h;
}

test("a bogus key at first start: refused, no corpus crawled, no curator snapshot written", { timeout: 30_000 }, async (t) => {
  const stub = await startOmekaStub();
  t.after(() => stub.close());
  const cacheDir = tempDir("bogus-cache");
  const server = await spawnHttpServer({ env: { ...CURATOR, AMIRA_LIVE_REFRESH: "1", AMIRA_SITE_BASE: stub.base, AMIRA_CACHE_DIR: cacheDir,
    AMIRA_ENRICHMENT_BASE: `${stub.base}/github`, AMIRA_SEMANTIC_RELEASE: "off" } });
  t.after(() => server.stop());
  await server.waitForLog(/initial data load failed: curator snapshot unavailable: Omeka key not accepted or lacks view-all/);
  assert.equal((await waitForHealth(server.base, "unavailable")).status, 503);
  assert.deepEqual(filesUnder(cacheDir), [], "nothing was written");
  assert.ok(stub.requests.some((r) => r.startsWith("/api/items?is_public=0&per_page=1&key_identity=")), "the probe ran");
  assert.ok(!stub.requests.some((r) => /resource_template_id=|item_set_id=/.test(r)), "no corpus was crawled");
  for (const secret of [IDENTITY, CREDENTIAL]) assert.ok(!server.logs().includes(secret));
});

test("a cached curator snapshot past the refresh interval is not trusted until the key is confirmed", { timeout: 30_000 }, async (t) => {
  const stub = await startOmekaStub();
  t.after(() => stub.close());
  const cacheDir = tempDir("probe-cache");
  const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  Object.assign(fx.manifest, { apiBase: stub.api, fetchedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), access: "curator" });
  const partition = lib.snapshotCacheDir(cacheDir, stub.api, "curator");
  await lib.writeSnapshotAtomic(partition, fx);
  assert.ok(filesUnder(partition).length > 0);
  // Live refresh off: only the startup probe contacts Omeka.
  const server = await spawnHttpServer({ env: { ...CURATOR, AMIRA_SITE_BASE: stub.base, AMIRA_CACHE_DIR: cacheDir } });
  t.after(() => server.stop());
  await server.waitForLog(/Omeka key not accepted or lacks view-all: dropped the in-memory snapshot and wiped the curator cache/);
  assert.equal((await waitForHealth(server.base, "unavailable")).status, 503);
  assert.equal(existsSync(partition), false, "the 2-hour-old cache was wiped, not served");
});
