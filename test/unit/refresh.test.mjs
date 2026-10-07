// Background refresh (src/data.ts): probe → crawl → atomic publish → hot swap,
// against a local node:http stub standing in for the Omeka S REST API.
//
// Config (live refresh, site base, intervals) is read ONCE at module load, so
// every scenario runs in its own child process with its own environment and a
// fresh stub. AMIRA_REFRESH_INTERVAL_HOURS=0 makes each child refresh exactly
// once, at startup, so no scenario depends on timer races. The child reports
// what it saw (store identity before/after, refresh status through the
// get_collection_overview tool) as one JSON line.
//
// stopBackgroundRefresh() is not exported from server/lib.js; the stdio entry
// (server/index.js) calls it when stdin ends, so the abort scenario drives that.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { childEnv, hermeticEnv, LIB_URL, REPO_ROOT, SERVER_STDIO, tempDir } from "../helpers/env.mjs";

hermeticEnv();
const lib = await import("../../server/lib.js");
const SCHEMA = lib.SNAPSHOT_SCHEMA_VERSION;

const FIXTURE_MAX_MODIFIED = buildFixture(SCHEMA).manifest.maxModified; // 2026-07-01
const REMOTE_MODIFIED = "2026-09-01T00:00:00+00:00";
const SETS_MODIFIED = "2026-08-15T00:00:00+00:00";

/** The /items queries crawlSnapshot issues, one per corpus (src/snapshot.ts). */
const CORPUS_QUERIES = ["resource_template_id=4", "resource_template_id=2", "resource_template_id=3", "resource_template_id=5",
  "resource_template_id=7", "resource_template_id=10", "item_set_id=29918", "resource_template_id=23", "resource_template_id=21",
  "resource_template_id=22", "item_set_id=39193", "item_set_id=19", "item_set_id=1852"];
/** What the stub serves per corpus query; everything else is empty. */
const CORPUS_ITEMS = {
  "resource_template_id=4": [{ "o:id": 7001, "o:title": "Refreshed, Person" }],
  "resource_template_id=10": [{ "o:id": 7002, "o:title": "Refreshed Item", "dcterms:type": [{ type: "literal", "@value": "Text" }] }],
};

/**
 * A minimal Omeka S API. `state.maxModified`/`state.total` drive the freshness
 * probe; `state.fail` answers that path with 404 (a permanent error, so no
 * retries); `state.hang` never answers that path and resolves `hung`.
 */
