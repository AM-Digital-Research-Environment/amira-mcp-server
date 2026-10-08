// Near-miss person suggestions (src/names.ts, src/tools/people.ts).
//
// The JCDL evaluation planted "Rudigr Seeman" for "Seesemann, Rüdiger": both
// search_persons and resolve_entity returned a bare empty list and the model
// corrected the spelling on its own. An empty person search now offers the
// authority names a typo away. A search that finds someone is unchanged, and
// AMIRA_GUIDANCE=off withholds the suggestions.
//
// The fixture is extended in this process only: Seesemann, and Seemann as a
// distractor that is closer for a one-word query and not a near miss for the
// full name.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
fixture.data.persons.push(
  { o_id: 110, name: "Seesemann, Rüdiger", affiliations: [{ label: "University of Bayreuth", o_id: 200 }] },
  { o_id: 111, name: "Seemann, Jörg", affiliations: [] },
);
fixture.manifest.counts.persons = fixture.data.persons.length;
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "suggestions" });
const { call } = conn;
test.after(() => conn.close());

const url = (id) => lib.itemUrl(id);
const SEESEMANN = { id: "person:110", name: "Seesemann, Rüdiger", amira_url: url(110) };
const SEEMANN = { id: "person:111", name: "Seemann, Jörg", amira_url: url(111) };
const HINT = "No person has this name. These authority names are spelled similarly; confirm one is the person meant before using it.";
const EMPTY = { count: 0, total_matches: 0, offset: 0, has_more: false, results: [] };

// --- the matcher -------------------------------------------------------------------

test("editDistance counts insertions, deletions, substitutions and adjacent swaps", () => {
  assert.equal(lib.editDistance("rudigr", "rudiger"), 1);
  assert.equal(lib.editDistance("seeman", "seesemann"), 3);
  assert.equal(lib.editDistance("beier", "beier"), 0);
  assert.equal(lib.editDistance("beier", "beeir"), 1, "a transposition is one edit");
  assert.equal(lib.editDistance("", "abc"), 3);
  assert.equal(lib.editDistance("seeman", "seesemann", 2), 3, "gives up past max, returning max + 1");
  assert.equal(lib.editDistance("a", "abcdef", 1), 2);
});

test("nameNearMiss: either name order, accents ignored, one edit per three characters", () => {
  const forward = lib.nameNearMiss("Seesemann, Rüdiger", "Rudigr Seeman");
  assert.ok(forward !== null && forward > 0);
  assert.equal(lib.nameNearMiss("Seesemann, Rüdiger", "Seeman Rudigr"), forward);
  assert.equal(lib.nameNearMiss("Seesemann, Rüdiger", "RÜDIGR SEEMAN"), forward);
  assert.equal(lib.nameNearMiss("Seesemann, Rüdiger", "Rüdiger Seesemann"), 0);
  assert.ok(lib.nameNearMiss("Seesemann, Rüdiger", "Seeman") !== null, "one token may match one name token");
  assert.ok(lib.nameNearMiss("Kaboré, Awa", "Awa Kabure") !== null);
  assert.ok(lib.nameNearMiss("Beier, Ulli Rainer", "Uli Beir") !== null, "the name may carry extra tokens");
  assert.equal(lib.nameNearMiss("Seesemann, Rüdiger", "Rudigr Smith"), null, "every query token needs a partner");
  assert.equal(lib.nameNearMiss("Seemann, Jörg", "Rudigr Seeman"), null);
  assert.equal(lib.nameNearMiss("Ba, Amadou", "Bo Amadou"), null, "tokens under three characters must match exactly");
  assert.equal(lib.nameNearMiss("Beier, Ulli", "Ulli Ulli Beier"), null, "more query tokens than name tokens");
  assert.equal(lib.nameNearMiss("Beier, Ulli", ""), null);
});

