import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory, expectedToolNames } from "../helpers/mcp.mjs";

hermeticEnv({ dataDir: "absent" });
const lib = await import("../../server/lib.js");
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
fixture.data.persons.push({ o_id: 103, name: "Beier, Ulli", affiliations: [] });
fixture.data.research_items[0].contributors.push({ ...fixture.data.research_items[0].contributors[0], role: "photographer" });
fixture.data.research_items[0].places.push({ label: "Nigeria", o_id: 900 });
fixture.data.publications[0].subjects.push({ label: "Decoloniality", o_id: 911 });
fixture.data.publications[0].fulltext = "😀 avant Cafe\u0301 africain; Café encore";
fixture.manifest.counts.persons++;
fixture.data.locations.push({ o_id: 905, name: "Lagos", latitude: null, longitude: null, parent: { label: "Germany", o_id: 902 }, wikidata: null });
fixture.data.research_items[0].places.push({ label: "Lagos", o_id: 905 });
fixture.manifest.counts.locations++;
await lib.writeSnapshot(process.env.AMIRA_DATA_DIR, fixture);
const conn = await connectInMemory(lib, { openai: true }, { name: "research-test" });
const { client, call } = conn;
test.after(() => conn.close());

test("homonyms stay separate, typed IDs resolve, and profiles never merge linked people", async () => {
  const found = await call("resolve_entity", { query: "Beier, Ulli", type: "person" });
  assert.equal(found.ambiguous, true);
  assert.deepEqual(found.results.map((r) => r.id).sort(), ["person:100", "person:103"]);
  assert.equal((await call("get_person", { name: "Ulli Beier" })).error.code, "ambiguous_entity");
  const exact = await call("get_person", { id: 103 });
  assert.equal(exact.contributed_item_count, 0);
  assert.equal(exact.publication_count, 0);
  assert.equal((await call("resolve_entity", { query: "person:103" })).results[0].omeka_id, 103);
});

test("related counts deduplicate contributor roles and locations per source record", async () => {
  const related = await call("find_related", { entity_type: "subject", value: fixture.data.research_items[0].subjects[0].label, limit: 100 });
  assert.equal(related.effective_limit, 50);
  for (const row of [...related.related_people, ...related.related_countries]) {
    assert.ok(row.research_item_count <= related.matched_items);
    assert.equal(row.count, row.research_item_count + row.publication_count);
  }
  const onlyPubs = await call("find_related", { entity_type: "subject", value: "Decoloniality" });
  assert.equal(onlyPubs.matched_items, 0);
  assert.equal(onlyPubs.matched_publications, 1);
  assert.ok(onlyPubs.related_people.length);
  assert.equal(onlyPubs.seed_candidates[0].id, "subject:911");
});

test("graph bounds, identity, provenance and paginated evidence agree", async () => {
  const graph = await call("get_entity_graph", { seed: "person:100", max_nodes: 5, max_edges: 8 });
  assert.ok(graph.nodes.length <= 5 && graph.edges.length <= 8);
  assert.equal(graph.truncated, true);
  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const edge of graph.edges) {
    assert.ok(ids.has(edge.source) && ids.has(edge.target));
    assert.notEqual(edge.source, edge.target);
    assert.ok(edge.evidence.every((r) => r.amira_url && r.id));
    const page = await call("get_entity_graph", { seed: graph.seed, edge_id: edge.id, snapshot_id: graph.snapshot_id, limit: 1 });
    assert.equal(page.total_matches, edge.count);
    assert.equal(page.results[0].id, edge.evidence[0].id);
  }
  assert.equal((await call("get_entity_graph", { seed: "person:100", snapshot_id: "old" })).error.code, "snapshot_changed");
  const empty = await call("get_entity_graph", { seed: "person:103" });
  assert.equal(empty.edges.length, 0);
});

test("passage offsets recover decomposed accents and retain exact original text", async () => {
  const text = fixture.data.publications[0].fulltext;
  const id = `publication:${fixture.data.publications[0].o_id}`;
  const found = await call("get_text_passages", { ids: [id], keyword: "cafe", limit: 1 });
  assert.equal(found.total_matches, 2);
  assert.equal(found.has_more, true);
  assert.equal(text.slice(found.results[0].match_start, found.results[0].match_end), "Cafe\u0301");
  assert.equal(found.results[0].text, text.slice(found.results[0].start, found.results[0].end));
  const next = await call("get_text_passages", { ids: [id], keyword: "cafe", offset: found.next_offset });
  assert.equal(text.slice(next.results[0].match_start, next.results[0].match_end), "Café");
  assert.equal(lib.foldedIndexOf(text, "CAFE"), text.indexOf("Cafe"));
});

