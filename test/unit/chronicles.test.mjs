// Cluster Chronicles (item set 50105): the transform from Omeka JSON-LD, the
// search_chronicles / get_chronicle tools, and the collection's place in the
// cross-cutting tools (overview, get_person, find_related, the entity graph,
// get_text_passages) — against the tiny fixture, offline.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import * as path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));
const conn = await connectInMemory(lib, {}, { name: "chronicles-unit" });
const { call } = conn;
test.after(() => conn.close());

const ctx = {
  roleLabel: (term) => ({ "marcrel:aut": "author", "marcrel:pht": "photographer", "marcrel:trl": "translator" })[term] ?? null,
  classTerm: (id) => ({ 274: "fabio:Essay" })[id] ?? null,
};
const lit = (v, lang) => ({ type: "literal", "@value": v, ...(lang ? { "@language": lang } : {}) });
const res = (id, label) => ({ type: "resource:item", value_resource_id: id, display_title: label });

test("transform: form from the class, AI abstract provenance, linked and literal subjects and places", () => {
  const essay = lib.transformChronicle({
    "o:id": 50109,
    "@type": ["o:Item", "fabio:Essay"],
    "o:resource_class": { "o:id": 274 },
    "o:title": "Mémoires",
    "dcterms:title": [lit("Mémoires", "fr")],
    "dcterms:alternative": [lit("Memories")],
    "dcterms:isPartOf": [res(50106, "Cluster Chronicles")],
    "bibo:number": [{ type: "numeric:integer", "@value": "1" }],
    "dcterms:date": [{ type: "numeric:timestamp", "@value": "2026" }],
    "marcrel:aut": [res(50103, "Kabaji, Egara")],
    "marcrel:trl": [res(101, "Fendler, Ute")],
    "dcterms:abstract": [{ ...lit("An essay."), "@annotation": { "dre:generatedBy": [res(50107, "Claude Haiku 5.5")] } }],
    "dcterms:subject": [res(30247, "narratives"), lit("residency")],
    "dcterms:spatial": [res(1896, "Kenya"), lit("Kunst- und Kulturhaus")],
    "dcterms:relation": [res(39324, "A lecture")],
    "fabio:hasURL": [{ type: "uri", "@id": "https://example.org/chronicle/1" }],
    "bibo:content": [lit("The invitation arrived.")],
    "dcterms:identifier": [lit("kabaji-2026-chronicle-01")],
  }, ctx);
  assert.equal(essay.form, "essay");
  assert.equal(essay.resource_class, "fabio:Essay");
  assert.equal(essay.title_language, "fr");
  assert.deepEqual(essay.alt_titles, ["Memories"]);
  assert.equal(essay.number, 1);
  assert.equal(essay.year, 2026);
  assert.deepEqual(essay.people.map((p) => [p.name, p.role]), [["Kabaji, Egara", "Author"], ["Fendler, Ute", "Translator"]]);
  assert.deepEqual(essay.abstract_generated_by, { label: "Claude Haiku 5.5", o_id: 50107 });
  assert.deepEqual(essay.subjects, [{ label: "narratives", o_id: 30247 }, { label: "residency", o_id: null }]);
  assert.deepEqual(essay.places, [{ label: "Kenya", o_id: 1896 }, { label: "Kunst- und Kulturhaus", o_id: null }]);
  assert.equal(essay.text, "The invitation arrived.");
  assert.equal(essay.identifier, "kabaji-2026-chronicle-01");

  // An unresolved class falls back to the JSON-LD @type; an unmapped one is spelled out.
  const event = lib.transformChronicle({ "o:id": 1, "@type": ["o:Item", "bibo:Event"], "o:resource_class": { "o:id": 54 } }, ctx);
  assert.equal(event.form, "event");
  assert.equal(lib.transformChronicle({ "o:id": 2, "@type": ["o:Item", "fabio:ConferencePaper"] }, ctx).form, "conference paper");
  assert.equal(event.abstract_generated_by, null);
});

test("search_chronicles filters by person (credit or depiction), form, place, subject and year", async () => {
  const all = await call("search_chronicles", {});
  assert.equal(all.total_matches, 2);
  assert.ok(all.results.every((r) => r.amira_url?.endsWith(`/${r.omeka_id}`)));
  // Newest residency first.
  assert.deepEqual(all.results.map((r) => r.omeka_id), [561, 560]);
  assert.equal(all.results[1].alternative_title, "Memories of the Ocean");

  assert.deepEqual((await call("search_chronicles", { person: "Ulli Beier" })).results.map((r) => r.omeka_id), [561, 560],
    "a depicted person finds the photograph too");
  assert.deepEqual((await call("search_chronicles", { form: "photograph" })).results.map((r) => r.omeka_id), [561]);
  assert.deepEqual((await call("search_chronicles", { form: "fabio:Essay" })).results.map((r) => r.omeka_id), [560]);
  assert.deepEqual((await call("search_chronicles", { place: "Nigeria" })).results.map((r) => r.omeka_id).sort(), [560, 561],
    "Nigeria reaches the Lagos essay through the place hierarchy");
  assert.deepEqual((await call("search_chronicles", { place: "Kunsthaus" })).results.map((r) => r.omeka_id), [560], "literal venue");
  assert.deepEqual((await call("search_chronicles", { subject: "harbour" })).results.map((r) => r.omeka_id), [561]);
  assert.deepEqual((await call("search_chronicles", { year_to: 2024 })).results.map((r) => r.omeka_id), [560]);
  assert.deepEqual((await call("search_chronicles", { language: "fr" })).results.map((r) => r.omeka_id), [560]);
  assert.equal((await call("search_chronicles", { year_from: 2026, year_to: 2020 })).error.code, "invalid_range");
});

