// Curator mode (#26): the presentation contract of the decoration step
// (src/tools/curator.ts) beyond the basics of curator.test.mjs: records outside
// the crawled corpora, languages, media rows and files, IIIF, every URL form,
// `search`/`fetch` rows, exports, collection nodes, the restricted block's
// edges, curator notes, prompts and instructions.
//
// The Omeka stub gets extra fixtures (all invented): a private and a public
// format authority outside every crawled corpus, a private language, a public
// item linking to all three with a private media as its thumbnail and a long
// private value, and a private item with a public media (IIIF manifest).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";
import { IDS, KEY, PRIVATE, STUB_BASE, startOmekaStub } from "../helpers/omeka-stub.mjs";

hermeticEnv();
const secrets = tempDir("curator-presentation");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `carol ${createHash("sha256").update("amira_cur_carol-test-token-0123456789abcdefghijklmn").digest("hex")}\n`);

const X = { privateFormat: 7601, publicFormat: 7602, privateLanguage: 7701, linkedItem: 7105, privateDigitised: 7104,
  publicOfPrivate: 9903, privateThumbMedia: 9904 };
const LONG_PRIVATE = "walrus-long-private-value ".repeat(1100); // > 25,000 characters
const stamp = { "o:created": { "@value": "2026-10-01T00:00:00+00:00" }, "o:modified": { "@value": "2026-11-01T00:00:00+00:00" } };
const lit = (v, extra = {}) => ({ type: "literal", "@value": v, is_public: true, ...extra });
const res = (id, title) => ({ type: "resource:item", "@id": `${STUB_BASE}/api/items/${id}`, value_resource_id: id, display_title: title, is_public: true });
const item = (id, isPublic, title, fields = {}) => ({ "o:id": id, "@id": `${STUB_BASE}/api/items/${id}`, "o:is_public": isPublic, "o:title": title,
  ...stamp, "dcterms:title": [lit(title)], ...fields });

const stub = await startOmekaStub({
  extraItems: [
    ["resource_template_id=99", item(X.privateFormat, false, "Retired Format Authority")],
    ["resource_template_id=99", item(X.publicFormat, true, "Field Recording Format")],
    ["item_set_id=19", item(X.privateLanguage, false, "Secret Language")],
    ["resource_template_id=10", item(X.linkedItem, true, "Linked Public Item", {
      "o:media": [{ "o:id": X.privateThumbMedia }],
      thumbnail_display_urls: { large: `${STUB_BASE}/files/large/private-thumb-stem.jpg` },
      "dcterms:type": [lit("Image")], "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")],
      "dcterms:format": [res(X.privateFormat, "Retired Format Authority"), res(X.publicFormat, "Field Recording Format")],
      "dcterms:language": [res(X.privateLanguage, "Secret Language")],
      "dcterms:abstract": [lit(LONG_PRIVATE, { is_public: false })],
      "dcterms:created": [lit("1999")] })],
    ["resource_template_id=10", item(X.privateDigitised, false, "Private Digitised Item", {
      "o:media": [{ "o:id": X.publicOfPrivate }], "dcterms:type": [lit("Text")],
      "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")], "dcterms:created": [lit("2001")] })],
  ],
  extraMedia: [
    { "o:id": X.publicOfPrivate, "@id": `${STUB_BASE}/api/media/${X.publicOfPrivate}`, "o:is_public": true,
      "o:item": { "o:id": X.privateDigitised }, "o:media_type": "application/pdf",
      "o:original_url": `${STUB_BASE}/files/original/public-of-private.pdf`, "o:source": "scan.pdf", "o:size": 10 },
    { "o:id": X.privateThumbMedia, "@id": `${STUB_BASE}/api/media/${X.privateThumbMedia}`, "o:is_public": false,
      "o:item": { "o:id": X.linkedItem }, "o:media_type": "image/tiff",
      "o:original_url": `${STUB_BASE}/files/original/private-thumb-stem.tif`, "o:source": "thumb.tif", "o:size": 20 },
  ],
});
test.after(() => stub.close());

