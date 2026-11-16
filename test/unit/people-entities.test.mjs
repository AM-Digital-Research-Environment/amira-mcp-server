// People, organisations, entity resolution, the entity graph and find_related
// (review of 2026-11-16): name order in exact matches, one node per record,
// related items outside co-occurrence, one definition of a person credit,
// project pivots that refuse to pool, list hints, argument handling.
//
// The fixture is extended in this process only.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
d.persons.push(
  { o_id: 130, name: "Bationo, Fernand", affiliations: [] },
  { o_id: 131, name: "Bationo, Awa", affiliations: [] },
  { o_id: 132, name: "Kouamé, Yao", affiliations: [] },
  { o_id: 133, name: "Mixer, Sam", affiliations: [] },
);
// An organisation of no recorded type: in list_institutions, marked.
d.organisations.push({ o_id: 212, name: "Ministry of Culture", kind: "organisation", part_of: [], latitude: null, longitude: null, wikidata: null });
d.projects.push(
  { ...structuredClone(d.projects[1]), o_id: 310, dre_id: "Ext_Participation", name: "Participation Studies" },
  { ...structuredClone(d.projects[1]), o_id: 311, dre_id: "Ext_Startup", name: "Start-up Cultures" },
);
const item = (oId, title, extra) => ({ ...structuredClone(d.research_items[0]), o_id: oId, dre_id: `abg-fx-${oId}`, title,
  identifiers: [`FX_${oId}`], typed_identifiers: [{ value: `FX_${oId}`, type: "Locally defined identifier" }], ...extra });
d.research_items.push(
  item(560, "Bobo Masks", { contributors: [
    { name: "Bationo, Fernand", role: "Author", o_id: 130 }, { name: "Bationo, Awa", role: "Author", o_id: 131 }] }),
  // A place used as a subject, and a link to a related item.
  item(561, "Lagos Harbour", { subjects: [{ label: "Lagos", o_id: 901 }], places: [{ label: "Lagos", o_id: 901 }],
    contributors: [], related: [{ relation: "has version", ref: { label: "Mosque Photograph Series", o_id: 501 } }] }),
  // A person, an institution and a sound engineer credited together.
  item(562, "Field Recording", { contributors: [
    { name: "Bationo, Fernand", role: "Recordist", o_id: 130 }, { name: "Kouamé, Yao", role: "Performer", o_id: 132 },
    { name: "Mixer, Sam", role: "Sound engineer", o_id: 133 }, { name: "University of Bayreuth", role: "Author", o_id: 200 }] }),
);
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "people-entities" });
const { call, raw } = conn;
test.after(() => conn.close());

async function errorOf(name, args) {
  const result = await raw(name, args);
  assert.equal(result.isError, true, `${name} should fail`);
  return JSON.parse(result.content[0].text).error;
}

// --- 2: name order --------------------------------------------------------------

test("resolve_entity and find_related match a full person name in either order", async () => {
  for (const query of ["Fernand Bationo", "Bationo, Fernand", "fernand bationo"]) {
    const r = await call("resolve_entity", { query, type: "person" });
    assert.deepEqual([r.ambiguous, r.results.map((e) => e.id)], [false, ["person:130"]], query);
    const rel = await call("find_related", { entity_type: "person", value: query });
    assert.equal(rel.error, undefined, query);
    assert.equal(rel.amira_url, lib.itemUrl(130), query);
  }
  // The surname alone still names two people.
  assert.equal((await errorOf("find_related", { entity_type: "person", value: "Bationo" })).code, "ambiguous_entity");
});

// --- 3 and 4: the entity graph ----------------------------------------------------

test("a place used as a subject is one graph node with both roles' edges", async () => {
  const r = await call("resolve_entity", { query: "Lagos" });
  assert.deepEqual([r.ambiguous, r.results.map((e) => e.id)], [false, ["location:901"]]);
  const graph = await call("get_entity_graph", { seed: "location:901", max_nodes: 100 });
  assert.ok(!graph.nodes.some((n) => n.id === "subject:901"));
  const relations = graph.edges.filter((e) => e.kind === "explicit" && e.source === "research_item:561").map((e) => e.relation).sort();
  assert.deepEqual(relations, ["spatial", "subject"]);
});

