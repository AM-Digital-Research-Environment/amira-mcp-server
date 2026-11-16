// Private records and the semantic layer (#26), plus two public-mode checks:
// the vectors come from the public API only, so a private record is never
// embedded, and the curator server must say so rather than "probably added
// since". Public mode: the ILAM full-text note keeps its wording, and the
// overview counts organisations that are neither institutions nor groups.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const DIMS = 768;
const ROWS = [[500, "research-items", 0], [501, "research-items", 10], [510, "publications", 20], [502, "research-items", 40]];
function release() {
  const bytes = new Uint8Array(ROWS.length * DIMS * 4);
  const view = new DataView(bytes.buffer);
  ROWS.forEach(([, , deg], row) => {
    view.setFloat32(row * DIMS * 4, Math.cos((deg * Math.PI) / 180), true);
    view.setFloat32((row * DIMS + 1) * 4, Math.sin((deg * Math.PI) / 180), true);
  });
  const manifest = {
    schemaVersion: 1, model: "google/embeddinggemma-2", dimensions: DIMS, dtype: "float32-le", normalization: "l2", count: ROWS.length,
    modelRevision: "914f7f8", taskPrefix: "task: sentence similarity | query: ", rowOrder: "ids.json", vectors: "vectors.f32",
    vectorsSha256: createHash("sha256").update(bytes).digest("hex"), generatedAt: "2026-11-06T08:04:17Z",
  };
  return { tag: "semantic-embeddings-v1-35", manifest, ids: ROWS.map(([id, type]) => ({ id, type, lowSignal: false, contentHash: "x" })), vectors: bytes };
}

test("a private record is reported as never embedded, apart from public records added since the build", async () => {
  const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  const template = fixture.data.research_items.find((it) => it.o_id === 500);
  fixture.data.research_items.push(
    { ...structuredClone(template), o_id: 598, dre_id: "abg-fx-0598", title: "Added Since Item" },
    { ...structuredClone(template), o_id: 599, dre_id: "abg-fx-0599", title: "Private Unembedded Item", visibility: "private" },
  );
  const semantic = await lib.computeNeighbours(lib.verifySemanticRelease(release()), fixture.data);
  const store = new lib.DataStore("cache", fixture.data, fixture.manifest, null, semantic);
  const index = lib.semanticIndex(store);
  assert.equal(lib.noNeighboursReason(index, 599), lib.PRIVATE_NOT_EMBEDDED);
  assert.match(lib.noNeighboursReason(index, 598), /probably added since/);
  const coverage = lib.semanticCoverage(store);
  assert.equal(coverage.private_not_embedded.research_item, 1);
  assert.equal(coverage.not_in_release.research_item, fixture.data.research_items.length - coverage.with_neighbours.research_item - 1);
  assert.equal(coverage.private_note, lib.PRIVATE_NOT_EMBEDDED);

  // Without private records (public mode) the coverage keeps its shape.
  const pub = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  const plain = lib.semanticCoverage(new lib.DataStore("cache", pub.data, pub.manifest, null,
    await lib.computeNeighbours(lib.verifySemanticRelease(release()), pub.data)));
  assert.equal(plain.private_not_embedded, undefined);
  assert.equal(plain.private_note, undefined);
});

test("public mode: the full-text neighbours note keeps its wording", () => {
  const note = lib.neighboursNote({ maps: { map: { model: { name: "m" }, counts: { withText: 2, shown: 1 } } } });
  assert.match(note, /which is private and never served here\./);
});

test("the overview counts organisations that are neither institutions nor groups", async (t) => {
  const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  fixture.data.organisations.push({ o_id: 299, name: "Fixture Funding Agency", kind: "organisation", part_of: [], latitude: null,
    longitude: null, wikidata: null });
  fixture.manifest.counts = Object.fromEntries(Object.entries(fixture.data).map(([k, v]) => [k, v.length]));
  await lib.writeSnapshot(dataDir, fixture);
  const conn = await connectInMemory(lib, {}, { name: "curator-semantic" });
  t.after(() => conn.close());
  const { counts } = await conn.call("get_collection_overview");
  // list_institutions lists the untyped organisation, so `institutions` counts it.
  assert.equal(counts.institutions + counts.groups, fixture.data.organisations.length);
  assert.equal(counts.other_organisations, undefined);
});
