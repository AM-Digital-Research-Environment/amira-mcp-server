// Curator mode (#26), hardening: the cache-directory check (the Docker image's
// default path must really be tmpfs), token rotation by appending, the key file
// (inline comments, a file that disappears), the probe setting, file-mode
// warnings, the HTTP port, failed authentications (rate-limited and logged),
// retired private duplicates in name lookups, and the relay's token bounds.
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { childEnv, hermeticEnv, SERVER_HTTP, tempDir } from "../helpers/env.mjs";
import { buildFixture } from "../fixtures/fixture-data.mjs";

hermeticEnv();
const secrets = tempDir("curator-hardening");
const IDENTITY = "hardIdentityAAAAAAAAAAAAAAAAAAAAA";
const CREDENTIAL = "hardCredentialBBBBBBBBBBBBBBBBBBB";
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${IDENTITY}\nkey_credential=${CREDENTIAL}\n`);
const TOKEN = "amira_cur_hardening-token-0123456789abcdefghijk";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `carol ${sha256(TOKEN)}\n`);
Object.assign(process.env, { AMIRA_ACCESS: "curator", AMIRA_OMEKA_KEY_FILE: keyFile, AMIRA_MCP_TOKENS_FILE: tokensFile });
const lib = await import("../../server/lib.js");

const curatorCfg = (extra = {}) => ({ ...lib.config, access: "curator", accessSetting: "curator", omekaKeyFile: keyFile, tokensFile,
  cacheDirConfigured: true, bearerTokenConfigured: false, liveRefresh: true, refreshIntervalHours: 1, curatorMaxStaleHours: 24, ...extra });

// --- the cache directory ---------------------------------------------------------------

const MOUNTS = [
  "overlay / overlay rw,relatime 0 0",
  "proc /proc proc rw 0 0",
  "tmpfs /dev/shm tmpfs rw 0 0",
  "/dev/sda1 /data ext4 rw 0 0",
  "tmpfs /data/private\\040cache tmpfs rw 0 0",
].join("\n");

test("filesystemOf: the longest mount point wins, escapes are decoded", () => {
  assert.equal(lib.filesystemOf("/tmp/amira-cache", MOUNTS), "overlay");
  assert.equal(lib.filesystemOf("/dev/shm/amira", MOUNTS), "tmpfs");
  assert.equal(lib.filesystemOf("/data/x", MOUNTS), "ext4");
  assert.equal(lib.filesystemOf("/data/private cache/x", MOUNTS), "tmpfs");
  assert.equal(lib.filesystemOf("/datax", MOUNTS), "overlay", "a mount point matches at a path boundary only");
  assert.equal(lib.filesystemOf("/x", ""), null);
});

test("the image's cache path is refused in curator mode unless it is a tmpfs mount (Linux)", () => {
  const linux = (mounts) => ({ platform: "linux", mounts: () => mounts, realpath: (d) => d });
  const image = curatorCfg({ cacheDir: lib.IMAGE_CACHE_DIR });
  const refused = lib.accessConfigErrors("http", image, linux(MOUNTS)).join("\n");
  assert.match(refused, /\/tmp\/amira-cache \(the image's cache path\) is on overlay, not tmpfs: start the container with --tmpfs/);
  assert.match(lib.accessConfigErrors("http", curatorCfg({ cacheDir: "/tmp/amira-cache/sub" }), linux(MOUNTS)).join("\n"), /not tmpfs/);
  assert.match(lib.accessConfigErrors("http", image, linux(null)).join("\n"), /on an unknown filesystem, not tmpfs/);
  assert.deepEqual(lib.accessConfigErrors("http", image, linux(`${MOUNTS}\ntmpfs /tmp/amira-cache tmpfs rw,mode=1777 0 0`)), []);
  assert.deepEqual(lib.accessConfigErrors("http", image, { platform: "darwin" }), [], "elsewhere the explicit-setting rule applies");
  // Not set explicitly (the image's AMIRA_DEFAULT_CACHE_DIR does not count): refused everywhere.
  assert.match(lib.accessConfigErrors("http", curatorCfg({ cacheDir: lib.IMAGE_CACHE_DIR, cacheDirConfigured: false }), { platform: "win32" }).join("\n"),
    /needs AMIRA_CACHE_DIR set explicitly.*default cache path does not count/);
  // Another directory on disk is a warning, not a refusal; public mode is never checked.
  const disk = curatorCfg({ cacheDir: "/data/amira" });
  assert.deepEqual(lib.accessConfigErrors("http", disk, linux(MOUNTS)), []);
  const quiet = { ...linux(MOUNTS), fileMode: () => 0o100600 };
  assert.match(lib.accessConfigWarnings(disk, quiet).join("\n"), /AMIRA_CACHE_DIR is on ext4, not tmpfs/);
  assert.deepEqual(lib.accessConfigWarnings(curatorCfg({ cacheDir: "/dev/shm/amira" }), quiet), []);
  assert.deepEqual(lib.accessConfigWarnings({ ...disk, access: "public" }, quiet), []);
});

test("an AMIRA_DEFAULT_CACHE_DIR alone is used as the cache but is not an explicit curator cache", { timeout: 15_000 }, async () => {
  const dir = path.join(tempDir("default-cache"), "c");
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    "const c = (await import(process.env.T_LIB)).config; console.log(JSON.stringify([c.cacheDir, c.cacheDirConfigured]))"],
  { env: { ...childEnv({ AMIRA_DEFAULT_CACHE_DIR: dir }), AMIRA_CACHE_DIR: "", T_LIB: new URL("../../server/lib.js", import.meta.url).href } });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((r) => child.once("exit", r));
  assert.deepEqual(JSON.parse(out), [path.resolve(dir), false]);
});

test("secret files readable by group or others are a warning on Linux", () => {
  const probe = (mode) => ({ platform: "linux", mounts: () => "tmpfs / tmpfs rw 0 0", realpath: (d) => d, fileMode: () => mode });
  const warnings = lib.accessConfigWarnings(curatorCfg({ cacheDir: "/run/amira" }), probe(0o100644));
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /AMIRA_OMEKA_KEY_FILE is readable by its group or by others \(mode 644\); restrict it/);
  assert.match(warnings[1], /AMIRA_MCP_TOKENS_FILE/);
  assert.deepEqual(lib.accessConfigWarnings(curatorCfg({ cacheDir: "/run/amira" }), probe(0o100600)), []);
  assert.deepEqual(lib.accessConfigWarnings(curatorCfg(), { platform: "win32" }), []);
});

// --- other startup checks ----------------------------------------------------------------

test("the authentication probe must be a list path: a single resource never returns an array", () => {
  for (const probe of ["items/123", "items/123?x=1", "/items", "https://evil.example/items", "items?key_identity=x"]) {
    assert.match(lib.accessConfigErrors("http", curatorCfg({ curatorAuthProbe: probe })).join("\n"), /AMIRA_CURATOR_AUTH_PROBE must be an API list path/, probe);
  }
  for (const probe of ["items?is_public=0&per_page=1", "media?is_public=0", "item_sets"]) {
    assert.deepEqual(lib.accessConfigErrors("http", curatorCfg({ curatorAuthProbe: probe })), [], probe);
  }
});

test("the HTTP port is validated", async () => {
  assert.equal(lib.parsePort("8787"), 8787);
  assert.equal(lib.parsePort("0"), 0);
  for (const bad of ["", "abc", "-1", "65536", "80.5", "1e3"]) assert.equal(lib.parsePort(bad), null, bad);
  assert.match(lib.accessConfigErrors("http", { ...curatorCfg(), access: "public", accessSetting: "public", omekaKeyFile: null, tokensFile: null,
    httpPort: Number.NaN, httpPortSetting: "80a" }).join("\n"), /PORT \/ AMIRA_HTTP_PORT must be an integer from 0 to 65535 \(got "80a"\)/);
  const child = spawn(process.execPath, [SERVER_HTTP], { env: childEnv({ PORT: "eighty", HOST: "127.0.0.1" }), windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((r) => child.once("exit", r));
  assert.equal(code, 1);
  assert.match(stderr, /refusing to start: PORT \/ AMIRA_HTTP_PORT must be an integer/);
});

// --- the tokens file ---------------------------------------------------------------------

test("a name on two lines grants nothing on either: rotating by appending cannot keep a leaked token", () => {
  const leaked = sha256("leaked"), fresh = sha256("fresh");
  const parsed = lib.parseTokensFile(`alice ${leaked}\nbob ${sha256("b")}\nalice ${fresh}\n`);
  assert.deepEqual(parsed.tokens.map((t) => t.name), ["bob"]);
  assert.deepEqual(parsed.invalidLines, [1, 3]);
  assert.deepEqual(parsed.repeatedNames, [{ name: "alice", lines: [1, 3] }]);
  const report = lib.describeTokens(parsed);
  assert.match(report, /name alice is on lines 1, 3: refusing every token for alice.*replacing the line, never by appending/);
  assert.ok(!report.includes(leaked) && !report.includes(fresh), "never a hash");

  const file = path.join(secrets, "rotate-tokens");
  writeFileSync(file, `carol ${sha256(TOKEN)}\ncarol ${sha256("new")}\n`);
  const logs = [];
  const store = lib.createTokenStore(file, { reloadMs: 0, log: (m) => logs.push(m) });
  assert.equal(store.check(`Bearer ${TOKEN}`), null, "the old (leaked) token no longer works");
  assert.match(logs.join("\n"), /name carol is on lines 1, 2/);
  writeFileSync(file, `carol ${sha256(TOKEN)}\n`);
  assert.equal(store.check(`Bearer ${TOKEN}`), "carol", "replacing the line restores it");
});

// --- the key file ------------------------------------------------------------------------

test("key files accept a `# comment` after a value, as the tokens file does", () => {
  assert.deepEqual(lib.parseOmekaKey(`key_identity=${IDENTITY}  # service account\nkey_credential: "${CREDENTIAL}"\t# rotated 2026-11\n`),
    { identity: IDENTITY, credential: CREDENTIAL });
  assert.deepEqual(lib.parseOmekaKey(`key_identity=${IDENTITY}#x\nkey_credential=${CREDENTIAL}\n`), { identity: `${IDENTITY}#x`, credential: CREDENTIAL },
    "a # with no space before it is part of the value");
});

