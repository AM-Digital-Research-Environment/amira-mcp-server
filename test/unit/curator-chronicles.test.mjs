// Curator mode and the Cluster Chronicles: chronicles join the visibility index
// and counts, a private chronicle text is matched by search_chronicles and
// paged under `restricted` by get_chronicle's own include_text arguments, and a
// retired private duplicate credited on a chronicle points to its public
// namesake. Served from the curator cache partition of a never contacted
// instance (as in curator-namesakes.test.mjs), with invented records.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv();
const secrets = tempDir("curator-chronicles");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, "key_identity=chronicleIdentityAAAAAAAAAAAAAAAAA\nkey_credential=chronicleCredentialBBBBBBBBBBBBBBB\n");
const SITE = "http://curator.invalid";
Object.assign(process.env, { AMIRA_ACCESS: "curator", AMIRA_SITE_BASE: SITE, AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_LIVE_REFRESH: "0", AMIRA_SEMANTIC_RELEASE: "off" });
const lib = await import("../../server/lib.js");

const PRIVATE_TEXT = "The ocelot-private-chronicle-token opens this unpublished poem, and the poem goes on for a while.";
const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
// A retired private duplicate of Beier, Ulli (100), depicted on a public poem whose text is private.
fx.data.persons.push({ o_id: 150, name: "Ulli Beier", affiliations: [], visibility: "private" });
const base = fx.data.chronicles[1];
fx.data.chronicles.push(
  { ...base, o_id: 562, title: "Unpublished poem", form: "poem", resource_class: "fabio:Poem", people: [{ name: "Fendler, Ute", role: "Author", o_id: 101 }],
    depicts: [{ label: "Ulli Beier", o_id: 150 }], relations: [], media: [], thumbnail: null, text: null,
    restricted: { fulltext: PRIVATE_TEXT } },
  { ...base, o_id: 563, title: "Withheld photograph", relations: [], media: [], thumbnail: null, visibility: "private" },
);
fx.manifest.counts = Object.fromEntries(Object.entries(fx.data).map(([k, v]) => [k, v.length]));
Object.assign(fx.manifest, { apiBase: `${SITE}/api`, fetchedAt: new Date().toISOString(), access: "curator" });
await lib.writeSnapshotAtomic(lib.cacheSnapshotDir(), fx);

const conn = await connectInMemory(lib, {}, { name: "curator-chronicles" });
const { call } = conn;
test.after(() => conn.close());

test("curator: chronicles join the overview's public/private split", async () => {
  const { visibility } = await call("get_collection_overview", {});
  assert.equal(visibility.public.chronicles, 3);
  assert.equal(visibility.private.chronicles, 1);
});

test("curator: a private chronicle is marked private, with an admin URL and no public link", async () => {
  const photo = await call("get_chronicle", { id: 563 });
  assert.equal(photo.visibility, "private");
  assert.equal(photo.amira_url, undefined);
  assert.ok(photo.admin_url.endsWith("/563"));
  assert.ok(photo.citation_note);
  const row = (await call("search_chronicles", { keyword: "Withheld" })).results[0];
  assert.deepEqual([row.omeka_id, row.visibility, row.amira_url], [563, "private", undefined]);
});

test("curator: search_chronicles matches a private text only as restricted_text, with the note", async () => {
  const hits = await call("search_chronicles", { keyword: "ocelot-private-chronicle-token" });
  assert.equal(hits.total_matches, 1);
  const [row] = hits.results;
  assert.deepEqual([row.omeka_id, row.matched_in, row.has_text, row.has_restricted_text], [562, "restricted_text", false, true]);
  assert.ok(row.text_snippet.includes("ocelot-private-chronicle-token"));
  assert.equal(hits.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
  // Multi-word: every word, in any order, across the private text.
  assert.equal((await call("search_chronicles", { keyword: "poem ocelot-private-chronicle-token" })).total_matches, 1);
  assert.equal((await call("search_chronicles", { keyword: "Harbour" })).restricted_match_note, undefined);
});

test("curator: the private text sits under `restricted`, paged by include_text / text_offset / text_max_chars", async () => {
  const closed = await call("get_chronicle", { id: "chronicle:562" });
  assert.deepEqual([closed.has_text, closed.text, closed.has_restricted_text], [false, undefined, true]);
  assert.equal(closed.restricted.has_text, true);
  assert.equal(closed.restricted.text_length, PRIVATE_TEXT.length);
  assert.equal(closed.restricted.text, undefined, "the private text is opt-in too");
  assert.match(closed.restricted.text_hint, /include_text=true/);
  assert.equal(closed.restricted.fulltext, undefined, "the window takes get_chronicle's own field name");

  const page = await call("get_chronicle", { id: 562, include_text: true, text_offset: 4, text_max_chars: 10 });
  assert.equal(page.text, null, "no public text");
  assert.equal(page.restricted.text, PRIVATE_TEXT.slice(4, 14));
  assert.deepEqual([page.restricted.text_offset, page.restricted.text_truncated, page.restricted.text_next_offset], [4, true, 14]);
  assert.ok(!JSON.stringify({ ...page, restricted: undefined }).includes("ocelot"), "the private text appears only under restricted");

  // A public work asked for its (absent) private text says so.
  assert.equal((await call("get_chronicle", { id: 560, include_text: true })).restricted.has_text, false);
});

test("curator: get_text_passages does not search a private chronicle text and says where to read it", async () => {
  const r = await call("get_text_passages", { ids: ["chronicle:562"], keyword: "ocelot-private-chronicle-token" });
  assert.equal(r.total_matches, 0);
  assert.equal(r.unavailable[0].reason, "no_text");
  assert.match(r.unavailable[0].note, /get_chronicle with include_text/);
});

test("curator: a depicted private duplicate is marked and points to its public namesake", async () => {
  const poem = await call("get_chronicle", { id: 562 });
  const [shown] = poem.depicts;
  assert.equal(shown.visibility, "private");
  assert.equal(shown.amira_url, undefined);
  assert.deepEqual(shown.possible_duplicate_of, { name: "Beier, Ulli", omeka_id: 100, amira_url: lib.itemUrl(100), visibility: "public" });
});
