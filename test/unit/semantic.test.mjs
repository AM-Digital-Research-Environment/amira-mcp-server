// Corpus vectors (#12, phase 1): release verification, the neighbour
// computation, the snapshot round trip, and get_similar_items.
//
// A synthetic release of 768-d unit vectors whose angles in one plane fix
// every cosine, so each expected order can be read off the table below. It
// holds rows the snapshot does not: 9999 (a deleted record, the closest of all
// to 500) and a `persons` row (an unknown type). Neither may ever surface.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const TAG = "semantic-embeddings-v1-35";
const DIMS = 768;
// [id, producer type, angle in degrees, lowSignal]
const ROWS = [
  [500, "research-items", 0, false],
  [9999, "research-items", 5, false], // deleted since the build: closest to 500, must never surface
  [503, "research-items", 1, true], // low-signal: neither source nor neighbour
  [501, "research-items", 10, false],
  [510, "publications", 20, false],
  [300, "projects", 30, false],
  [502, "research-items", 40, false],
  [540, "youtube", 60, false],
  [530, "podcasts", 80, false],
  [400, "sections", 90, false],
  [100, "persons", 2, false], // a type this server does not embed
];
const cos = (deg) => Math.round(Math.cos((deg * Math.PI) / 180) * 10_000) / 10_000;

function release({ edit = (r) => r, tag = TAG } = {}) {
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
  const ids = ROWS.map(([id, type, , lowSignal]) => ({ id, type, lowSignal, contentHash: "x" }));
  return edit({ tag, manifest, ids, vectors: bytes });
}

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const verified = lib.verifySemanticRelease(release());
const semantic = await lib.computeNeighbours(verified, fixture.data);
await lib.writeSnapshot(dataDir, { ...fixture, semantic });

const conn = await connectInMemory(lib, {}, { name: "semantic" });
const { call } = conn;
test.after(async () => {
  delete process.env.AMIRA_EXPOSURE;
  await conn.close();
});
const url = (id) => lib.itemUrl(id);
const ids = (result) => result.results.map((r) => r.omeka_id);

// --- verification -------------------------------------------------------------------

test("a release that disagrees with its manifest or with the accepted space is refused", () => {
  const verify = (edit) => () => lib.verifySemanticRelease(release({ edit }));
  assert.throws(verify((r) => ({ ...r, manifest: { ...r.manifest, model: "google/embeddinggemma-300m" } })), /model/);
  assert.throws(verify((r) => ({ ...r, manifest: { ...r.manifest, dimensions: 512 } })), /dimensions/);
  assert.throws(verify((r) => ({ ...r, manifest: { ...r.manifest, normalization: "none" } })), /normalization/);
  assert.throws(verify((r) => ({ ...r, manifest: { ...r.manifest, count: ROWS.length + 1 } })), /ids\.json has/);
  assert.throws(verify((r) => ({ ...r, ids: [...r.ids.slice(1), r.ids[1]] })), /duplicate/);
  assert.throws(verify((r) => ({ ...r, vectors: r.vectors.slice(4) })), /bytes/);
  assert.throws(verify((r) => { const v = r.vectors.slice(); v[5] ^= 1; return { ...r, vectors: v }; }), /checksum/);
  assert.throws(verify((r) => {
    // Correct checksum, wrong content: a row that is not unit length.
    const v = r.vectors.slice(); new DataView(v.buffer).setFloat32(0, 2, true);
    return { ...r, vectors: v, manifest: { ...r.manifest, vectorsSha256: createHash("sha256").update(v).digest("hex") } };
  }), /L2-normalised/);
  assert.throws(verify((r) => ({ ...r, tag: "v2.49.1" })), /not a corpus-vector release tag/);
});

// --- the computation ------------------------------------------------------------------

