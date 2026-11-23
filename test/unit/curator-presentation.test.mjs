// Curator mode (#26): the presentation contract of the decoration step
// (src/tools/curator.ts) beyond the basics of curator.test.mjs: records outside
// the crawled corpora, languages, media rows and files, IIIF, every URL form,
// `search`/`fetch` rows, exports, collection nodes, the restricted block's
// edges, curator notes, prompts and instructions.
//
// The Omeka stub gets extra fixtures (all invented): a private and a public
// format authority outside every crawled corpus, a private language, a public
// item linking to all three with a private media as its thumbnail, a private
// media without a file and a long private value, a private item with a public
// media (IIIF manifest, thumbnail), and a private video with a thumbnail.
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
  publicOfPrivate: 9903, privateThumbMedia: 9904, fileless: 9905, privateVideo: 7802 };
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
      "o:media": [{ "o:id": X.privateThumbMedia }, { "o:id": X.fileless }],
      thumbnail_display_urls: { large: `${STUB_BASE}/files/large/private-thumb-stem.jpg` },
      "dcterms:type": [lit("Image")], "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")],
      "dcterms:format": [res(X.privateFormat, "Retired Format Authority"), res(X.publicFormat, "Field Recording Format")],
      "dcterms:language": [res(X.privateLanguage, "Secret Language")],
      "dcterms:abstract": [lit(LONG_PRIVATE, { is_public: false })],
      "dcterms:created": [lit("1999")] })],
    ["resource_template_id=10", item(X.privateDigitised, false, "Private Digitised Item", {
      "o:media": [{ "o:id": X.publicOfPrivate }], "dcterms:type": [lit("Text")],
      thumbnail_display_urls: { large: `${STUB_BASE}/files/large/public-of-private.jpg` },
      "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")], "dcterms:created": [lit("2001")] })],
    ["resource_template_id=22", item(X.privateVideo, false, "Private Lecture Video", {
      thumbnail_display_urls: { large: `${STUB_BASE}/files/large/private-video-thumb.jpg` }, "dcterms:date": [lit("2024-05-01")] })],
  ],
  extraMedia: [
    { "o:id": X.publicOfPrivate, "@id": `${STUB_BASE}/api/media/${X.publicOfPrivate}`, "o:is_public": true,
      "o:item": { "o:id": X.privateDigitised }, "o:media_type": "application/pdf",
      "o:original_url": `${STUB_BASE}/files/original/public-of-private.pdf`, "o:source": "scan.pdf", "o:size": 10 },
    { "o:id": X.privateThumbMedia, "@id": `${STUB_BASE}/api/media/${X.privateThumbMedia}`, "o:is_public": false,
      "o:item": { "o:id": X.linkedItem }, "o:media_type": "image/tiff",
      "o:original_url": `${STUB_BASE}/files/original/private-thumb-stem.tif`, "o:source": "thumb.tif", "o:size": 20 },
    { "o:id": X.fileless, "@id": `${STUB_BASE}/api/media/${X.fileless}`, "o:is_public": false,
      "o:item": { "o:id": X.linkedItem }, "o:media_type": "text/html", "o:source": "https://example.org/page", "o:size": null },
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
  assert.match(privFormat.citation_note, /readers without curator access cannot open it/);
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
  // The fixture's private set belongs to a public project's collection, so it is cited as the set itself here.
  const set = lib.curatorValue({ omeka_id: IDS.privateSet, amira_url: `${SITE}/s/amira/item-set/${IDS.privateSet}`,
    iiif_collection: `${SITE}/iiif/3/collection/${IDS.privateSet}` }, store());
  assert.equal(set.visibility, "private");
  assert.equal(set.amira_url, undefined);
  assert.equal(set.admin_url, `${SITE}/admin/item-set/${IDS.privateSet}`);
  assert.equal(set.iiif_collection, null);
});

