// Fixes from the repository audit, through the tools.
// #53: a whitespace-only array is refused, not emptied after validation; "null"
// resolves to nothing; publication facets keep namesake authorities apart; an
// aliased id and its Omeka id are one document.
// #45: a Series venue (not crawled) is no journal node.
// #54: get_publication gates its languages like the other structured fields.
//
// The shared fixture is extended HERE, in this process only: publication 512 by
// a second "Fendler, Ute" authority (o_id 102) and by an unlinked "Beier, Ulli",
// in a Series item (45032) the snapshot does not hold.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv({ dataDir: "absent" });
const lib = await import("../../server/lib.js");
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
d.publications.push({
  ...structuredClone(d.publications[1]), o_id: 512, pub_id: "eref-512", title: "Namesake Fixture",
  authors: [{ label: "Fendler, Ute", o_id: 102 }, { label: "Beier, Ulli", o_id: null }],
  venue: "University of Bayreuth African Studies Working Papers",
  venue_ref: { label: "University of Bayreuth African Studies Working Papers", o_id: 45032 },
});
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(process.env.AMIRA_DATA_DIR, fixture);
const conn = await connectInMemory(lib, {}, { name: "audit-fixes" });
const { call } = conn;
test.after(() => conn.close());

test("a whitespace-only array is invalid_argument, not an empty result", async () => {
  const err = (await call("get_text_passages", { ids: ["   "], keyword: "zanzibar" })).error;
  assert.equal(err.code, "invalid_argument");
  assert.match(err.message, /`ids` must not be empty/);
  // A blank entry beside a real one is dropped, as before.
  const page = await call("get_text_passages", { ids: ["  ", "publication:510"], keyword: "zanzibar-fulltext-token" });
  assert.equal(page.total_matches, 30);
  assert.deepEqual(page.unavailable_ids, []);
});

test("resolve_entity('null') matches no entity without an Omeka id", async () => {
  const r = await call("resolve_entity", { query: "null" });
  assert.equal(r.total_matches, 0);
});

test("list_publication_facets keeps namesake authorities apart; an unlinked label joins its single linked bucket", async () => {
  const authors = (await call("list_publication_facets", { facet: "author" })).results;
  const fendler = authors.filter((r) => r.value === "Fendler, Ute");
  assert.deepEqual(fendler.map((r) => [r.amira_url, r.publication_count]).sort(),
    [[lib.itemUrl(101), 1], [lib.itemUrl(102), 1]]);
  // "Beier, Ulli" is linked (100) on 511 and unlinked on 512: one bucket, two publications.
  assert.deepEqual(authors.filter((r) => r.value === "Beier, Ulli").map((r) => [r.amira_url, r.publication_count]),
    [[lib.itemUrl(100), 2]]);
});

test("get_text_passages: an aliased id and its Omeka id are one document", async () => {
  const page = await call("get_text_passages", { ids: ["publication:eref-510", "publication:510"], keyword: "zanzibar-fulltext-token" });
  assert.equal(page.total_matches, 30, "matches counted once");
  assert.deepEqual(page.unavailable_ids, []);
});

test("a Series venue is not typed as a journal; a crawled journal still is (#45)", async () => {
  assert.equal((await call("resolve_entity", { query: "journal:45032" })).total_matches, 0);
  const graph = await call("get_entity_graph", { seed: "publication:512" });
  assert.ok(!graph.nodes.some((n) => n.omeka_id === 45032), "no node for the uncrawled series");
  const journal = await call("get_entity_graph", { seed: "publication:510" });
  assert.ok(journal.nodes.some((n) => n.id === "journal:520"));
});

test("get_publication keeps its languages with the other structured fields (#54)", async () => {
  assert.equal((await call("get_publication", { id: 510 })).language, "English");
  process.env.AMIRA_EXPOSURE = "minimal";
  try {
    const p = await call("get_publication", { id: 510 });
    assert.equal(p.authors, undefined);
    assert.equal(p.language, undefined);
    assert.equal(p.languages, undefined);
  } finally { delete process.env.AMIRA_EXPOSURE; }
});

test("completions and the record resource follow the exposure level (#56)", async () => {
  const kinds = async () => (await conn.client.complete({ ref: { type: "ref/resource", uri: "amira://record/{kind}/{id}" },
    argument: { name: "kind", value: "" } })).completion.values;
  const people = () => conn.client.complete({ ref: { type: "ref/prompt", name: "person_profile" }, argument: { name: "name", value: "Fen" } });
  assert.ok((await people()).completion.values.length > 0);
  assert.ok((await kinds()).includes("location"));
  process.env.AMIRA_EXPOSURE = "minimal";
  try {
    assert.deepEqual((await people()).completion.values, [], "no person vocabulary below structured");
    const restricted = await kinds();
    assert.ok(!restricted.includes("location") && !restricted.includes("subject"), restricted.join());
    // Refused, not "not found": the record exists.
    await assert.rejects(conn.client.readResource({ uri: "amira://record/location/900" }), /exposure_restricted/);
  } finally { delete process.env.AMIRA_EXPOSURE; }
  const missing = await conn.client.readResource({ uri: "amira://record/research_item/999999" }).catch((e) => e);
  assert.match(String(missing.message), /No research_item with id 999999/);
  assert.equal(missing.code, -32602, "a missing record stays ResourceNotFound");
});

test("a detail tool's other errors keep their code through amira://record (#56)", () => {
  const body = (code, message) => JSON.stringify({ error: { code, message } });
  const missing = lib.recordError("amira://record/video/1", body("not_found", "gone"), "No video with id 1.");
  assert.equal(missing.code, -32602);
  assert.match(missing.message, /No video with id 1/);
  const late = lib.recordError("amira://record/video/1", body("deadline_exceeded", "Took too long."), "No video with id 1.");
  assert.equal(late.code, -32603);
  assert.equal(late.message, "deadline_exceeded: Took too long.");
  assert.deepEqual(late.data, { code: "deadline_exceeded" });
  const refused = lib.recordError("amira://record/video/1", body("exposure_restricted", "Not at this level."), "No video with id 1.");
  assert.equal(refused.code, -32600);
  assert.equal(lib.recordError("amira://record/video/1", "not json", "No video with id 1.").code, -32602);
});

test("a tool profile registers only the prompts whose tools it serves (#56)", async () => {
  for (const profile of Object.keys(lib.TOOL_PROFILES)) {
    const served = lib.allowedTools(profile);
    const c = await connectInMemory(lib, { profile }, { name: `prompts-${profile}` });
    try {
      const names = (await c.client.listPrompts()).prompts.map((p) => p.name).sort();
      const expected = Object.entries(lib.PROMPT_TOOLS).filter(([, tools]) => !served || tools.every((t) => served.has(t)))
        .map(([name]) => name).sort();
      assert.deepEqual(names, expected, profile);
      assert.ok(names.length > 0, `${profile} keeps at least one prompt`);
      const kinds = (await c.client.complete({ ref: { type: "ref/resource", uri: "amira://record/{kind}/{id}" },
        argument: { name: "kind", value: "" } })).completion.values;
      if (served && !served.has("get_podcast")) assert.ok(!kinds.includes("podcast"), `${profile}: ${kinds.join()}`);
    } finally { await c.close(); }
  }
  const visualization = await connectInMemory(lib, { profile: "visualization" }, { name: "prompts-vis" });
  try {
    const names = (await visualization.client.listPrompts()).prompts.map((p) => p.name);
    assert.ok(!names.includes("person_profile"), "get_person is not in the visualization profile");
  } finally { await visualization.close(); }
});