test("nearMissNames ranks the closest first, then by name, and checks name variants", () => {
  const people = [
    { name: "Seesemann, Rüdiger" }, { name: "Seemann, Jörg" }, { name: "Beier, Ulli" },
    { name: "Ojo, Ade", alt_names: ["Adeyemi Ojo"] },
  ];
  assert.deepEqual(lib.nearMissNames(people, "Seeman").map((p) => p.name), ["Seemann, Jörg", "Seesemann, Rüdiger"]);
  assert.deepEqual(lib.nearMissNames(people, "Seeman", 1).map((p) => p.name), ["Seemann, Jörg"]);
  assert.deepEqual(lib.nearMissNames(people, "Rudigr Seeman").map((p) => p.name), ["Seesemann, Rüdiger"]);
  assert.deepEqual(lib.nearMissNames(people, "Adeyemy Ojo").map((p) => p.name), ["Ojo, Ade"]);
  assert.deepEqual(lib.nearMissNames(people, "Nobody Atall"), []);
});

// --- the tools ---------------------------------------------------------------------

test("search_persons: 'Rudigr Seeman' surfaces Seesemann, Rüdiger, in either order", async () => {
  for (const keyword of ["Rudigr Seeman", "Seeman Rudigr"]) {
    assert.deepEqual(await call("search_persons", { keyword }),
      { filters: { keyword }, ...EMPTY, suggestions: [SEESEMANN], hint: HINT }, keyword);
  }
  // "Seeman" is a prefix of Seemann: a match, so nothing is suggested.
  const prefix = await call("search_persons", { keyword: "Seeman" });
  assert.deepEqual([prefix.results.map((p) => p.name), "suggestions" in prefix], [[SEEMANN.name], false]);
});

test("resolve_entity (type person): 'Rudigr Seeman' surfaces Seesemann, Rüdiger", async () => {
  const found = await call("resolve_entity", { query: "Rudigr Seeman", type: "person" });
  assert.deepEqual(found.results, []);
  assert.deepEqual(found.suggestions, [SEESEMANN]);
  assert.equal(found.hint, HINT);
  // Suggestions are for person queries only.
  for (const args of [{ query: "Rudigr Seeman" }, { query: "Rudigr Seeman", type: "project" }]) {
    const other = await call("resolve_entity", args);
    assert.equal(other.total_matches, 0);
    assert.ok(!("suggestions" in other) && !("hint" in other), JSON.stringify(args));
  }
});

test("default mode: a search that finds someone is unchanged, and nothing is suggested without a near miss", async () => {
  const seesemann = { id: "110", omeka_id: 110, name: "Seesemann, Rüdiger", affiliations: ["University of Bayreuth"], amira_url: url(110) };
  assert.deepEqual(await call("search_persons", { keyword: "Rüdiger Seesemann" }),
    { filters: { keyword: "Rüdiger Seesemann" }, count: 1, total_matches: 1, offset: 0, has_more: false, results: [seesemann] });
  const resolved = await call("resolve_entity", { query: "Seesemann", type: "person" });
  assert.deepEqual(Object.keys(resolved).sort(), ["ambiguous", "count", "has_more", "offset", "results", "snapshot_id", "total_matches"]);
  assert.deepEqual(resolved.results.map((e) => e.id), ["person:110"]);
  for (const args of [
    { keyword: "Nobody Atall" }, // no near miss
    { keyword: "Seesemann", affiliation: "Lagos" }, // the name matched; the filter removed it
    { keyword: "Seesemann", offset: 5 }, // a page past the end of a non-empty result
    { affiliation: "Nowhere" }, // no name to correct
    { keyword: "Rudigr Seeman", affiliation: "Lagos" }, // the affiliation rules out the near miss
  ]) {
    const page = await call("search_persons", args);
    assert.equal(page.count, 0, JSON.stringify(args));
    assert.ok(!("suggestions" in page) && !("hint" in page), JSON.stringify(args));
  }
  assert.deepEqual((await call("search_persons", { keyword: "Rudigr Seeman", affiliation: "Bayreuth" })).suggestions, [SEESEMANN]);
});

test("AMIRA_GUIDANCE=off: an empty person search stays empty", async () => {
  process.env.AMIRA_GUIDANCE = "off";
  try {
    const off = await connectInMemory(lib, {}, { name: "suggestions-off" });
    try {
      assert.deepEqual(await off.call("search_persons", { keyword: "Rudigr Seeman" }), { filters: { keyword: "Rudigr Seeman" }, ...EMPTY });
      const resolved = await off.call("resolve_entity", { query: "Rudigr Seeman", type: "person" });
      assert.ok(!("suggestions" in resolved) && !("hint" in resolved));
    } finally {
      await off.close();
    }
  } finally {
    delete process.env.AMIRA_GUIDANCE;
  }
});