test("a private record's media are private whatever their own flag; its thumbnail is null", async () => {
  const priv = await call("get_research_item", { id: X.privateDigitised });
  assert.equal(priv.visibility, "private");
  assert.equal(priv.thumbnail, null);
  const [media] = priv.media;
  assert.equal(media.visibility, "private");
  assert.equal(media.url, null);
  assert.equal(media.admin_url, `${SITE}/admin/media/${X.publicOfPrivate}`);
  assert.ok(!JSON.stringify(priv).includes("public-of-private"));
  assert.equal(lib.curatorText(`${SITE}/files/large/public-of-private.jpg`, store()), `${SITE}/admin/media/${X.publicOfPrivate}`);
  assert.equal(lib.curatorText(`${SITE}/api/media/${X.publicOfPrivate}`, store()), `${SITE}/admin/media/${X.publicOfPrivate}`);
});

test("a private video's thumbnail is null and its file is never linked", async () => {
  const video = await call("get_video", { id: X.privateVideo });
  assert.equal(video.visibility, "private");
  assert.equal(video.thumbnail, null);
  assert.equal(lib.curatorText(`See ${SITE}/files/large/private-video-thumb.jpg.`, store()), `See ${adminItem(X.privateVideo)}.`);
  // A private record's thumbnail is dropped even when the index does not know its file.
  const row = lib.curatorValue({ omeka_id: X.privateVideo, amira_url: publicItem(X.privateVideo),
    thumbnail: `${SITE}/files/large/unindexed.jpg` }, store(), { detail: false });
  assert.equal(row.thumbnail, null);
});

test("a private media without a file URL still gets its admin page", async () => {
  const linked = await call("get_research_item", { id: X.linkedItem });
  const row = linked.media.find((m) => m.type === "text/html");
  assert.equal(row.url, null);
  assert.equal(row.visibility, "private");
  assert.equal(row.admin_url, `${SITE}/admin/media/${X.fileless}`);
});

test("a private file URL followed by punctuation is rewritten, the punctuation kept", () => {
  const s = store();
  const file = `${SITE}/files/original/${PRIVATE.mediaUrl}`;
  const admin = `${SITE}/admin/media/${IDS.privateMedia}`;
  for (const after of [".", ",next", ")", ";", ").", ":", ""]) {
    assert.equal(lib.curatorText(`See ${file}${after}`, s), `See ${admin}${after}`, JSON.stringify(after));
  }
  assert.equal(lib.curatorText(`id,url,title\n1,${file},Scan\n2,[scan](${file});x`, s), `id,url,title\n1,${admin},Scan\n2,[scan](${admin});x`);
  const pub = `${SITE}/files/original/public-recording.mp3`;
  assert.equal(lib.curatorText(`${pub}, ${pub}.`, s), `${pub}, ${pub}.`, "a public file is left alone");
});

test("a IIIF sub-path of a private resource becomes its clean admin URL", () => {
  const s = store();
  const base = `${SITE}/iiif/3/${X.privateDigitised}`;
  const admin = adminItem(X.privateDigitised);
  assert.equal(lib.curatorText(`${base}/canvas/p1 ${base}/manifest. ${base}/canvas/p1,next (${base}/canvas/p2)`, s),
    `${admin} ${admin}. ${admin},next (${admin})`);
  const pub = `${SITE}/iiif/3/${X.linkedItem}/canvas/p1`;
  assert.equal(lib.curatorText(pub, s), pub);
});