test("comparison, map and timeline share research-item selection", async () => {
  const filters = { subject: fixture.data.research_items[0].subjects[0].label };
  const selected = await call("search_research_items", filters);
  const map = await call("list_locations", { filters });
  const years = await call("list_years", { filters });
  assert.equal(map.matched_items, selected.total_matches);
  assert.equal(years.dated_items + years.undated_items, selected.total_matches);
  const compared = await call("compare_collections", { filters, cohorts: fixture.data.projects.map((p) => ({ type: "project", id: String(p.o_id) })) });
  for (const c of compared.cohorts) {
    const expected = await call("search_research_items", { ...filters, project_id: c.id });
    assert.equal(c.matched_items, expected.total_matches);
    assert.ok(c.matched_items <= c.total_items);
  }
});

test("new tools enforce metadata exposure even after their indexes have warmed", async () => {
  await call("get_data_quality");
  process.env.AMIRA_EXPOSURE = "minimal";
  try {
    for (const [name, args] of [["resolve_entity", { query: "Beier" }], ["get_entity_graph", { seed: "person:100" }],
      ["get_data_quality", {}], ["get_snapshot_changes", {}], ["get_text_passages", { ids: ["publication:510"], keyword: "cafe" }],
      ["compare_collections", { cohorts: [{ type: "project", id: "300" }, { type: "project", id: "301" }] }]]) {
      assert.equal((await call(name, args)).error.code, "exposure_restricted", name);
    }
  } finally { delete process.env.AMIRA_EXPOSURE; }
});

test("media reject inverted dates and text inputs are bounded", async () => {
  for (const name of ["search_videos", "search_podcasts"]) assert.equal((await call(name, { year_from: 2020, year_to: 1900 })).error.code, "invalid_range");
  const invalid = await client.callTool({ name: "search_research_items", arguments: { keyword: "x".repeat(1001) } });
  assert.equal(invalid.isError, true);
});

test("snapshot changes distinguish additions, deletions and updates with stable paging", async () => {
  const before = structuredClone(fixture), after = structuredClone(fixture);
  before.manifest.fetchedAt = "2026-10-01T00:00:00Z";
  after.manifest.fetchedAt = "2026-10-02T00:00:00Z";
  after.data.persons[0].name = "Updated label";
  after.data.persons.splice(1, 1);
  after.data.persons.push({ o_id: 999, name: "Added person", affiliations: [] });
  const cache = lib.snapshotCacheDir(process.env.AMIRA_CACHE_DIR, fixture.manifest.apiBase);
  await lib.writeSnapshotAtomic(cache, before);
  await lib.writeSnapshotAtomic(cache, after);
  const first = await call("get_snapshot_changes", { corpus: "persons", limit: 1 });
  assert.equal(first.status, "ready");
  assert.equal(first.total_matches, 3);
  assert.equal(first.results[0].change, "updated");
  const rest = await call("get_snapshot_changes", { corpus: "persons", from_id: first.from_id, to_id: first.to_id, offset: first.next_offset });
  assert.deepEqual(rest.results.map((r) => r.change), ["deleted", "added"]);
});

test("tool profiles retain the helpers their apps need and the full default remains available", async () => {
  // The full stdio surface is manifest.json's tool list; every profile is a strict subset.
  const fullCount = expectedToolNames().length;
  for (const profile of ["research", "discovery", "visualization"]) {
    const profiled = await connectInMemory(lib, { profile }, { name: "profile-test" });
    try {
      const names = (await profiled.client.listTools()).tools.map((t) => t.name);
      assert.ok(names.length < fullCount, `${profile}: ${names.length} tools, full surface ${fullCount}`);
      for (const name of ["get_entity_graph", "resolve_entity", "search_research_items", "list_locations"]) assert.ok(names.includes(name), `${profile}: ${name}`);
    } finally { await profiled.close(); }
  }
});

test("place facets preserve homonyms and their distinct parent identities", async () => {
  const places = await call("list_locations", { keyword: "Lagos" });
  assert.equal(places.total_matches, 2);
  const exact = await call("search_research_items", { location_id: 905 });
  assert.equal(exact.total_matches, 1);
  assert.equal(exact.results[0].omeka_id, fixture.data.research_items[0].o_id);
  assert.deepEqual(places.results.map((r) => [r.omeka_id, r.country]).sort(), [[901, "Nigeria"], [905, "Germany"]]);
});