test("a related item is an explicit item-to-item edge, not a co-occurring entity of the record's links", async () => {
  const graph = await call("get_entity_graph", { seed: "location:901", types: ["research_item"], max_nodes: 100 });
  assert.ok(!graph.edges.some((e) => e.kind === "cooccurrence" && e.target === "research_item:501"),
    "item 501 is related to an item at Lagos, not at Lagos itself");
  const item = await call("get_entity_graph", { seed: "research_item:561", max_nodes: 100 });
  assert.ok(item.edges.some((e) => e.kind === "explicit" && e.relation === "has version" && e.target === "research_item:501"));
});

// --- 6: one definition of a person credit ----------------------------------------

test("get_person, find_related and get_entity_graph count the same people on the same records", async () => {
  const person = await call("get_person", { id: 130 });
  const collaborators = Object.fromEntries(person.top_collaborators.map((c) => [c.name, c.shared_items]));
  assert.deepEqual(collaborators, { "Bationo, Awa": 1, "Kouamé, Yao": 1 });

  const rel = await call("find_related", { entity_type: "person", value: "person:130" });
  assert.deepEqual(Object.fromEntries(rel.related_people.map((p) => [p.name, p.research_item_count])), collaborators,
    "no organisation, no sound engineer");

  const graph = await call("get_entity_graph", { seed: "person:130", types: ["person"], max_nodes: 100 });
  const shared = Object.fromEntries(graph.edges.filter((e) => e.kind === "cooccurrence")
    .map((e) => [graph.nodes.find((n) => n.id === e.target).label, e.research_item_count]));
  assert.deepEqual(shared, collaborators);
  // The sound engineer keeps the explicit credit on the item.
  const item = await call("get_entity_graph", { seed: "research_item:562", max_nodes: 100 });
  assert.ok(item.edges.some((e) => e.kind === "explicit" && e.target === "person:133"));
});

test("find_related sends a neutral note with its people list", async () => {
  const rel = await call("find_related", { entity_type: "person", value: "person:130" });
  assert.match(rel.people_note, /not a measure of collaboration/);
  assert.match(rel.people_note, /do not rank or judge people/);
});

// --- 5 and 9: find_related pivots -------------------------------------------------

test("a project pivot resolves one project and refuses several", async () => {
  // "Art" is a whole word of one name only, not a substring of "Participation" or "Start-up".
  const art = await call("find_related", { entity_type: "project", value: "Art" });
  assert.deepEqual([art.ambiguous, art.amira_url], [false, lib.itemUrl(300)]);
  for (const value of ["300", "project:300", "UBT_Fixture2019", "fixture art worlds"]) {
    assert.equal((await call("find_related", { entity_type: "project", value })).amira_url, lib.itemUrl(300), value);
  }
  const several = await errorOf("find_related", { entity_type: "project", value: "Fixture" });
  assert.equal(several.code, "ambiguous_entity");
  assert.deepEqual(several.available_values, ["Fixture Art Worlds (project:300)", "Fixture Music Library (project:301)"]);
  const unknown = await errorOf("find_related", { entity_type: "project", value: "99999" });
  assert.deepEqual([unknown.code, unknown.suggested_tool], ["not_found", "search_projects"]);
});

test("a subject pivot says which headings it pooled, and an unknown one says it matched nothing", async () => {
  const rel = await call("find_related", { entity_type: "subject", value: "a" });
  assert.ok(rel.matched_value_count >= 2);
  assert.ok(rel.matched_values.some((v) => v.name === "Architecture"));
  const none = await call("find_related", { entity_type: "subject", value: "Zzyzx" });
  assert.equal(none.matched_items, 0);
  assert.match(none.hint, /No subject heading contains 'Zzyzx'/);
});

// --- 7 and 8: descriptions and sample caps ---------------------------------------

test("find_related describes the research_item value as an id and its fixed sample caps", async () => {
  const { tools } = await conn.client.listTools();
  const schema = tools.find((t) => t.name === "find_related").inputSchema.properties;
  assert.match(schema.value.description, /research_item: an item id \('27733' or 'research_item:27733'\), not a text query/);
  assert.match(schema.limit.description, /sample lists show at most 10/);
});