test("a key file that stays unreadable fails closed after one re-read interval; a brief gap is transient", (t) => {
  mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-16T10:00:00Z") });
  t.after(() => {
    mock.timers.reset();
    writeFileSync(keyFile, `key_identity=${IDENTITY}\nkey_credential=${CREDENTIAL}\n`);
    lib.resetOmekaKeyCache();
  });
  lib.resetOmekaKeyCache();
  assert.equal(lib.omekaKey().identity, IDENTITY);
  rmSync(keyFile);
  mock.timers.tick(lib.KEY_TTL_MS); // due for a re-read
  assert.throws(() => lib.omekaKey(), (err) => err.keyFile === "transient" && !err.omekaAuth && /unreadable \(ENOENT\)/.test(err.message));
  mock.timers.tick(lib.KEY_TTL_MS / 2);
  assert.throws(() => lib.omekaKey(), (err) => err.keyFile === "transient" && !err.omekaAuth, "still within the interval");
  mock.timers.tick(lib.KEY_TTL_MS);
  assert.throws(() => lib.omekaKey(), (err) => err.omekaAuth === true && /treating the key as not accepted/.test(err.message) &&
    !err.message.includes(IDENTITY));
  // The file comes back (a rotation finished): accepted again, and the streak is reset.
  writeFileSync(keyFile, `key_identity=${IDENTITY}\nkey_credential=${CREDENTIAL}\n`);
  assert.equal(lib.omekaKey().identity, IDENTITY);
  writeFileSync(keyFile, "key_identity=only\n");
  mock.timers.tick(lib.KEY_TTL_MS);
  assert.throws(() => lib.omekaKey(), (err) => err.keyFile === "transient" && /has no key_credential/.test(err.message));
});