test("a get_snapshot_changes row (`id`, no `omeka_id`): a private item set under a public project is private", () => {
  const { results: [row] } = lib.curatorValue({ results: [{ corpus: "item_sets", id: IDS.privateSet, change: "added",
    title: "Set", amira_url: publicItem(IDS.project) }] }, store());
  assert.equal(row.visibility, "private");
  assert.equal(row.amira_url, publicItem(IDS.project), "the public project page stays");
  assert.equal(row.admin_url, `${SITE}/admin/item-set/${IDS.privateSet}`);
  const { results: [pub] } = lib.curatorValue({ results: [{ corpus: "item_sets", id: IDS.publicSet, change: "added",
    title: "Set", amira_url: publicItem(IDS.project) }] }, store());
  assert.equal(pub.visibility, "public");
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
  assert.match(row.citation_note, /readers without curator access cannot open it/);
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

  // Public, then private text, on one offset (#54). A page the public text
  // filled sends no sliver of private text: it names where the private text starts.
  const args = (offset) => ({ args: { include_fulltext: true, ...(offset ? { fulltext_offset: offset } : {}) }, tool: "get_publication" });
  const full = lib.curatorValue({ omeka_id: IDS.publicItem, fulltext_length: 24_990, fulltext_returned_chars: 24_990 }, store(), args(0));
  assert.equal(full.restricted.fulltext, undefined);
  assert.equal(full.restricted.fulltext_next_offset, 24_990);
  assert.equal(full.restricted.fulltext_starts_at, 24_990);
  const midway = lib.curatorValue({ omeka_id: IDS.publicItem, fulltext_length: 60_000, fulltext_returned_chars: 25_000, fulltext_next_offset: 25_000 },
    store(), args(0));
  assert.equal(midway.restricted.fulltext, undefined, "the private text waits for the public one");
  assert.match(midway.restricted.fulltext_hint, /from fulltext_offset 60000/);
  // The public text ends on this page: the private one fills what is left, in stream offsets.
  const tail = lib.curatorValue({ omeka_id: IDS.publicItem, fulltext_length: 1_000, fulltext_returned_chars: 400 }, store(), args(600));
  assert.equal(tail.restricted.fulltext_offset, 1_000);
  assert.ok(tail.restricted.fulltext_returned_chars <= 25_000 - 400, "the two windows share one page");
  assert.equal(tail.restricted.values, undefined, "restricted values come with the first page only");
  assert.match(tail.restricted.values_note, /fulltext_offset 0/);
  const after = lib.curatorValue({ omeka_id: IDS.publicItem, fulltext_length: 1_000, fulltext_returned_chars: 0 }, store(), args(1_005));
  assert.equal(after.restricted.fulltext_offset, 1_005);
  assert.equal(after.restricted.fulltext.slice(0, 20), tail.restricted.fulltext.slice(5, 25), "offset 1005 is private character 5");
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

  // Publication paths whose rows cannot say matched_in (#54).
  const facets = await call("list_publication_facets", { facet: "year", keyword: PRIVATE.pubText });
  assert.equal(facets.total_publications, 1);
  assert.equal(facets.curator_note, lib.PRIVATE_PUBLICATION_KEYWORD_NOTE);
  const cited = await call("search_publications", { keyword: PRIVATE.pubText, citation_format: "ris" });
  assert.equal(cited.curator_note, lib.PRIVATE_PUBLICATION_KEYWORD_NOTE);
  assert.equal((await call("search_publications", { keyword: PRIVATE.pubText })).curator_note, undefined, "summary rows say matched_in");

  // Below full exposure no private text is searched, so nothing is said about it.
  process.env.AMIRA_EXPOSURE = "descriptive";
  try {
    assert.equal((await call("list_years", { filters: { keyword: PRIVATE.fulltext } })).curator_note, undefined);
  } finally { delete process.env.AMIRA_EXPOSURE; }
});

test("a page of private rows is re-sized after decoration, so it keeps the page budget (#54)", () => {
  const privateUrl = `${lib.itemUrl(IDS.privateItem)}`;
  // 100 rows filling 99% of the budget before decoration; the decoration adds more than 1% to each.
  const bare = JSON.stringify({ title: "", omeka_id: IDS.privateItem, amira_url: privateUrl }).length + 1;
  const row = { title: "x".repeat(Math.floor(lib.PAGE_CHAR_BUDGET * 0.99 / 100) - bare), omeka_id: IDS.privateItem, amira_url: privateUrl };
  const rows = Array.from({ length: 100 }, () => row);
  assert.ok(rows.reduce((n, r) => n + JSON.stringify(r).length + 1, 0) < lib.PAGE_CHAR_BUDGET, "pageOf would keep them all");
  const page = { count: rows.length, total_matches: 250, offset: 50, has_more: true, next_offset: 150, results: rows };
  const result = lib.curatorToolResult("search_research_items", { content: [{ type: "text", text: JSON.stringify(page) }],
    structuredContent: page }, {}, store());
  const shown = result.structuredContent;
  assert.equal(shown.results[0].visibility, "private");
  assert.ok(shown.count < rows.length);
  assert.equal(shown.results.length, shown.count);
  assert.equal(shown.next_offset, 50 + shown.count);
  assert.equal(shown.response_limited, true);
  assert.ok(shown.results.reduce((n, r) => n + JSON.stringify(r).length + 1, 0) <= lib.PAGE_CHAR_BUDGET);
  assert.deepEqual(JSON.parse(result.content[0].text), shown, "the text block is the same page");
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