test("neighbours are ranked by cosine, skip low-signal rows, and never cite a record the snapshot lacks", () => {
  const flat = semantic.neighbours["500"];
  const pairs = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1] / 10_000]);
  assert.deepEqual(pairs, [[501, cos(10)], [510, cos(20)], [300, cos(30)], [502, cos(40)], [540, cos(60)], [530, cos(80)], [400, cos(90)]]);
  const cited = Object.values(semantic.neighbours).flatMap((f) => f.filter((_, i) => i % 2 === 0));
  for (const absent of [9999, 503, 100]) {
    assert.ok(!cited.includes(absent), `${absent} cited`);
    assert.equal(semantic.neighbours[String(absent)], undefined, `${absent} is a source`);
  }
  assert.deepEqual(semantic.low_signal, [503]);
  assert.deepEqual(semantic.source, { repository: lib.SEMANTIC_SOURCE.repository, tag: TAG, model: "google/embeddinggemma-2",
    model_revision: "914f7f8", dimensions: DIMS, generated_at: "2026-11-06T08:04:17Z", vectors_sha256: verified.manifest.vectorsSha256,
    neighbours_per_type: lib.NEIGHBOURS_PER_TYPE });
});

test("the per-type cap keeps the best of EACH type, so a types filter stays exact", async () => {
  const capped = await lib.computeNeighbours(verified, fixture.data, { perType: 1 });
  const flat = capped.neighbours["500"];
  // 502 (research item, 40°) is dropped: 501 is the better research item.
  assert.deepEqual(flat.filter((_, i) => i % 2 === 0), [501, 510, 300, 540, 530, 400]);
});

// --- the snapshot round trip ------------------------------------------------------------

test("the neighbours round-trip through the snapshot, and a mismatched manifest does not load", async () => {
  const { manifest, semantic: loaded } = await lib.loadSnapshot(dataDir);
  assert.deepEqual(manifest.semanticNeighbours, { repository: lib.SEMANTIC_SOURCE.repository, tag: TAG, model: "google/embeddinggemma-2",
    generated_at: "2026-11-06T08:04:17Z", sources: Object.keys(semantic.neighbours).length });
  assert.deepEqual(loaded, semantic);
  // The space is part of the snapshot's identity.
  const { semanticNeighbours: _space, ...plain } = manifest;
  assert.notEqual(lib.snapshotId(manifest), lib.snapshotId(plain));

  const dir = tempDir("amira-semantic-");
  await lib.writeSnapshot(dir, { ...fixture, semantic });
  const manifestPath = path.join(dir, "manifest.json");
  const onDisk = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...onDisk, semanticNeighbours: { ...onDisk.semanticNeighbours, tag: "semantic-embeddings-v1-1" } }));
  await assert.rejects(lib.loadSnapshot(dir), /semantic_neighbours\.json/);
});

test("a stored list naming a record the snapshot no longer holds is filtered at load", () => {
  const stale = structuredClone(semantic);
  stale.neighbours["500"] = [9999, 9990, ...stale.neighbours["500"]];
  stale.neighbours["9999"] = [500, 9990];
  const store = new lib.DataStore("bundled", fixture.data, fixture.manifest, null, stale);
  const index = lib.semanticIndex(store);
  assert.equal(index.neighbours.has(9999), false);
  assert.deepEqual(index.neighbours.get(500).map((n) => n.record.o_id), [501, 510, 300, 502, 540, 530, 400]);
  assert.equal(lib.semanticIndex(new lib.DataStore("bundled", fixture.data, fixture.manifest)), null);
});

// --- get_similar_items --------------------------------------------------------------------

const SPACE = { release: TAG, model: "google/embeddinggemma-2", generated_at: "2026-11-06T08:04:17Z" };
const ref = (id, type, title) => ({ id: String(id), omeka_id: id, type, title, amira_url: url(id) });

// What 500 (Architecture, Islam; Lagos → Nigeria; Beier; Fixture Art Worlds)
// shares with each neighbour, beyond wording (phase 2). Sections never count.
const NEIGHBOURS_OF_500 = [
  { ...ref(501, "research_item", "Mosque Photograph Series"), score: cos(10), basis: "shared_metadata",
    shared: { subjects: ["Islam"], places: ["Nigeria"], project: ["Fixture Art Worlds"] } },
  { ...ref(510, "publication", "Decolonial Architecture Futures"), score: cos(20), basis: "shared_metadata",
    shared: { subjects: ["Architecture"] } },
  { ...ref(300, "project", "Fixture Art Worlds"), score: cos(30), basis: "shared_metadata",
    shared: { people: ["Beier, Ulli"], project: ["Fixture Art Worlds"] } },
  // Another project, place and person: similar wording and nothing else.
  { ...ref(502, "research_item", "Radio Interview Recording"), score: cos(40), basis: "wording_only" },
  { ...ref(540, "video", "A Fixture Lecture"), score: cos(60), basis: "shared_metadata", shared: { people: ["Beier, Ulli"] } },
];

