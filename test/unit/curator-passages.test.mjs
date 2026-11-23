// Curator mode and get_text_passages: the private full text of research items
// (the ILAM OCR text) and publications, the private text of chronicles and
// private video transcripts are searched; their passages say matched_in, carry the result-level
// restricted_match_note, and private records keep their admin URL. Served from
// the curator cache partition of a never contacted instance (as in
// curator-chronicles.test.mjs), with invented records. The public side is in
// curator-public.test.mjs and public-fixes.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv();
const secrets = tempDir("curator-passages");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, "key_identity=passagesIdentityAAAAAAAAAAAAAAAAAA\nkey_credential=passagesCredentialBBBBBBBBBBBBBBBB\n");
const SITE = "http://curator.invalid";
Object.assign(process.env, { AMIRA_ACCESS: "curator", AMIRA_SITE_BASE: SITE, AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_LIVE_REFRESH: "0", AMIRA_SEMANTIC_RELEASE: "off" });
const lib = await import("../../server/lib.js");

const TOKEN = "pangolin-private-ocr-token";
// An ILAM-style OCR text on a public item: three matches, one accented (folded), offsets in UTF-16.
const ITEM_TEXT = `Page 1. Ñ The ${TOKEN} opens the article. Page 2. The Pangolin-Private-OCR-Token returns. ` +
  `Page 3. A last ${TOKEN.replace("ocr", "ócr")} closes it.`;
const PRIVATE_ITEM_TEXT = `A withheld article: ${TOKEN} once.`;
const PUB_TEXT = `A private manuscript naming the ${TOKEN} and zanzibar-fulltext-token together.`;
const CHRONICLE_TEXT = `An unpublished poem: the ${TOKEN} sings.`;

const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const items = fx.data.research_items;
items[0] = { ...items[0], restricted: { fulltext: ITEM_TEXT } }; // 500: public item, private full text
items[1] = { ...items[1], visibility: "private", restricted: { fulltext: PRIVATE_ITEM_TEXT } }; // 501: private item
// 502: a public item with no full text at all.
fx.data.publications[0] = { ...fx.data.publications[0], restricted: { fulltext: PUB_TEXT } }; // 510: public and private text
const base = fx.data.chronicles[1];
fx.data.chronicles.push({ ...base, o_id: 562, title: "Unpublished poem", relations: [], media: [], thumbnail: null, text: null,
  restricted: { fulltext: CHRONICLE_TEXT } });
// 541: a public video whose only transcript is private (#26), long enough to page.
const VIDEO_TEXT = `${"Panel opening remarks. ".repeat(40)}Then the ${TOKEN} is discussed. ${"Closing words. ".repeat(40)}`;
fx.data.videos[1] = { ...fx.data.videos[1], restricted: { fulltext: VIDEO_TEXT } };
fx.manifest.counts = Object.fromEntries(Object.entries(fx.data).map(([k, v]) => [k, v.length]));
Object.assign(fx.manifest, { apiBase: `${SITE}/api`, fetchedAt: new Date().toISOString(), access: "curator" });
await lib.writeSnapshotAtomic(lib.cacheSnapshotDir(), fx);

const conn = await connectInMemory(lib, {}, { name: "curator-passages" });
const { call } = conn;
test.after(() => conn.close());

test("curator: the tool says it reads research items and private texts", async () => {
  const tool = (await conn.client.listTools()).tools.find((t) => t.name === "get_text_passages");
  assert.match(tool.description, /Curator mode: research_item: ids too/);
  assert.match(tool.inputSchema.properties.ids.description, /research_item:/);
});