test("search_chronicles reaches the full text with a snippet", async () => {
  const hits = await call("search_chronicles", { keyword: "baobab-chronicle-token" });
  assert.equal(hits.total_matches, 1);
  assert.equal(hits.results[0].matched_in, "text");
  assert.ok(hits.results[0].text_snippet.includes("baobab-chronicle-token"));
  assert.equal(hits.results[0].text, undefined, "summaries never carry the text");
});

test("get_chronicle: credits, depictions, typed relations, AI abstract flag, text opt-in and paging", async () => {
  const essay = await call("get_chronicle", { id: "chronicle:560" });
  assert.equal(essay.omeka_id, 560);
  assert.equal(essay.title_language, "fr");
  assert.equal(essay.abstract_ai_generated, true);
  assert.equal(essay.abstract_generated_by.name, "Claude Haiku 5.5");
  assert.deepEqual(essay.people.map((p) => p.role), ["Author", "Translator"]);
  assert.ok(essay.people.every((p) => p.amira_url));
  assert.deepEqual(essay.subjects.map((s) => s.amira_url === null), [false, true], "a literal subject has no page");
  assert.deepEqual(essay.related.map((r) => r.id), ["chronicle:561", "video:540"]);
  assert.equal(essay.has_text, true);
  assert.equal(essay.text, undefined);
  assert.ok(essay.text_hint.includes("include_text"));
  assert.ok(essay.amira_url.endsWith("/560"));

  const page = await call("get_chronicle", { id: 560, include_text: true, text_offset: 10, text_max_chars: 50 });
  assert.equal(page.text.length, 50);
  assert.equal(page.text_offset, 10);
  assert.equal(page.text_truncated, true);

  const photo = await call("get_chronicle", { id: "561" });
  assert.equal(photo.form, "still image");
  assert.deepEqual(photo.depicts.map((d) => d.label), ["Beier, Ulli"]);
  assert.equal(photo.media[0].type, "image/jpeg");
  assert.equal(photo.has_text, false);

  assert.equal((await call("get_chronicle", { id: 999999 })).error.suggested_tool, "search_chronicles");
  const wrongKind = await call("get_chronicle", { id: "video:540" });
  assert.equal(wrongKind.error.suggested_tool, "get_video");
  assert.equal((await call("get_video", { id: "chronicle:560" })).error.suggested_tool, "get_chronicle");
});

test("the collection appears in the overview, person profiles, find_related, the entity graph and text passages", async () => {
  const overview = await call("get_collection_overview", {});
  assert.equal(overview.counts.cluster_chronicles, 2);
  assert.equal(overview.counts.cluster_chronicles_with_text, 1);
  assert.deepEqual(overview.chronicles_by_form, { essay: 1, "still image": 1 });

  const beier = await call("get_person", { id: 100 });
  assert.equal(beier.chronicle_count, 2);
  assert.deepEqual(beier.chronicles.map((c) => [c.omeka_id, c.role]), [[560, "Author"], [561, "Depicted"]]);
  assert.ok(beier.chronicles.every((c) => c.amira_url));

  const related = await call("find_related", { entity_type: "person", value: "Fendler, Ute" });
  assert.equal(related.matched_chronicles, 2);
  assert.ok(related.related_chronicles.every((c) => c.amira_url));
  const beierRow = related.related_people.find((p) => p.name === "Beier, Ulli");
  assert.equal(beierRow.chronicle_count, 2);
  const bySubject = await call("find_related", { entity_type: "subject", value: "Architecture" });
  assert.equal(bySubject.matched_chronicles, 1);

  const graph = await call("get_entity_graph", { seed: "chronicle:560" });
  const targets = graph.nodes.map((n) => n.id);
  for (const id of ["person:100", "person:101", "location:901", "chronicle:561", "video:540", "subject:600"]) {
    assert.ok(targets.includes(id), id);
  }
  const personGraph = await call("get_entity_graph", { seed: "person:100" });
  assert.ok(personGraph.edges.some((e) => e.chronicle_count > 0));

  const passages = await call("get_text_passages", { ids: ["chronicle:560"], keyword: "baobab-chronicle-token", limit: 2 });
  assert.equal(passages.results[0].id, "chronicle:560");
  assert.ok(passages.results[0].amira_url.endsWith("/560"));
});

test("a v5 snapshot (before the collection) loads with an empty chronicles corpus and is stale", async () => {
  const dir = path.join(dataDir, "..", "v5-snapshot");
  const fixture = buildFixture(5);
  delete fixture.data.chronicles;
  delete fixture.manifest.counts.chronicles;
  await fs.mkdir(dir, { recursive: true });
  for (const [corpus, rows] of Object.entries(fixture.data)) await fs.writeFile(path.join(dir, `${corpus}.json`), JSON.stringify(rows));
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(fixture.manifest));
  const loaded = await lib.loadSnapshot(dir);
  assert.deepEqual(loaded.data.chronicles, []);
  assert.equal(lib.isStale(loaded.manifest, { maxModified: loaded.manifest.maxModified, totalItems: loaded.manifest.totalItemsOnInstance }), true);
});