test("get_similar_items: cross-type neighbours with scores, amira_url and what each also shares, best first", async () => {
  const result = await call("get_similar_items", { id: 500 });
  assert.deepEqual(result.source, ref(500, "research_item", "Yoruba Architecture Study"));
  assert.deepEqual(result.space, SPACE);
  assert.equal(result.count, 5);
  assert.deepEqual(result.results, NEIGHBOURS_OF_500);
  assert.match(result.note, /wording_only/);
});

test("get_similar_items: types and limit, typed ids, and a project as the source", async () => {
  assert.deepEqual(ids(await call("get_similar_items", { id: 500, types: ["podcast", "section"] })), [530, 400]);
  assert.deepEqual(ids(await call("get_similar_items", { id: 500, limit: 2 })), [501, 510]);
  const capped = await call("get_similar_items", { id: 500, limit: 50 });
  assert.deepEqual([capped.count, capped.requested_limit, capped.effective_limit], [7, 50, 10]);
  for (const id of ["item:500", "research_item:500", "500"]) assert.equal((await call("get_similar_items", { id })).source.omeka_id, 500, id);
  const project = await call("get_similar_items", { id: "project:300", types: ["research_item"] });
  assert.deepEqual([project.source.type, ids(project)], ["project", [502, 501, 500]]);
  // A typed id must name a record of that type.
  assert.equal((await call("get_similar_items", { id: "publication:500" })).error.code, "not_found");
});

test("get_similar_items: no neighbours come with an explicit reason, never a bare empty list", async () => {
  const low = await call("get_similar_items", { id: 503 });
  assert.deepEqual([low.count, low.results, low.no_neighbours], [0, [], "low_signal"]);
  assert.match(low.reason, /Too little own text/);
  // 511 is in the snapshot but not in the build.
  const missing = await call("get_similar_items", { id: 511 });
  assert.deepEqual([missing.count, missing.no_neighbours], [0, "not_in_release"]);
  assert.match(missing.reason, new RegExp(TAG));
  const person = await call("get_similar_items", { id: "person:100" });
  assert.deepEqual([person.error.code, person.error.suggested_tool], ["not_embedded", "find_related"]);
  assert.equal((await call("get_similar_items", { id: 100 })).error.code, "not_found");
  assert.equal((await call("get_similar_items", { id: 9999 })).error.code, "not_found");
});

