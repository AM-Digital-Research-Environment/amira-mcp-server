// Which semantic neighbours a server serves when the snapshots it can read
// disagree: a newer cache written by a server older than 1.33.0 (or while
// GitHub was unreachable) carries none, the bundled snapshot does. Before the
// fix the newer cache won outright and every semantic tool reported
// "semantic_unavailable" until the next upstream change.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir, cacheDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);

/** A minimal stored neighbour set: 500 ↔ 501, optionally with a one-group map. */
function neighbours(tag, { clusters = false } = {}) {
  return lib.parseSemanticNeighbours({
    source: {
      repository: lib.SEMANTIC_SOURCE.repository, tag, model: "google/embeddinggemma-2", model_revision: "r1",
      dimensions: 768, generated_at: "2026-11-06T08:04:17Z", vectors_sha256: "0".repeat(64), neighbours_per_type: 10,
    },
    low_signal: [],
    neighbours: { 500: [501, 9000], 501: [500, 9000] },
    ...(clusters ? { clusters: { algorithm: "spherical-kmeans", seed: 1, iterations: 3, members: [[500, 501]] } } : {}),
  });
}

const V35 = neighbours("semantic-embeddings-v1-35", { clusters: true });
const V36_NO_MAP = neighbours("semantic-embeddings-v1-36");
const loaded = (source, semantic, fetchedAt) => ({
  source,
  out: { ...fixture, manifest: { ...fixture.manifest, fetchedAt }, semantic },
});
const OLD = "2026-11-06T13:11:24.966Z";
const NEW = "2026-11-07T09:33:49.712Z";

test("servableSemantic honours AMIRA_SEMANTIC_RELEASE: off, a pinned build, or any build", () => {
  assert.equal(lib.servableSemantic(V35, "off"), null);
  assert.equal(lib.servableSemantic(V35, "semantic-embeddings-v1-36"), null);
  assert.equal(lib.servableSemantic(V35, "semantic-embeddings-v1-35"), V35);
  assert.equal(lib.servableSemantic(V35, "latest"), V35);
  assert.equal(lib.servableSemantic(null, "latest"), null);
});

test("pickSemantic prefers a set with the semantic map, then the newest build", () => {
  assert.equal(lib.pickSemantic([null, null]), null);
  assert.equal(lib.pickSemantic([null, V35]), V35);
  assert.equal(lib.pickSemantic([V36_NO_MAP, V35]), V35);
  const v34 = neighbours("semantic-embeddings-v1-34", { clusters: true });
  assert.equal(lib.pickSemantic([v34, V35]), V35);
  assert.equal(lib.pickSemantic([V35, v34]), V35);
});

test("a newer cache without neighbours still serves the bundled ones, and its identity names them", () => {
  const cache = loaded("cache", null, NEW);
  const store = lib.chooseInitial(cache, loaded("bundled", V35, OLD), "latest");
  assert.equal(store.source, "cache");
  assert.equal(store.manifest.fetchedAt, NEW);
  assert.equal(store.semantic, V35);
  assert.equal(store.manifest.semanticNeighbours.tag, "semantic-embeddings-v1-35");
  assert.notEqual(lib.snapshotId(store.manifest), lib.snapshotId(cache.out.manifest));
  // Neighbours stored by 1.33.0 (no map) give way to a set that has one.
  assert.equal(lib.chooseInitial(loaded("cache", V36_NO_MAP, NEW), loaded("bundled", V35, OLD), "latest").semantic, V35);
  // Only one snapshot readable: it is served as it is.
  assert.equal(lib.chooseInitial(null, loaded("bundled", V35, OLD), "latest").semantic, V35);
  assert.equal(lib.chooseInitial(null, null, "latest"), null);
});

test("the setting is honoured whichever snapshot is read: off serves none, a pin serves only its build", () => {
  const off = lib.chooseInitial(loaded("cache", V35, NEW), loaded("bundled", V35, OLD), "off");
  assert.equal(off.semantic, null);
  assert.equal(off.manifest.semanticNeighbours, undefined);
  const pinned = lib.chooseInitial(loaded("cache", V36_NO_MAP, NEW), loaded("bundled", V35, OLD), "semantic-embeddings-v1-36");
  assert.equal(pinned.semantic, V36_NO_MAP);
  assert.equal(lib.chooseInitial(loaded("cache", null, NEW), loaded("bundled", V35, OLD), "semantic-embeddings-v1-40").semantic, null);
});

test("an unreadable neighbours file costs the semantic tools, not the snapshot; the writer stays strict", async () => {
  const dir = path.join(cacheDir, "torn");
  await mkdir(dir, { recursive: true });
  await lib.writeSnapshot(dir, { ...fixture, semantic: V35 });
  await writeFile(path.join(dir, "semantic_neighbours.json"), "{ not json");
  const tolerant = await lib.loadSnapshot(dir);
  assert.equal(tolerant.semantic, null);
  assert.equal(tolerant.manifest.semanticNeighbours, undefined);
  assert.equal(tolerant.data.research_items.length, fixture.data.research_items.length);
  await assert.rejects(lib.loadSnapshot(dir, { strict: true }), /semantic_neighbours\.json/);
});

// --- end to end: the state found on a v1.33.0 install --------------------------------------

// Bundled: older, with neighbours stored before 1.34.0 (no map). Cache: newer, none.
await lib.writeSnapshot(dataDir, { ...fixture, semantic: V36_NO_MAP });
await lib.writeSnapshotAtomic(lib.snapshotCacheDir(cacheDir, fixture.manifest.apiBase),
  { ...fixture, manifest: { ...fixture.manifest, fetchedAt: NEW }, semantic: null });

const conn = await connectInMemory(lib, {}, { name: "semantic-fallback" });
test.after(() => conn.close());

test("get_similar_items answers from the bundled neighbours while the newer cache is served", async () => {
  const store = await lib.ensureStore();
  assert.equal(store.source, "cache");
  const similar = await conn.call("get_similar_items", { id: 500 });
  assert.equal(similar.error, undefined);
  assert.deepEqual(similar.results.map((r) => r.omeka_id), [501]);
  assert.equal(similar.space.release, "semantic-embeddings-v1-36");
});

test("get_semantic_map says the neighbours lack a map, not that no release exists", async () => {
  const map = await conn.call("get_semantic_map");
  assert.equal(map.error.code, "semantic_unavailable");
  assert.match(map.error.message, /without a semantic map; get_similar_items works/);
  assert.equal(map.error.suggested_tool, "get_similar_items");
});