async function startStub(state) {
  const requests = [];
  let onHang;
  const hung = new Promise((resolve) => (onHang = resolve));
  const aborted = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    const entry = { path: url.pathname, params: url.searchParams };
    requests.push(entry);
    const reply = (body, total) => {
      res.writeHead(200, { "Content-Type": "application/json", Connection: "close",
        ...(total !== undefined ? { "Omeka-S-Total-Results": String(total) } : {}) });
      res.end(JSON.stringify(body));
    };
    if (state.hang === url.pathname) {
      res.on("close", () => { if (!res.writableEnded) aborted.push(entry); });
      onHang(entry);
      return; // never answered: only the client can end this exchange
    }
    if (state.fail === url.pathname) {
      res.writeHead(404, { "Content-Type": "application/json", Connection: "close" });
      res.end("{}");
      return;
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const probe = url.searchParams.get("sort_by") === "modified";
    switch (url.pathname) {
      case "/api/items": {
        if (probe) return reply([{ "o:id": 1, "o:modified": { "@value": state.maxModified } }], state.total);
        const query = CORPUS_QUERIES.find((q) => { const [k, v] = q.split("="); return url.searchParams.get(k) === v; });
        const items = page === 1 ? CORPUS_ITEMS[query] ?? [] : [];
        return reply(items, (CORPUS_ITEMS[query] ?? []).length);
      }
      case "/api/item_sets":
        if (probe) return reply([{ "o:id": 8001, "o:modified": { "@value": SETS_MODIFIED } }], 1);
        return reply(page === 1 ? [{ "o:id": 8001, "o:title": "Refreshed Set" }] : [], 1);
      case "/api/media":
        return reply([], 0);
      case "/api/properties":
        return reply(page === 1 ? [{ "o:term": "dcterms:title", "o:label": "Title" }] : []);
      default:
        res.writeHead(404, { Connection: "close" });
        res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, api: `${base}/api`, requests, hung, aborted,
    paths: () => requests.map((r) => r.path),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

/** A fixture snapshot that belongs to the stub's instance (the cache and the
 * bundled dir are partitioned by API base; a foreign snapshot is refused). */
async function writeFixture(stub, manifest = {}) {
  const dir = tempDir("refresh-data");
  const fx = buildFixture(SCHEMA);
  Object.assign(fx.manifest, { apiBase: stub.api, fetchedAt: new Date().toISOString() }, manifest);
  await lib.writeSnapshot(dir, fx);
  return dir;
}

const refreshEnv = (stub, dataDir, cacheDir, extra = {}) => childEnv({
  AMIRA_LIVE_REFRESH: "1", AMIRA_SITE_BASE: stub.base, AMIRA_DATA_DIR: dataDir, AMIRA_CACHE_DIR: cacheDir,
  AMIRA_REFRESH_INTERVAL_HOURS: "0", ...extra,
});

// The child: load, wait for the one startup refresh to settle, report.
const CHILD = `
const lib = await import(process.env.T_LIB);
const { connectInMemory } = await import(process.env.T_MCP);
const before = await lib.ensureStore();
const conn = await connectInMemory(lib);
let refresh;
for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
  refresh = (await conn.call("get_collection_overview")).refresh;
  if (refresh.last_attempt && !refresh.in_flight) break;
  await new Promise((r) => setTimeout(r, 20));
}
const after = lib.currentStore();
const overview = await conn.call("get_collection_overview");
const summary = (s) => ({ source: s.source, maxModified: s.manifest.maxModified, apiBase: s.manifest.apiBase,
  items: s.items.map((i) => i.title), persons: s.persons.map((p) => p.name) });
const out = { refresh, swapped: after !== before, ensureReturnsCurrent: (await lib.ensureStore()) === after,
  before: summary(before), after: summary(after), counts: overview.counts, data_snapshot: overview.data_snapshot };
await conn.close();
process.stdout.write(JSON.stringify(out) + "\\n"); // then exit naturally: nothing may be left running
`;

/** Run CHILD against `stub` and resolve its report plus its stderr log. */
async function runChild(stub, { manifest, env } = {}) {
  const dataDir = await writeFixture(stub, manifest);
  const cacheDir = tempDir("refresh-cache");
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD], {
    cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: refreshEnv(stub, dataDir, cacheDir, {
      T_LIB: LIB_URL, T_MCP: pathToFileURL(path.join(REPO_ROOT, "test", "helpers", "mcp.mjs")).href, ...env,
    }),
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
    child.once("exit", (c) => { clearTimeout(timer); resolve(c); });
  });
  assert.equal(code, 0, `child failed (${code}):\n${stderr}`);
  return { report: JSON.parse(stdout), stderr, cacheDir, cacheSnapshotDir: lib.snapshotCacheDir(cacheDir, stub.api) };
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test("a stale probe triggers a crawl that is published to the cache and hot-swapped in", { timeout: 20_000 }, async (t) => {
  const stub = await startStub({ maxModified: REMOTE_MODIFIED, total: 3 });
  t.after(() => stub.close());
  const { report, stderr, cacheSnapshotDir } = await runChild(stub);

  assert.equal(report.swapped, true, `currentStore() must be a new store:\n${stderr}`);
  assert.equal(report.ensureReturnsCurrent, true, "ensureStore() serves the swapped store");
  assert.deepEqual(report.before, { source: "bundled", maxModified: FIXTURE_MAX_MODIFIED, apiBase: stub.api,
    items: ["Yoruba Architecture Study", "Mosque Photograph Series", "Radio Interview Recording", "Cote d'Ivoire Field Notes"],
    persons: ["Beier, Ulli", "Fendler, Ute"] });
  assert.deepEqual(report.after, { source: "cache", maxModified: REMOTE_MODIFIED, apiBase: stub.api,
    items: ["Refreshed Item"], persons: ["Refreshed, Person"] });
  assert.equal(report.refresh.enabled, true);
  assert.equal(report.refresh.in_flight, false);
  assert.equal(report.refresh.error_class, null);
  assert.match(report.refresh.last_attempt, ISO);
  assert.match(report.refresh.last_success, ISO);
  assert.ok(report.refresh.last_success >= report.refresh.last_attempt);
  // Tools read the swapped store, not a reference captured before the swap.
  assert.equal(report.counts.research_items, 1);
  assert.equal(report.counts.persons, 1);
  assert.equal(report.data_snapshot.source, "cache");
  assert.equal(report.data_snapshot.max_modified, REMOTE_MODIFIED);
  assert.match(stderr, /snapshot stale \(local 2026-07-01T00:00:00\+00:00 < remote 2026-09-01T00:00:00\+00:00\)/);
  assert.match(stderr, /refreshed snapshot \(fetchedAt=.*, 1 research items\)/);

  // Every corpus was crawled in id order, plus sets, media and property labels.
  const crawled = stub.requests.filter((r) => r.path === "/api/items" && r.params.get("sort_by") === "id");
  assert.deepEqual(crawled.map((r) => CORPUS_QUERIES.find((q) => { const [k, v] = q.split("="); return r.params.get(k) === v; })).sort(),
    [...CORPUS_QUERIES].sort());
  for (const p of ["/api/properties", "/api/media", "/api/item_sets"]) assert.ok(stub.paths().includes(p), p);
  // The probe ran before and after the crawl, plus the startup probe.
  assert.equal(stub.requests.filter((r) => r.path === "/api/items" && r.params.get("sort_by") === "modified").length, 3);

  // The published generation is what was swapped in.
  assert.ok(await lib.readSnapshotPointer(cacheSnapshotDir), "an active generation pointer was written");
  const published = await lib.loadSnapshot(cacheSnapshotDir);
  assert.equal(published.manifest.maxModified, REMOTE_MODIFIED);
  assert.equal(published.manifest.totalItemsOnInstance, 3);
  assert.equal(published.manifest.itemSetsSignature, JSON.stringify([1, SETS_MODIFIED]));
  assert.equal(published.manifest.apiBase, stub.api);
  assert.equal(published.data.research_items[0].title, "Refreshed Item");
  assert.equal(published.data.item_sets[0].title, "Refreshed Set");
});

test("a failing crawl keeps serving the old store and records error_class", { timeout: 20_000 }, async (t) => {
  const stub = await startStub({ maxModified: REMOTE_MODIFIED, total: 3, fail: "/api/media" });
  t.after(() => stub.close());
  const { report, stderr, cacheSnapshotDir } = await runChild(stub);

  assert.equal(report.swapped, false, "the loaded store is kept");
  assert.deepEqual(report.after, report.before);
  assert.equal(report.after.source, "bundled");
  assert.deepEqual(report.refresh, { last_attempt: report.refresh.last_attempt, last_success: null,
    error_class: "refresh_failed", in_flight: false, enabled: true });
  assert.match(report.refresh.last_attempt, ISO);
  assert.equal(report.counts.research_items, 4);
  assert.match(stderr, /live refresh skipped: HTTP 404/);
  assert.doesNotMatch(stderr, /refreshed snapshot/);
  assert.ok(stub.paths().includes("/api/media"), "the crawl reached the failing endpoint");
  assert.equal(await lib.readSnapshotPointer(cacheSnapshotDir), null, "nothing was published");
});

test("a fresh probe skips the crawl and still records a success", { timeout: 20_000 }, async (t) => {
  const stub = await startStub({ maxModified: FIXTURE_MAX_MODIFIED, total: 25 });
  t.after(() => stub.close());
  const { report } = await runChild(stub, { manifest: { itemSetsSignature: JSON.stringify([1, SETS_MODIFIED]) } });

  assert.equal(report.swapped, false);
  assert.equal(report.after.source, "bundled");
  assert.equal(report.refresh.error_class, null);
  assert.match(report.refresh.last_success, ISO);
  // Probe only: the items and item-set freshness requests, nothing else.
  assert.deepEqual(stub.paths(), ["/api/items", "/api/item_sets"]);
});

test("an old snapshot is fully refreshed even when every probe signal matches", { timeout: 20_000 }, async (t) => {
  // fetchedAt three months back > AMIRA_FULL_REFRESH_HOURS (default 168 h).
  const stub = await startStub({ maxModified: FIXTURE_MAX_MODIFIED, total: 25 });
  t.after(() => stub.close());
  const { report } = await runChild(stub, {
    manifest: { itemSetsSignature: JSON.stringify([1, SETS_MODIFIED]), fetchedAt: "2026-07-05T00:00:00.000Z" },
  });
  assert.equal(report.swapped, true);
  assert.equal(report.after.source, "cache");
  assert.ok(stub.paths().includes("/api/properties"), "a full crawl ran");
});

test("isStale: an older snapshot schema is stale even when every signal matches", () => {
  const manifest = { ...buildFixture(SCHEMA).manifest, itemSetsSignature: "sig" };
  const probe = { maxModified: manifest.maxModified, totalItems: manifest.totalItemsOnInstance, itemSetsSignature: "sig" };
  assert.equal(lib.isStale(manifest, probe), false);
  assert.equal(lib.isStale({ ...manifest, schemaVersion: SCHEMA - 1 }, probe), true);
  assert.equal(lib.isStale({ ...manifest, itemSetsSignature: undefined }, probe), true, "a manifest without the set signature");
});

test("probeRemote reads both freshness signals from a real HTTP API", async (t) => {
  const stub = await startStub({ maxModified: REMOTE_MODIFIED, total: 42 });
  t.after(() => stub.close());
  assert.deepEqual(await lib.probeRemote(stub.api), {
    maxModified: REMOTE_MODIFIED, totalItems: 42, totalItemSets: 1, itemSetsSignature: JSON.stringify([1, SETS_MODIFIED]),
  });
  const failing = await startStub({ maxModified: REMOTE_MODIFIED, total: 42, fail: "/api/item_sets" });
  t.after(() => failing.close());
  await assert.rejects(lib.probeRemote(failing.api), /HTTP 404/);
});

test("stopping the server aborts an in-flight crawl (stdio entry, stdin closed)", { timeout: 20_000 }, async (t) => {
  const stub = await startStub({ maxModified: REMOTE_MODIFIED, total: 3, hang: "/api/properties" });
  t.after(() => stub.close());
  const dataDir = await writeFixture(stub);
  const child = spawn(process.execPath, [SERVER_STDIO], {
    windowsHide: true, stdio: ["pipe", "ignore", "pipe"], env: refreshEnv(stub, dataDir, tempDir("refresh-cache")),
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });

  const timeout = (ms, what) => new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} after ${ms} ms:\n${stderr}`)), ms).unref());
  await Promise.race([stub.hung, timeout(8_000, "the crawl never reached /api/properties")]);
  assert.equal(child.exitCode, null, "the server is still running mid-crawl");

  child.stdin.end(); // the stdio entry's stopBackgroundRefresh() trigger
  const exit = await Promise.race([exited, timeout(5_000, "the server did not stop")]);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(stub.aborted.length, 1, "the hanging crawl request was aborted by the client");
  assert.equal(stub.aborted[0].path, "/api/properties");
  assert.match(stderr, /live refresh skipped: .*abort/i);
  assert.doesNotMatch(stderr, /refreshed snapshot/);
});