// --- failed authentications --------------------------------------------------------------

function send(base, headers = {}, target = "/mcp") {
  return new Promise((resolve, reject) => {
    const req = request(new URL(target, base), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
  });
}

test("failed authentications are logged one line each (never the token) and rate-limited per address", async (t) => {
  const audit = [];
  const app = lib.createHttpApp({ access: "curator", tokensFile, tokenReloadMs: 0, rateLimitPerMinute: 0, audit: (l) => audit.push(l) });
  const server = createServer(app.listener);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrong = "amira_cur_a-wrong-token-presented-by-a-client-000";

  assert.equal((await send(base)).status, 401);
  assert.equal((await send(base, { Authorization: `Bearer ${wrong}` })).status, 401);
  assert.equal((await send(base, { Authorization: "Basic abc" }, "/metrics")).status, 401);
  assert.deepEqual(audit.map((l) => l.replace(/client=\S+/, "client=X")), [
    "[amira] audit rejected=unauthorized client=X path=/mcp reason=no_token",
    "[amira] audit rejected=unauthorized client=X path=/mcp reason=unknown_token",
    "[amira] audit rejected=unauthorized client=X path=/metrics reason=malformed",
  ]);
  assert.match(audit[0], /client=127\.0\.0\.1 /);
  assert.ok(audit.every((l) => !l.includes(wrong) && !l.includes("abc")));

  let last;
  for (let i = 4; i <= lib.AUTH_FAILURES_PER_MINUTE; i++) last = await send(base, { Authorization: `Bearer ${wrong}` });
  assert.equal(last.status, 401, "within the budget");
  const limited = await send(base, { Authorization: `Bearer ${wrong}` });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.match(audit.at(-1), /limited=1$/);
  // A valid token from the same address is still served: only failures are limited.
  assert.equal((await send(base, { Authorization: `Bearer ${TOKEN}` }, "/metrics")).status, 200);
});

test("the failure log is capped, whatever the flood", async (t) => {
  const audit = [];
  const app = lib.createHttpApp({ access: "curator", tokensFile, tokenReloadMs: 0, rateLimitPerMinute: 0, audit: (l) => audit.push(l) });
  const server = createServer(app.listener);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (let i = 0; i < 60; i++) await send(base);
  assert.equal(audit.length, 30);
});

test("curator responses are never stored by intermediaries, and CORS reflects the validated Origin (#49)", async (t) => {
  const app = lib.createHttpApp({ access: "curator", tokensFile, tokenReloadMs: 0, rateLimitPerMinute: 0, audit: () => {} });
  const server = createServer(app.listener);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); await app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const browser = await send(base, { ...auth, Origin: "http://localhost:5173" }, "/metrics");
  assert.equal(browser.status, 200);
  assert.equal(browser.headers["cache-control"], "no-store");
  assert.equal(browser.headers["access-control-allow-origin"], "http://localhost:5173");
  assert.match(browser.headers.vary ?? "", /Origin/);
  const plain = await send(base, auth, "/metrics");
  assert.equal(plain.headers["access-control-allow-origin"], undefined, "no Origin, no CORS grant");
  assert.equal((await send(base, {}, "/mcp")).headers["cache-control"], "no-store", "a refusal is not stored either");

  const pub = lib.createHttpApp({ access: "public", rateLimitPerMinute: 0 });
  const publicServer = createServer(pub.listener);
  await new Promise((r) => publicServer.listen(0, "127.0.0.1", r));
  t.after(async () => { publicServer.closeAllConnections(); await new Promise((r) => publicServer.close(r)); await pub.close(); });
  const open = await send(`http://127.0.0.1:${publicServer.address().port}`, {}, "/metrics");
  assert.equal(open.headers["access-control-allow-origin"], "*", "public data keeps permissive CORS");
  assert.notEqual(open.headers["cache-control"], "no-store");
});