test("curator: passages of a public research item's private full text, at original offsets, marked private", async () => {
  const r = await call("get_text_passages", { ids: ["research_item:500"], keyword: TOKEN, radius: 20 });
  assert.equal(r.total_matches, 3, "accent- and case-insensitive, as for public texts");
  assert.deepEqual(r.unavailable_ids, []);
  assert.equal(r.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
  assert.match(r.restricted_match_note, /get_text_passages passage's text\) is private/);
  for (const p of r.results) {
    assert.equal(p.id, "research_item:500");
    assert.equal(p.matched_in, "restricted_fulltext");
    // A public record: still cited by its public page, yet its passage is private.
    assert.equal(p.visibility, "public");
    assert.equal(p.amira_url, lib.itemUrl(500));
    assert.equal(p.text, ITEM_TEXT.slice(p.start, p.end));
    assert.equal(fold(ITEM_TEXT.slice(p.match_start, p.match_end)), TOKEN);
    assert.equal(p.start, Math.max(0, p.match_start - 20));
  }
  assert.equal(r.results[0].match_start, ITEM_TEXT.indexOf(TOKEN));
  // The offsets are the ones get_research_item pages the same text with.
  const window = await call("get_research_item", { id: 500, include_fulltext: true, fulltext_offset: r.results[0].match_start,
    fulltext_max_chars: TOKEN.length });
  assert.equal(window.restricted.fulltext, TOKEN);
});

test("curator: item: is an alias, and a private research item keeps its admin URL", async () => {
  const r = await call("get_text_passages", { ids: ["item:501", "research_item:501"], keyword: TOKEN });
  assert.equal(r.total_matches, 1, "item:501 and research_item:501 are one document");
  const [p] = r.results;
  assert.deepEqual([p.id, p.matched_in, p.visibility, p.amira_url], ["research_item:501", "restricted_fulltext", "private", undefined]);
  assert.equal(p.admin_url, `${SITE}/admin/item/501`);
  assert.ok(p.citation_note);
  assert.equal(r.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
});

test("curator: a research item without full text is reported, not searched", async () => {
  const r = await call("get_text_passages", { ids: ["research_item:502", "research_item:999999"], keyword: TOKEN });
  assert.equal(r.total_matches, 0);
  assert.deepEqual(r.unavailable, [{ id: "research_item:502", reason: "no_fulltext" }, { id: "research_item:999999", reason: "not_found" }]);
  assert.equal(r.restricted_match_note, undefined);
});

test("curator: pagination runs across private passages with offset and next_offset", async () => {
  const first = await call("get_text_passages", { ids: ["research_item:500", "item:501"], keyword: TOKEN, limit: 2 });
  assert.deepEqual([first.count, first.total_matches, first.has_more, first.next_offset], [2, 4, true, 2]);
  const second = await call("get_text_passages", { ids: ["research_item:500", "item:501"], keyword: TOKEN, limit: 2, offset: first.next_offset });
  assert.deepEqual([second.count, second.has_more, second.next_offset], [2, false, undefined]);
  assert.deepEqual(second.results.map((p) => p.id), ["research_item:500", "research_item:501"]);
  assert.ok(second.results[0].match_start > first.results[1].match_start, "the page resumes after the last passage");
});

test("curator: a publication gives its public passages first, then its private ones, marked", async () => {
  const r = await call("get_text_passages", { ids: ["pub:510"], keyword: "zanzibar-fulltext-token", limit: 20, offset: 25 });
  const publicTotal = fx.data.publications[0].fulltext.split("zanzibar-fulltext-token").length - 1;
  assert.equal(r.total_matches, publicTotal + 1);
  const last = r.results.at(-1);
  assert.equal(last.matched_in, "restricted_fulltext");
  assert.equal(last.text, PUB_TEXT.slice(last.start, last.end));
  assert.ok(r.results.slice(0, -1).every((p) => p.matched_in === undefined), "public passages carry no marker");
  assert.equal(r.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
  // Public passages alone: no note.
  assert.equal((await call("get_text_passages", { ids: ["pub:510"], keyword: "zanzibar-fulltext-token", limit: 1 })).restricted_match_note, undefined);
});

test("curator: a chronicle's private text is searched as restricted_text", async () => {
  const r = await call("get_text_passages", { ids: ["chronicle:562"], keyword: TOKEN });
  assert.equal(r.total_matches, 1);
  assert.equal(r.results[0].matched_in, "restricted_text");
  assert.equal(r.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
});

/** Accent and case folding, enough for the fixture's text. */
function fold(s) {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

test("curator: a private video transcript is paged by get_video and searched as restricted_transcript (#26)", async () => {
  const plain = await call("get_video", { id: 541 });
  assert.equal(plain.restricted.transcript_length, VIDEO_TEXT.length, "reported by length without include_transcript");
  assert.equal(plain.restricted.transcript, undefined);

  const first = await call("get_video", { id: 541, include_transcript: true, transcript_max_chars: 300 });
  assert.equal(first.restricted.transcript, VIDEO_TEXT.slice(0, 300));
  assert.equal(first.restricted.transcript_next_offset, 300);
  const second = await call("get_video", { id: 541, include_transcript: true, transcript_offset: 300, transcript_max_chars: 300 });
  assert.equal(second.restricted.transcript, VIDEO_TEXT.slice(300, 600), "the next page continues the private text");

  const search = await call("search_videos", { keyword: TOKEN });
  const row = search.results.find((r) => r.omeka_id === 541);
  assert.equal(row?.matched_in, "restricted_transcript");
  assert.match(row.transcript_snippet, /pangolin-private-ocr-token/i);
  assert.equal(row.has_restricted_transcript, true);
  assert.equal(search.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);

  const passages = await call("get_text_passages", { ids: ["video:541"], keyword: TOKEN });
  assert.equal(passages.total_matches, 1);
  assert.equal(passages.results[0].matched_in, "restricted_transcript");
  const at = VIDEO_TEXT.indexOf(TOKEN);
  assert.deepEqual([passages.results[0].match_start, passages.results[0].match_end], [at, at + TOKEN.length]);
  assert.equal(passages.restricted_match_note, lib.RESTRICTED_MATCH_NOTE);
});