test("find_related sample lists honour a smaller limit, and publication rows carry ids", async () => {
  const rel = await call("find_related", { entity_type: "subject", value: "Architecture", limit: 1 });
  assert.equal(rel.sample_items.length, 1);
  assert.deepEqual(rel.related_publications[0], { id: "510", omeka_id: 510, title: "Decolonial Architecture Futures", year: 2024,
    amira_url: lib.itemUrl(510) });
});

// --- 9: hints -----------------------------------------------------------------------

test("list_institutions and list_groups match every word and explain empty pages", async () => {
  assert.deepEqual((await call("list_institutions", { keyword: "Bayreuth University" })).results.map((r) => r.omeka_id), [200]);
  const none = await call("list_institutions", { keyword: "Nowhere" });
  assert.equal(none.count, 0);
  assert.match(none.hint, /No record matches/);
  const past = await call("list_groups", { offset: 10 });
  assert.match(past.hint, /offset 10 is past the end: there are 1 matches/);
});

test("resolve_entity explains an unknown typed id and a batch-like query", async () => {
  assert.match((await call("resolve_entity", { query: "person:999999" })).hint, /^Unknown id: no person has the id '999999'/);
  assert.match((await call("resolve_entity", { query: "Beier; Fendler" })).hint, /takes one query/);
  assert.match((await call("resolve_entity", { query: "Beier", offset: 50 })).hint, /past the end/);
});

// --- 11: get_person arguments --------------------------------------------------------

test("get_person says what an id of another kind is and refuses a conflicting name", async () => {
  const typed = await errorOf("get_person", { id: "organisation:200" });
  assert.equal(typed.suggested_tool, "get_institution");
  const bare = await errorOf("get_person", { id: 200 });
  assert.equal(bare.suggested_tool, "get_institution");
  // The shared id resolver (recordArg) answers a bare id of another kind.
  assert.match(bare.message, /'200' is an institution id, not a person id/);
  const conflict = await errorOf("get_person", { id: 100, name: "Fendler, Ute" });
  assert.equal(conflict.code, "invalid_argument");
  assert.equal((await call("get_person", { id: 100, name: "Ulli Beier" })).omeka_id, 100);
  assert.equal((await errorOf("get_person", { id: "abc" })).code, "invalid_id");
});

// --- 12: graph bounds -----------------------------------------------------------------

test("get_entity_graph echoes capped bounds", async () => {
  const graph = await call("get_entity_graph", { seed: "person:100", max_nodes: 500, max_edges: 999 });
  assert.deepEqual([graph.bounds.max_nodes, graph.bounds.max_edges], [100, 200]);
  assert.deepEqual(graph.requested_bounds, { max_nodes: 500, max_edges: 999 });
  assert.equal((await call("get_entity_graph", { seed: "person:100" })).requested_bounds, undefined);
});

// --- 14 and 16: groups and untyped organisations ---------------------------------------

test("list_groups describes ensembles; list_institutions lists untyped organisations, which the overview counts", async () => {
  const { tools } = await conn.client.listTools();
  assert.match(tools.find((t) => t.name === "list_groups").description, /performing ensembles/);
  const page = await call("list_institutions", { keyword: "Ministry" });
  assert.deepEqual(page.results.map((r) => [r.omeka_id, r.kind]), [[212, "organisation"]]);
  assert.equal((await call("list_institutions", { keyword: "Bayreuth" })).results[0].kind, undefined, "typed rows stay unmarked");
  const overview = await call("get_collection_overview");
  assert.equal(overview.counts.institutions + overview.counts.groups, d.organisations.length);
});

// --- 17: Wikidata URIs --------------------------------------------------------------------

test("Wikidata page URLs are read in the entity form", () => {
  assert.equal(lib.wikidataUri("https://www.wikidata.org/wiki/Q8673"), "http://www.wikidata.org/entity/Q8673");
  assert.equal(lib.wikidataUri("http://www.wikidata.org/entity/Q8673"), "http://www.wikidata.org/entity/Q8673");
  assert.equal(lib.wikidataUri("https://example.org/x"), "https://example.org/x");
  assert.equal(lib.wikidataUri(undefined), null);
});
