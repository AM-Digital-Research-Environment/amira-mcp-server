// Snapshot-lifecycle invariants (the D9/D11 guarantees the 1.0 rewrite was
// built around): manifest-last validity, schema-version and count-mismatch
// rejection, atomic promotion, and the two-signal freshness comparison.
// All offline, against temp dirs, through the shipped server/lib.js.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  isStale,
  crawlSnapshot,
  loadSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  writeSnapshot,
  writeSnapshotAtomic,
  readSnapshotPointer,
  assertSnapshotSource,
  snapshotCacheDir,
  fetchJSON,
} from "../../server/lib.js";
import fsDefault from "node:fs/promises";
import { buildFixture } from "../fixtures/fixture-data.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "amira-snap-"));
}

test("write → load roundtrip preserves data and manifest", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  await writeSnapshot(dir, out);
  const loaded = await loadSnapshot(dir);
  assert.equal(loaded.manifest.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(loaded.data.research_items.length, out.data.research_items.length);
  assert.equal(loaded.data.journals.length, out.data.journals.length);
  assert.equal(loaded.data.publications[0].fulltext, out.data.publications[0].fulltext);
});

test("snapshots reject missing counts and duplicate identifiers", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  delete out.manifest.counts.persons;
  await writeSnapshot(dir, out);
  await assert.rejects(loadSnapshot(dir), /persons/);
  const duplicate = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  duplicate.data.persons[1].o_id = duplicate.data.persons[0].o_id;
  await writeSnapshot(dir, duplicate);
  await assert.rejects(loadSnapshot(dir), /duplicate Omeka ids/);
});

function mockCrawl(t, { changes = false, duplicates = false, missingTotal = false } = {}) {
  let probes = 0;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = new URL(url);
    requests.push(u);
    const isProbe = u.searchParams.get("sort_by") === "modified" && u.pathname.endsWith("/items");
    if (isProbe) probes++;
    const date = changes && probes > 1 ? "2026-09-10T00:00:00+00:00" : "2026-09-09T00:00:00+00:00";
    const body = isProbe ? [{ "o:id": 999, "o:modified": { "@value": date } }]
      : duplicates && u.searchParams.get("resource_template_id") === "4" ? [{ "o:id": 1 }, { "o:id": 1 }] : [];
    return new Response(JSON.stringify(body), { headers: missingTotal ? {} : {
      "omeka-s-total-results": String(isProbe ? 999 : body.length),
    } });
  });
  return requests;
}

test("freshness signature includes authorities outside the selected corpora", async (t) => {
  const requests = mockCrawl(t);
  const out = await crawlSnapshot("https://example.test/api");
  assert.equal(out.manifest.maxModified, "2026-09-09T00:00:00+00:00");
  assert.equal(isStale(out.manifest, { maxModified: out.manifest.maxModified, totalItems: 999 }), false);
  assert.ok(requests.filter((u) => u.searchParams.has("page") && u.pathname.endsWith("items"))
    .every((u) => u.searchParams.get("sort_by") === "id" && u.searchParams.get("sort_order") === "asc"));
  assert.ok(requests.some((u) => u.searchParams.get("item_set_id") === "29918" && !u.searchParams.has("resource_template_id")));
});

test("a changing upstream, duplicate pages or missing totals never become a snapshot", async (t) => {
  for (const [opts, message] of [
    [{ changes: true }, /changed during the crawl/],
    [{ duplicates: true }, /duplicate item ids/],
    [{ missingTotal: true }, /invalid item list or total-results/],
  ]) {
    await t.test(JSON.stringify(opts), async (sub) => {
      mockCrawl(sub, opts);
      await assert.rejects(crawlSnapshot("https://example.test/api"), message);
    });
  }
});

test("a snapshot with the wrong schema version is rejected", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSnapshot(dir, buildFixture(SNAPSHOT_SCHEMA_VERSION - 1));
  await assert.rejects(loadSnapshot(dir), /schema v/);
});

test("a corpus/manifest count mismatch is rejected (torn-write guard)", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  await writeSnapshot(dir, out);
  const tampered = [...out.data.persons, { o_id: 999, name: "Extra, Person", affiliations: [] }];
  await fs.writeFile(path.join(dir, "persons.json"), JSON.stringify(tampered));
  await assert.rejects(loadSnapshot(dir), /persons/);
});

test("a dir without manifest.json is not loadable (manifest written last)", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSnapshot(dir, buildFixture(SNAPSHOT_SCHEMA_VERSION));
  await fs.rm(path.join(dir, "manifest.json"));
  await assert.rejects(loadSnapshot(dir));
});

