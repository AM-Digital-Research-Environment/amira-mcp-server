// Curator mode: retired private duplicates of public authority records. Name
// resolution lands on the public record without reporting ambiguity, lists put
// the private copy after the public one, and the private copy points to it.
//
// The curator store is served from the curator cache partition of a never
// contacted instance (as in curator-config.test.mjs), with invented records.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv();
const secrets = tempDir("curator-namesakes");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, "key_identity=namesakeIdentityAAAAAAAAAAAAAAAAAA\nkey_credential=namesakeCredentialBBBBBBBBBBBBBBBB\n");
const SITE = "http://curator.invalid";
Object.assign(process.env, { AMIRA_ACCESS: "curator", AMIRA_SITE_BASE: SITE, AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_LIVE_REFRESH: "0", AMIRA_SEMANTIC_RELEASE: "off" });
const lib = await import("../../server/lib.js");

const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
fx.data.persons.push({ o_id: 150, name: "Ulli Beier", affiliations: [], visibility: "private" });
fx.data.organisations.push({ o_id: 250, name: "University of Bayreuth", kind: "institution", part_of: [], latitude: null, longitude: null,
  wikidata: null, visibility: "private" });
fx.manifest.counts = Object.fromEntries(Object.entries(fx.data).map(([k, v]) => [k, v.length]));
Object.assign(fx.manifest, { apiBase: `${SITE}/api`, fetchedAt: new Date().toISOString(), access: "curator" });
await lib.writeSnapshotAtomic(lib.cacheSnapshotDir(), fx);

const conn = await connectInMemory(lib, {}, { name: "curator-namesakes" });
const { call } = conn;
test.after(() => conn.close());

const POINTER_UBT = { name: "University of Bayreuth", omeka_id: 200, amira_url: lib.itemUrl(200), visibility: "public" };
const POINTER_BEIER = { name: "Beier, Ulli", omeka_id: 100, amira_url: lib.itemUrl(100), visibility: "public" };

test("curator store holds the private duplicates", async () => {
  const store = await lib.ensureStore();
  assert.equal(store.manifest.access, "curator");
  assert.equal(store.getPersonByOId(150).visibility, "private");
});

test("by name, the public record wins over its private duplicate, without ambiguity", async () => {
  const org = await call("get_institution", { name: "University of Bayreuth" });
  assert.deepEqual([org.omeka_id, org.possible_duplicate_of], [200, undefined]);
  const person = await call("get_person", { name: "Ulli Beier" });
  assert.deepEqual([person.omeka_id, person.possible_duplicate_of], [100, undefined]);
  for (const [query, type, id] of [["University of Bayreuth", "organisation", "organisation:200"], ["Ulli Beier", "person", "person:100"],
    ["Beier, Ulli", undefined, "person:100"]]) {
    const r = await call("resolve_entity", { query, ...(type ? { type } : {}) });
    assert.deepEqual([r.ambiguous, r.results.map((e) => e.id)], [false, [id]], query);
  }
  const rel = await call("find_related", { entity_type: "person", value: "Ulli Beier" });
  assert.deepEqual([rel.ambiguous, rel.amira_url], [false, lib.itemUrl(100)]);
});

test("the private duplicate points to the public record, in detail and in lists, after the public one", async () => {
  const org = await call("get_institution", { id: 250 });
  assert.deepEqual([org.visibility, org.possible_duplicate_of], ["private", POINTER_UBT]);
  const person = await call("get_person", { id: 150 });
  assert.deepEqual(person.possible_duplicate_of, POINTER_BEIER);

  const persons = await call("search_persons", { keyword: "Beier" });
  assert.deepEqual(persons.results.map((r) => [r.omeka_id, r.possible_duplicate_of]), [[100, undefined], [150, POINTER_BEIER]]);
  const institutions = await call("list_institutions", { keyword: "Bayreuth" });
  assert.deepEqual(institutions.results.map((r) => [r.omeka_id, r.possible_duplicate_of]), [[200, undefined], [250, POINTER_UBT]]);
  const partial = await call("resolve_entity", { query: "Beier", type: "person" });
  assert.deepEqual(partial.results.map((e) => [e.id, e.possible_duplicate_of]), [["person:100", undefined], ["person:150", POINTER_BEIER]]);
});

test("only a private record has a public namesake", async () => {
  const store = await lib.ensureStore();
  assert.equal(lib.publicNamesakeOf(store, store.getPersonByOId(100), "person"), undefined);
  assert.equal(lib.publicNamesakeOf(store, store.getPersonByOId(150), "person").o_id, 100);
  assert.equal(lib.publicNamesakeOf(store, store.getOrganisationByOId(250), "organisation").o_id, 200);
});