test("include_similar adds the same explained neighbours to every detail tool, and only on request", async () => {
  const item = await call("get_research_item", { id: 500, include_similar: true });
  assert.deepEqual(item.similar, { release: TAG, count: 5, results: NEIGHBOURS_OF_500, note: item.similar.note });
  assert.equal((await call("get_research_item", { id: 500 })).similar, undefined);

  const project = await call("get_project", { id: 300, include_similar: true });
  assert.deepEqual(project.similar.results.slice(0, 2).map((r) => [r.omeka_id, r.basis, r.shared]), [
    // Both at 10°: another project's item and a publication, linked through a team member.
    [502, "shared_metadata", { people: ["Fendler, Ute"] }],
    [510, "shared_metadata", { people: ["Fendler, Ute"] }],
  ]);
  assert.deepEqual(project.similar.results.find((r) => r.omeka_id === 501).shared, { project: ["Fixture Art Worlds"] });
  // Membership of a research section is never counted, only the people they share.
  const section = await call("get_similar_items", { id: "project:300", types: ["section"] });
  assert.deepEqual(section.results.map((r) => [r.omeka_id, Object.keys(r.shared ?? {})]), [[400, ["people"]]]);
  assert.equal((await call("get_podcast", { id: 530, include_similar: true })).similar.results[0].omeka_id, 400);
  assert.equal((await call("get_video", { id: 540, include_similar: true })).similar.results[0].omeka_id, 502);
  // The record exists, so missing neighbours are a reason inside the block, never an error.
  const pub = await call("get_publication", { id: 511, include_similar: true });
  assert.deepEqual([pub.title, pub.similar.count, pub.similar.no_neighbours], ["Fixture Working Paper on Migration", 0, "not_in_release"]);
  assert.equal((await call("get_research_item", { id: 503, include_similar: true })).similar.no_neighbours, "low_signal");

  process.env.AMIRA_EXPOSURE = "descriptive";
  try {
    const restricted = await call("get_research_item", { id: 500, include_similar: true });
    assert.equal(restricted.title, "Yoruba Architecture Study");
    assert.match(restricted.similar.unavailable, /structured exposure/);
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});

test("get_similar_items needs structured exposure: the space is built from subjects and places too", async () => {
  process.env.AMIRA_EXPOSURE = "descriptive";
  try {
    assert.equal((await call("get_similar_items", { id: 500 })).error.code, "exposure_restricted");
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});

test("get_data_quality and amira://dataset name the space and its coverage", async () => {
  const quality = await call("get_data_quality");
  assert.deepEqual(quality.semantic_neighbours, {
    ...SPACE,
    with_neighbours: { research_item: 3, publication: 1, video: 1, podcast: 1, project: 1, section: 1 },
    low_signal: { research_item: 1, publication: 0, video: 0, podcast: 0, project: 0, section: 0 },
    not_in_release: { research_item: 0, publication: 1, video: 1, podcast: 0, project: 1, section: 1 },
  });
  const dataset = JSON.parse((await conn.client.readResource({ uri: "amira://dataset" })).contents[0].text);
  assert.deepEqual(dataset["amira:semantic_space"], { repository: lib.SEMANTIC_SOURCE.repository, release: TAG,
    model: "google/embeddinggemma-2", model_revision: "914f7f8", generated_at: "2026-11-06T08:04:17Z",
    vectors_sha256: verified.manifest.vectorsSha256 });
});

// --- find_related, the record pivot (phase 2) ------------------------------------------

test("find_related entity_type=record: the closest records by meaning stand in for the matched records", async () => {
  const r = await call("find_related", { entity_type: "record", value: "500" });
  assert.deepEqual([r.entity_type, r.seed_label, r.amira_url, r.space], ["record", "Yoruba Architecture Study", url(500), SPACE]);
  assert.deepEqual(r.seed, ref(500, "research_item", "Yoruba Architecture Study"));
  assert.equal(r.matched_records, 7);
  assert.deepEqual(r.matched_by_type, { research_item: 2, publication: 1, project: 1, video: 1, podcast: 1, section: 1 });
  assert.deepEqual(r.closest.map((c) => [c.omeka_id, c.type]),
    [[501, "research_item"], [510, "publication"], [300, "project"], [502, "research_item"], [540, "video"], [530, "podcast"], [400, "section"]]);
  // Counted per corpus: Fixture Art Worlds is 501's project AND a neighbour itself.
  const art = r.related_projects.find((p) => p.omeka_id === 300);
  assert.deepEqual([art.count, art.research_item_count, art.project_count], [2, 1, 1]);
  // Fendler: 502's contributor, 510's author, 530's host and a member of project 300.
  const fendler = r.related_people.find((p) => p.omeka_id === 101);
  assert.deepEqual([fendler.count, fendler.research_item_count, fendler.publication_count, fendler.podcast_count, fendler.project_count],
    [4, 1, 1, 1, 1]);
  assert.equal(r.related_research_sections[0].name, "Arts & Aesthetics");
  // A typed id names the same seed; other pivots keep their shape (no per-type counts).
  assert.deepEqual((await call("find_related", { entity_type: "record", value: "research_item:500" })).closest, r.closest);
  const subject = await call("find_related", { entity_type: "subject", value: "Architecture" });
  assert.ok(subject.related_people.every((p) => !("video_count" in p) && !("project_count" in p)));
});

test("find_related entity_type=record: no neighbours and unknown seeds are explained errors", async () => {
  const low = await call("find_related", { entity_type: "record", value: "503" });
  assert.equal(low.error.code, "no_neighbours");
  assert.match(low.error.message, /Too little own text/);
  assert.equal((await call("find_related", { entity_type: "record", value: "511" })).error.code, "no_neighbours");
  assert.equal((await call("find_related", { entity_type: "record", value: "person:100" })).error.code, "not_embedded");
  assert.equal((await call("find_related", { entity_type: "record", value: "9999" })).error.code, "not_found");
});