const SITE = "https://amira.example";
Object.assign(process.env, {
  AMIRA_ACCESS: "curator", AMIRA_SITE_BASE: SITE, AMIRA_API_BASE: stub.api, AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile, AMIRA_ENRICHMENT_BASE: `${stub.base}/github`, AMIRA_SEMANTIC_RELEASE: "off",
});
const originalError = console.error;
console.error = () => {};
test.after(() => { console.error = originalError; });

const lib = await import("../../server/lib.js");
await lib.refreshNow();
const conn = await connectInMemory(lib, { openai: true });
test.after(() => conn.close());
const { call } = conn;
const read = async (uri) => (await conn.client.readResource({ uri })).contents[0].text;
const store = () => lib.currentStore();

const adminItem = (id) => `${SITE}/admin/item/${id}`;
const publicItem = (id) => `${SITE}/s/amira/item/${id}`;

test("the curator snapshot lists every private item, crawled corpus or not", () => {
  const ids = store().manifest.privateItemIds;
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  for (const id of [IDS.privateItem, IDS.privatePerson, IDS.privatePub, X.privateFormat, X.privateLanguage, X.privateDigitised]) {
    assert.ok(ids.includes(id), `${id} is listed`);
  }
  for (const id of [IDS.publicItem, X.publicFormat, X.linkedItem]) assert.ok(!ids.includes(id), `${id} is public`);
});

test("records outside the crawled corpora and languages carry visibility; a private one has no public link", async () => {
  const graph = await call("get_entity_graph", { seed: `research_item:${X.linkedItem}` });
  const node = (id) => graph.nodes.find((n) => n.omeka_id === id || n.id?.endsWith(`:${id}`));
  const privFormat = node(X.privateFormat);
  assert.ok(privFormat, "the private format is a node");
  assert.equal(privFormat.visibility, "private");
  assert.equal(privFormat.amira_url, undefined);
  assert.equal(privFormat.admin_url, adminItem(X.privateFormat));
  assert.match(privFormat.citation_note, /not publicly accessible/);
  assert.equal(node(X.publicFormat).visibility, "public");
  assert.equal(node(X.publicFormat).amira_url, publicItem(X.publicFormat));
  const lang = node(X.privateLanguage);
  assert.equal(lang.visibility, "private");
  assert.equal(lang.admin_url, adminItem(X.privateLanguage));
  assert.ok(!JSON.stringify(graph).includes(publicItem(X.privateFormat)));
});

test("the overview counts languages, private ones included", async () => {
  const overview = await call("get_collection_overview");
  assert.equal(overview.visibility.private.languages, 1);
  assert.equal(typeof overview.visibility.public.languages, "number");
});

test("an id the snapshot cannot classify gets no visibility and no rewrite; a listed one is classified", () => {
  const s = store();
  const listed = lib.curatorValue({ omeka_id: 999999, amira_url: publicItem(999999) }, s, { detail: false });
  assert.equal(listed.visibility, "public", "not in the private list: public");
  const data = { research_items: s.items, projects: s.projects, persons: s.persons, organisations: s.organisations, locations: s.locations,
    research_sections: s.sections, publications: s.publications, journals: s.journals, podcasts: s.podcasts, videos: s.videos,
    playlists: s.playlists, languages: s.languageIndex.all, item_sets: s.itemSets, subjects: s.subjects };
  const { privateItemIds: _drop, ...manifest } = s.manifest;
  const old = new lib.DataStore("cache", data, manifest);
  const unknown = lib.curatorValue({ omeka_id: X.privateFormat, amira_url: publicItem(X.privateFormat) }, old, { detail: false });
  assert.equal(unknown.visibility, undefined);
  assert.equal(unknown.amira_url, publicItem(X.privateFormat), "no guess either way");
  // Corpus records are still classified from the store.
  assert.equal(lib.curatorValue({ amira_url: publicItem(IDS.privateItem) }, old).visibility, "private");
});

