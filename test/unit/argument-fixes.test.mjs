// Tool arguments and results (#53): a whitespace-only array is refused, not
// emptied after validation; "null" resolves to nothing; publication facets keep
// namesake authorities apart; an aliased id and its Omeka id are one document.
//
// The shared fixture is extended HERE, in this process only: publication 512 by
// a second "Fendler, Ute" authority (o_id 102) and by an unlinked "Beier, Ulli".
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
});
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(process.env.AMIRA_DATA_DIR, fixture);
const conn = await connectInMemory(lib, {}, { name: "argument-fixes" });
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