// --- name lookups ------------------------------------------------------------------------

test("a retired private duplicate never shadows the public authority of the same name", () => {
  const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  const publicOrg = fx.data.organisations[0];
  const publicPerson = fx.data.persons[0];
  // Merged duplicates: private, same name, higher ids (crawled after the canonical record).
  fx.data.organisations.push({ ...publicOrg, o_id: 9200, alt_names: [], visibility: "private" });
  fx.data.persons.push({ ...publicPerson, o_id: 9100, name: publicPerson.name.toUpperCase(), visibility: "private" });
  const store = new lib.DataStore("cache", fx.data, fx.manifest);
  assert.equal(store.getOrganisation(publicOrg.name).o_id, publicOrg.o_id);
  assert.equal(store.getPersonByName(publicPerson.name).o_id, publicPerson.o_id);

  // Private only: the private record is found. Two public records: the last wins, as before.
  const only = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  only.data.organisations.push({ ...only.data.organisations[1], o_id: 9300, name: "Hidden Group", visibility: "private" });
  only.data.organisations.push({ ...only.data.organisations[1], o_id: 9301, name: "Twin" }, { ...only.data.organisations[1], o_id: 9302, name: "Twin" });
  const s2 = new lib.DataStore("cache", only.data, only.manifest);
  assert.equal(s2.getOrganisation("Hidden Group").o_id, 9300);
  assert.equal(s2.getOrganisation("Twin").o_id, 9302);
});

// --- the relay's token bounds ------------------------------------------------------------

test("the relay accepts exactly the token lengths the server accepts", () => {
  const at = (n) => `a${"b".repeat(n - 1)}`;
  assert.equal(lib.normalizeCuratorToken(at(lib.MAX_TOKEN_LENGTH)).length, lib.MAX_TOKEN_LENGTH);
  assert.throws(() => lib.normalizeCuratorToken(at(lib.MAX_TOKEN_LENGTH + 1)), /malformed/);
  assert.throws(() => lib.normalizeCuratorToken(at(lib.MIN_TOKEN_LENGTH - 1)), /malformed/);
  const file = path.join(secrets, "long-tokens");
  writeFileSync(file, `long ${sha256(at(lib.MAX_TOKEN_LENGTH))}\n`);
  const store = lib.createTokenStore(file, { reloadMs: 0, log: () => {} });
  assert.equal(store.check(`Bearer ${at(lib.MAX_TOKEN_LENGTH)}`), "long");
  assert.equal(lib.truncateForLog(`a\n${"x".repeat(400)}`, 10), "a xxxxxxxx… [392 more characters]");
});