test("media rows carry visibility; a private file is never linked, only its admin page; its thumbnail is dropped", async () => {
  const pub = await call("get_research_item", { id: IDS.publicItem });
  const byType = Object.fromEntries(pub.media.map((m) => [m.type, m]));
  assert.equal(byType["audio/mpeg"].visibility, "public");
  assert.equal(byType["audio/mpeg"].url, `${SITE}/files/original/public-recording.mp3`);
  assert.equal(byType["image/tiff"].visibility, "private");
  assert.equal(byType["image/tiff"].url, null);
  assert.equal(byType["image/tiff"].admin_url, `${SITE}/admin/media/${IDS.privateMedia}`);
  assert.ok(!JSON.stringify(pub).includes(`/files/original/${PRIVATE.mediaUrl}`), "listed by its source name, never by its file URL");

  const linked = await call("get_research_item", { id: X.linkedItem });
  assert.equal(linked.thumbnail, null, "the thumbnail came from a private media");
  assert.equal(linked.media[0].admin_url, `${SITE}/admin/media/${X.privateThumbMedia}`);
  assert.ok(!JSON.stringify(linked).includes("private-thumb-stem"));
  assert.match(linked.iiif_manifest, /\/iiif\/3\/7105\/manifest$/, "a public item keeps its manifest");
});

test("a private record has no IIIF manifest; a private item set no IIIF collection and an item-set admin URL", async () => {
  const priv = await call("get_research_item", { id: X.privateDigitised });
  assert.equal(priv.visibility, "private");
  assert.equal(priv.iiif_manifest, null);
  assert.equal(priv.media[0].visibility, "public");
  // The fixture's private set belongs to a public project's collection, so it is cited as the set itself here.
  const set = lib.curatorValue({ omeka_id: IDS.privateSet, amira_url: `${SITE}/s/amira/item-set/${IDS.privateSet}`,
    iiif_collection: `${SITE}/iiif/3/collection/${IDS.privateSet}` }, store());
  assert.equal(set.visibility, "private");
  assert.equal(set.amira_url, undefined);
  assert.equal(set.admin_url, `${SITE}/admin/item-set/${IDS.privateSet}`);
  assert.equal(set.iiif_collection, null);
});

test("every URL form of a private resource in a string is rewritten", () => {
  const s = store();
  const text = [
    `http://amira.example/s/amira/item/${IDS.privateItem}`, `${SITE}/api/items/${IDS.privateItem}`,
    `${SITE}/iiif/3/${X.privateDigitised}/manifest`, `${SITE}/iiif/3/collection/${IDS.privateSet}`,
    `${SITE}/files/original/${PRIVATE.mediaUrl}`, `${SITE}/files/large/private-thumb-stem.jpg`,
    `${SITE}/s/amira/item/${IDS.publicItem}`, `${SITE}/files/original/public-recording.mp3`,
  ].join(" ");
  assert.equal(lib.curatorText(text, s), [
    adminItem(IDS.privateItem), adminItem(IDS.privateItem), adminItem(X.privateDigitised), `${SITE}/admin/item-set/${IDS.privateSet}`,
    `${SITE}/admin/media/${IDS.privateMedia}`, `${SITE}/admin/media/${X.privateThumbMedia}`,
    publicItem(IDS.publicItem), `${SITE}/files/original/public-recording.mp3`,
  ].join(" "));
});

test("search rows and fetch documents cited by url carry visibility", async () => {
  const found = await call("search", { query: PRIVATE.itemTitle });
  const row = found.results.find((r) => r.id.endsWith(`:${IDS.privateItem}`));
  assert.ok(row);
  assert.equal(row.url, adminItem(IDS.privateItem));
  assert.equal(row.visibility, "private");
  assert.match(row.citation_note, /not publicly accessible/);
  const doc = await call("fetch", { id: row.id });
  assert.equal(doc.visibility, "private");
  assert.equal(doc.url, adminItem(IDS.privateItem));
  const pub = await call("search", { query: "Plain Public Item" });
  assert.equal(pub.results.find((r) => r.id.endsWith(`:${IDS.plainItem}`)).visibility, "public");
});