test("writeSnapshotAtomic promotes cleanly and leaves no staging dir", async (t) => {
  const parent = await tempDir();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dest = path.join(parent, "current");
  await writeSnapshotAtomic(dest, buildFixture(SNAPSHOT_SCHEMA_VERSION));
  const first = await loadSnapshot(dest);
  assert.equal(first.manifest.schemaVersion, SNAPSHOT_SCHEMA_VERSION);

  // A second promote replaces the first without leaving staging behind.
  const next = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  next.manifest.fetchedAt = "2026-07-06T00:00:00.000Z";
  await writeSnapshotAtomic(dest, next);
  const second = await loadSnapshot(dest);
  assert.equal(second.manifest.fetchedAt, "2026-07-06T00:00:00.000Z");
  const leftovers = (await fs.readdir(parent)).filter((n) => n.startsWith(".staging-"));
  assert.deepEqual(leftovers, []);
});

test("isStale: only a newer remote signal (either of the D11 pair) triggers", () => {
  const local = buildFixture(SNAPSHOT_SCHEMA_VERSION).manifest;
  assert.equal(isStale(local, { maxModified: local.maxModified, totalItems: local.totalItemsOnInstance }), false);
  assert.equal(isStale(local, { maxModified: "2026-07-04T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), true, "newer o:modified");
  assert.equal(isStale(local, { maxModified: local.maxModified, totalItems: local.totalItemsOnInstance + 1 }), true, "changed totals (covers deletions)");
  assert.equal(isStale(local, { maxModified: "2026-06-01T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), false, "older remote never refreshes");
  assert.equal(isStale({ ...local, maxModified: null }, { maxModified: "2026-01-01T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), true, "local without signal defers to remote");
});

test("snapshot provenance isolates overlapping IDs from different Omeka installations", () => {
  const manifest = buildFixture(SNAPSHOT_SCHEMA_VERSION).manifest;
  assert.doesNotThrow(() => assertSnapshotSource(manifest, `${manifest.apiBase}/`));
  assert.throws(() => assertSnapshotSource(manifest, "https://another.example/api"), /different Omeka instance/);
  assert.notEqual(snapshotCacheDir("cache", manifest.apiBase), snapshotCacheDir("cache", "https://another.example/api"));
  assert.notEqual(snapshotCacheDir("cache", "https://example.test/a/api"), snapshotCacheDir("cache", "https://example.test/b/api"));
});

test("failed promotion leaves the prior generation readable, and concurrent writers serialize", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const old = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  await writeSnapshotAtomic(dir, old);
  const pointer = await readSnapshotPointer(dir);
  const next = structuredClone(old);
  next.manifest.fetchedAt = "2026-10-02T00:00:00Z";
  const rename = fsDefault.rename;
  const mock = t.mock.method(fsDefault, "rename", async (from, to) => {
    if (path.basename(to) === "active.json") throw new Error("injected publication failure");
    return rename(from, to);
  });
  await assert.rejects(writeSnapshotAtomic(dir, next), /injected publication failure/);
  mock.mock.restore();
  assert.deepEqual(await readSnapshotPointer(dir), pointer);
  assert.equal((await loadSnapshot(dir)).manifest.fetchedAt, old.manifest.fetchedAt);
  const other = structuredClone(next);
  other.manifest.fetchedAt = "2026-10-03T00:00:00Z";
  other.data.persons[0].name = "Changed";
  await Promise.all([writeSnapshotAtomic(dir, next), writeSnapshotAtomic(dir, other)]);
  const loaded = await loadSnapshot(dir);
  assert.ok([next.manifest.fetchedAt, other.manifest.fetchedAt].includes(loaded.manifest.fetchedAt));
  assert.equal(loaded.data.persons[0].name, loaded.manifest.fetchedAt === other.manifest.fetchedAt ? "Changed" : old.data.persons[0].name);
  assert.ok((await readSnapshotPointer(dir)).previous.length <= 2);
  assert.equal((await fs.readdir(dir)).includes("writer.lock"), false);
  await writeSnapshotAtomic(dir, old);
  assert.equal((await loadSnapshot(dir)).manifest.fetchedAt, other.manifest.fetchedAt, "late older crawl cannot roll back the active snapshot");
});

test("refresh retries transient errors, rejects permanent errors and accepts cancellation", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return new Response("{}", { status: 404 }); });
  await assert.rejects(fetchJSON("https://example.test/api"), /HTTP 404/);
  assert.equal(requests, 1);
  t.mock.method(globalThis, "fetch", async () => { requests++; return requests === 2
    ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : new Response("[]"); });
  assert.deepEqual((await fetchJSON("https://example.test/api")).body, []);
  const ctrl = new AbortController();
  t.mock.method(globalThis, "fetch", async () => { ctrl.abort(); throw new TypeError("network failed"); });
  await assert.rejects(fetchJSON("https://example.test/api", ctrl.signal), /abort/i);
  assert.equal(isStale(buildFixture(SNAPSHOT_SCHEMA_VERSION).manifest,
    { maxModified: null, totalItems: 25, itemSetsSignature: "changed" }), true);
});
