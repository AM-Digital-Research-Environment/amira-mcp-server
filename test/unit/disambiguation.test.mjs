// One entity per answer (review of 2026-10-26, run through the installed
// connector): get_institution missed an acronym that list_institutions finds,
// find_related pooled two people who share a surname into one set of counts,
// and get_person listed an institution among a person's collaborators.
//
// The fixture is extended in this process only: two Lagos institutions that
// share words, two people who share a surname, and an item each crediting one
// of them, the first alongside an institution.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
d.organisations.push(
  { o_id: 210, name: "University of Lagos", kind: "institution", part_of: [], latitude: null, longitude: null, wikidata: null },
  { o_id: 211, name: "University of Lagos African Cluster Centre (LACC)", kind: "institution", part_of: [],
    latitude: null, longitude: null, wikidata: null },
);
d.persons.push(
  { o_id: 120, name: "Vierke, Clarissa", affiliations: [] },
  { o_id: 121, name: "Vierke, Ulf", affiliations: [] },
);
const item = (oId, title, contributors) => ({ ...structuredClone(d.research_items[0]), o_id: oId, title, contributors,
  identifiers: [`FX_${oId}`], typed_identifiers: [{ value: `FX_${oId}`, type: "Locally defined identifier" }] });
d.research_items.push(
  item(520, "Swahili Poetry Notebook", [
    { name: "Vierke, Clarissa", role: "Author", o_id: 120 },
    { name: "Fendler, Ute", role: "Author", o_id: 101 },
    { name: "University of Lagos", role: "Publisher", o_id: 210 },
  ]),
  item(521, "Gallery Catalogue", [
    { name: "Vierke, Ulf", role: "Editor", o_id: 121 },
    { name: "Beier, Ulli", role: "Author", o_id: 100 },
  ]),
);
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "disambiguation" });
const { call, raw } = conn;
test.after(() => conn.close());

const url = (id) => lib.itemUrl(id);
async function errorOf(name, args) {
  const result = await raw(name, args);
  assert.equal(result.isError, true, `${name} should fail`);
  return JSON.parse(result.content[0].text).error;
}

// --- get_institution -----------------------------------------------------------

test("get_institution: an acronym in parentheses resolves like list_institutions finds it", async () => {
  assert.deepEqual((await call("list_institutions", { keyword: "LACC" })).results.map((r) => r.omeka_id), [211]);
  for (const name of ["LACC", "lacc", "African Cluster Centre"]) {
    assert.equal((await call("get_institution", { name })).omeka_id, 211, name);
  }
  assert.equal((await call("get_institution", { name: "University of Lagos" })).omeka_id, 210, "an exact name wins");
});

test("get_institution: words shared by several names are refused with the candidates; fragments stay not_found", async () => {
  const error = await errorOf("get_institution", { name: "Lagos" });
  assert.equal(error.code, "ambiguous_entity");
  assert.equal(error.suggested_tool, "list_institutions");
  assert.deepEqual(error.available_values, [
    "University of Lagos (organisation:210)",
    "University of Lagos African Cluster Centre (LACC) (organisation:211)",
  ]);
  assert.equal((await errorOf("get_institution", { name: "LAC" })).code, "not_found", "a fragment is a search, not a name");
});

// --- find_related ----------------------------------------------------------------

test("find_related: a surname shared by two people is refused with both ids", async () => {
  const error = await errorOf("find_related", { entity_type: "person", value: "Vierke" });
  assert.equal(error.code, "ambiguous_entity");
  assert.equal(error.suggested_tool, "resolve_entity");
  assert.deepEqual(error.available_values, ["Vierke, Clarissa (person:120)", "Vierke, Ulf (person:121)"]);
});

test("find_related: a full name or a person id pivots on that person only", async () => {
  for (const value of ["Clarissa Vierke", "Vierke, Clarissa", "person:120"]) {
    const rel = await call("find_related", { entity_type: "person", value });
    assert.equal(rel.ambiguous, false, value);
    assert.equal(rel.amira_url, url(120), value);
    assert.deepEqual(rel.sample_items.map((i) => i.omeka_id), [520], value);
    assert.deepEqual(rel.related_people.map((p) => p.name).sort(), ["Fendler, Ute", "University of Lagos"], value);
  }
  const ulf = await call("find_related", { entity_type: "person", value: "Ulf Vierke" });
  assert.deepEqual(ulf.sample_items.map((i) => i.omeka_id), [521]);
  assert.deepEqual(ulf.related_people.map((p) => p.name), ["Beier, Ulli"]);
});

// --- get_person ------------------------------------------------------------------

test("get_person: an institution credited on a shared record is not a collaborator", async () => {
  const clarissa = await call("get_person", { id: 120 });
  assert.equal(clarissa.contributed_item_count, 1);
  assert.deepEqual(clarissa.top_collaborators.map((c) => c.name), ["Fendler, Ute"]);
  assert.equal(clarissa.collaborator_count, 1);
});