test("a JSONL export gets the URL rewrite only, whatever its row count", async () => {
  const one = await read(lib.exportUri("research_items", "jsonl", { keyword: "Public Field Recording" }));
  assert.ok(one.endsWith("}\n"), "the trailing newline stays");
  const rows = one.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].visibility, "public");
  assert.equal(rows[0].restricted, undefined, "a one-row file is not a detail result");
  assert.ok(!one.includes(PRIVATE.security) && !one.includes(PRIVATE.mongoId));
  const two = (await read(lib.exportUri("publications", "jsonl", {}))).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(two.length, 2);
  assert.ok(two.every((r) => r.restricted === undefined && r.visibility));
  assert.equal(two.find((r) => r.omeka_id === IDS.privatePub).admin_url, adminItem(IDS.privatePub));
});

test("a node citing another record's page takes the most restrictive visibility", () => {
  const s = store();
  const privSet = lib.curatorValue({ omeka_id: IDS.privateSet, amira_url: publicItem(IDS.project) }, s, { detail: false });
  assert.equal(privSet.visibility, "private");
  assert.equal(privSet.amira_url, publicItem(IDS.project), "the public project page stays");
  assert.equal(privSet.admin_url, `${SITE}/admin/item-set/${IDS.privateSet}`);
  const privPage = lib.curatorValue({ omeka_id: IDS.publicSet, amira_url: publicItem(IDS.privateItem) }, s, { detail: false });
  assert.equal(privPage.visibility, "private");
  assert.equal(privPage.amira_url, undefined);
  assert.equal(privPage.admin_url, adminItem(IDS.privateItem));
});

test("restricted: no private full text is said; long private values carry a marker; windows share one budget", async () => {
  const none = await call("get_research_item", { id: IDS.plainItem, include_fulltext: true });
  assert.equal(none.restricted.has_fulltext, false);
  const without = await call("get_research_item", { id: IDS.plainItem });
  assert.equal(without.restricted, undefined, "nothing asked, nothing to say");

  const linked = await call("get_research_item", { id: X.linkedItem });
  const value = linked.restricted.values["dcterms:abstract"][0];
  assert.match(value, /\[…truncated: \d+ characters in all\]$/);
  assert.ok(value.length < LONG_PRIVATE.length);

  const shared = lib.curatorValue({ omeka_id: IDS.publicItem, fulltext_returned_chars: 24_990 }, store(),
    { tool: "get_publication", args: { include_fulltext: true } });
  assert.ok(shared.restricted.fulltext_returned_chars <= 10, "the restricted window fits what the public one left");
  assert.equal(shared.restricted.fulltext_truncated, true);
});

test("curator notes: private full-text matches in search rows and keyword filters elsewhere", async () => {
  const search = await call("search_research_items", { keyword: PRIVATE.fulltext });
  assert.equal(search.results[0].matched_in, "restricted_fulltext");
  assert.equal(search.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
  const plain = await call("search_research_items", { keyword: "Plain Public Item" });
  assert.equal(plain.restricted_match_note, undefined);

  const years = await call("list_years", { filters: { keyword: PRIVATE.fulltext } });
  assert.equal(years.curator_note, lib.PRIVATE_KEYWORD_NOTE);
  assert.equal(years.dated_items, 1, "the item matched only in private full text is counted");
  assert.equal((await call("list_years", {})).curator_note, undefined);
});

test("instructions, prompts and the full-text note speak of public records in curator mode", async () => {
  const text = conn.client.getInstructions();
  assert.match(text, /Every public record carries an `amira_url`/);
  assert.ok(text.length <= 2048, `${text.length} characters`);
  const prompt = await conn.client.getPrompt({ name: "project_dossier", arguments: { project: "Curator Fixture Project" } });
  const body = prompt.messages[0].content.text;
  assert.match(body, /Cite every public record/);
  assert.match(body, /admin_url/);
  const note = lib.neighboursNote({ maps: { map: { model: { name: "m" }, counts: { withText: 2, shown: 1 } } } });
  assert.match(note, /curators read it in get_research_item's `restricted` block/);
  assert.doesNotMatch(note, /never served here/);
});
