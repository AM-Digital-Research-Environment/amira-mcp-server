// Public-mode fixes to the research-item, project, section, facet, publication,
// full-text, media and ChatGPT-adapter tools: keyword word semantics everywhere
// a keyword is taken, closed-vocabulary suggestions, wrong-kind ids, text
// windows, get_text_passages, fetch, snapshot history and publication exports.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv({ dataDir: "absent" });
const lib = await import("../../server/lib.js");
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
await lib.writeSnapshot(process.env.AMIRA_DATA_DIR, fixture);
const conn = await connectInMemory(lib, { openai: true }, { name: "public-fixes" });
const { call } = conn;
test.after(() => conn.close());

const SINGLE = "No record matches this filter. Check its spelling or broaden it; did_you_mean, when present, lists stored values.";

// --- A. matching -------------------------------------------------------------------

test("A1 search_projects: every word of a keyword, in any order; a quoted phrase literally", async () => {
  assert.deepEqual((await call("search_projects", { keyword: "Worlds Fixture" })).results.map((p) => p.omeka_id), [300]);
  assert.deepEqual((await call("search_projects", { keyword: "\"Art Worlds\"" })).results.map((p) => p.omeka_id), [300]);
  assert.equal((await call("search_projects", { keyword: "\"Worlds Art\"" })).total_matches, 0);
});

test("A1 list tools: multi-word keywords match every word, not one raw substring", async () => {
  assert.deepEqual((await call("list_subjects", { keyword: "d'Ivoire Cote" })).results.map((r) => r.subject), ["Côte d'Ivoire"]);
  assert.deepEqual((await call("list_collections", { keyword: "Collection Fixture" })).results.map((r) => r.collection), ["Fixture Collection"]);
  assert.deepEqual((await call("list_locations", { keyword: "\"Côte d'Ivoire\"" })).results.map((r) => r.name), ["Côte d'Ivoire"]);
  assert.equal((await call("list_journals", { keyword: "Society Fixture" })).total_matches, 0, "every word must match");
  assert.equal((await call("list_journals", { keyword: "society" })).total_matches, 1, "one word stays a substring match");
});

test("A2 an empty quoted keyword is an empty keyword", async () => {
  assert.deepEqual(lib.parseKeyword("\"\""), { phrases: [], terms: [] });
  assert.deepEqual(lib.parseKeyword("“ ”"), { phrases: [], terms: [] });
  const all = await call("search_research_items", {});
  assert.equal((await call("search_research_items", { keyword: "\"\"" })).total_matches, all.total_matches);
});

test("A3 get_text_passages: quoted phrases, ids deduplicated by kind, a reason per unavailable id", async () => {
  const quoted = await call("get_text_passages", { ids: ["publication:510", "pub:510"], keyword: "\"zanzibar-fulltext-token histories\"", limit: 1 });
  assert.equal(quoted.total_matches, 30, "one document, not two: pub:510 = publication:510");
  assert.match(quoted.results[0].text, /zanzibar-fulltext-token histories/);
  const page = await call("get_text_passages", {
    ids: ["publication:510", "item:500", "publication:511", "publication:999999", "garbage"], keyword: "zanzibar-fulltext-token",
  });
  assert.deepEqual(page.unavailable_ids, ["item:500", "publication:511", "publication:999999", "garbage"]);
  assert.deepEqual(page.unavailable.map((u) => [u.id, u.reason]), [
    ["item:500", "unsupported_kind"], ["publication:511", "no_fulltext"], ["publication:999999", "not_found"], ["garbage", "malformed_id"],
  ]);
  assert.match(page.unavailable[0].note, /get_research_item/);
  assert.ok(!/private/i.test(page.unavailable[0].note), "public mode says nothing about private text");
  assert.equal((await call("get_text_passages", { ids: ["publication:510"], keyword: "\"\"" })).error.code, "invalid_argument");
});

test("A4 a multi-term snippet shows the terms together, not the first term alone", () => {
  const text = `Kora appears in the title. ${"Filler sentence about nothing. ".repeat(40)}Here the kora and the mbira play together.`;
  const snip = lib.matchSnippet(text, "kora mbira");
  assert.match(snip, /kora and the mbira/);
  assert.ok(snip.length <= 2 * 140 + 40, `bounded: ${snip.length}`);
  // A one-term query keeps the first occurrence.
  assert.ok(lib.matchSnippet(text, "kora").startsWith("Kora appears"));
});

// --- B. years, facets, lists ----------------------------------------------------------

test("B5 list_years: dated_items and year_range describe the from/to window", async () => {
  const years = await call("list_years", { from: 1960, to: 1961 });
  assert.equal(years.dated_items, 1);
  assert.deepEqual(years.year_range, { min: 1960, max: 1961 });
});

test("B7 list_locations: out-of-range points and inverted boxes are refused; antimeridian boxes work", async () => {
  assert.equal((await call("list_locations", { near: { latitude: 200, longitude: 500, km: 10 } })).error.code, "invalid_argument");
  assert.equal((await call("list_locations", { bbox: [0, 10, 20, -10] })).error.code, "invalid_argument");
  assert.equal((await call("list_locations", { bbox: [0, -100, 20, 10] })).error.code, "invalid_argument");
  const across = await call("list_locations", { bbox: [170, -90, 10, 90] });
  assert.ok(across.results.some((r) => r.name === "Lagos"), "west > east wraps the antimeridian");
});

test("B8 list_subjects: vocabulary 'unspecified' reaches headings that are neither LCSH nor tags", async () => {
  const names = async (vocabulary) => (await call("list_subjects", { vocabulary })).results.map((r) => r.subject).sort();
  assert.deepEqual(await names("lcsh"), ["Architecture"]);
  assert.deepEqual(await names("tag"), ["Islam"]);
  assert.deepEqual(await names("unspecified"), ["Côte d'Ivoire"]);
});

test("B9 list_categories: formats are controlled terms; physical notes are their own category; genre takes both", async () => {
  assert.deepEqual((await call("list_categories", { category: "formats" })).results.map((r) => r.value), ["photograph"]);
  assert.deepEqual((await call("list_categories", { category: "physical_notes" })).results.map((r) => r.value), ["gelatin print"]);
  assert.deepEqual((await call("search_research_items", { genre: "gelatin" })).results.map((r) => r.omeka_id), [501]);
});

test("B11 unknown closed-vocabulary values name the stored ones", async () => {
  const harvard = await call("search_projects", { university: "harvard" });
  assert.equal(harvard.hint, SINGLE);
  assert.ok(harvard.did_you_mean[0].values.some((v) => v.startsWith("ubt")));
  assert.deepEqual((await call("search_projects", { research_section: "Nonexistent" })).did_you_mean[0].filter, "research_section");
  const dym = async (args) => (await call("search_research_items", args)).did_you_mean;
  assert.deepEqual(await dym({ language: "Klingon" }), [{ filter: "language", values: ["English", "French"] }]);
  assert.deepEqual(await dym({ research_section: "arts" }), [{ filter: "research_section", values: ["Arts & Aesthetics"] }]);
  assert.deepEqual((await dym({ resource_type: "Imagery" }))[0].values, ["Image"]);
  const pubs = await call("search_publications", { type: "journal article" });
  assert.ok(pubs.did_you_mean[0].values.includes("article"));
  assert.equal(pubs.hint, SINGLE);
});

test("B12 get_research_section: 'and' for '&', and name with id is refused", async () => {
  assert.equal((await call("get_research_section", { name: "arts and aesthetics" })).omeka_id, 400);
  assert.equal((await call("search_projects", { research_section: "Arts and Aesthetics" })).total_matches, 1);
  assert.equal((await call("get_research_section", { id: 400, name: "External" })).error.code, "invalid_argument");
});

// --- C. detail tools, paging, ids ---------------------------------------------------

test("C13 text windows: next offset, past-the-end hint, offsets without the opt-in", async () => {
  const first = await call("get_publication", { id: 510, include_fulltext: true, fulltext_max_chars: 100 });
  assert.equal(first.fulltext_next_offset, 100);
  const past = await call("get_publication", { id: 510, include_fulltext: true, fulltext_offset: 99_999 });
  assert.equal(past.fulltext, "");
  assert.match(past.fulltext_hint, /past the end/);
  const ignored = await call("get_publication", { id: 510, fulltext_offset: 50 });
  assert.match(ignored.fulltext_hint, /only with include_fulltext=true/);
  const transcript = await call("get_video", { id: 540, include_transcript: true, transcript_offset: 99_999 });
  assert.match(transcript.transcript_hint, /past the end/);
});

test("C14 a bare id of another kind names that kind and its tool; garbage is invalid_id", async () => {
  const project = await call("get_research_item", { id: 300 });
  assert.equal(project.error.suggested_tool, "get_project");
  assert.match(project.error.message, /is a project id, not a research item id/);
  assert.equal((await call("get_project", { id: 500 })).error.suggested_tool, "get_research_item");
  assert.equal((await call("get_video", { id: 530 })).error.suggested_tool, "get_podcast");
  assert.equal((await call("get_publication", { id: 540 })).error.suggested_tool, "get_video");
  assert.equal((await call("get_research_section", { id: 100 })).error.suggested_tool, "get_person");
  assert.equal((await call("get_project", { id: "abc" })).error.code, "invalid_id");
  assert.equal((await call("get_project", { id: 999999 })).error.code, "not_found");
});

test("C15 fetch: max_chars minimum, bare ids, wrong kinds, ignored opt-ins, past-the-end offsets", async () => {
  assert.equal((await conn.raw("fetch", { id: "item:500", max_chars: -5 })).isError, true);
  assert.equal((await call("fetch", { id: "500" })).metadata.kind, "research_item");
  const wrong = await call("fetch", { id: "pub:500" });
  assert.match(wrong.error.message, /research item id.*fetch item:500/i);
  const note = await call("fetch", { id: "item:500", include_fulltext: true });
  assert.match(note.metadata.note, /publications only/);
  const past = await call("fetch", { id: "pub:510", include_fulltext: true, fulltext_offset: 99_999 });
  assert.match(past.text, /offset 99999 is past the end/);
  assert.match(past.metadata.fulltext_hint, /past the end/);
  const schema = (await conn.client.listTools()).tools.find((t) => t.name === "fetch").outputSchema;
  assert.ok(!("error" in (schema.properties ?? {})), "the error branch could never appear in structured content");
  const search = (await conn.client.listTools()).tools.find((t) => t.name === "search").outputSchema;
  assert.ok(!JSON.stringify(search).includes("public record page"));
});

test("C16 search_publications: an empty export says so; later full-text pages carry a compact header", async () => {
  const empty = await call("search_publications", { keyword: "no-such-word-qq", export: "csv" });
  assert.equal(empty.export.rows, 0);
  assert.match(empty.hint, /export file is empty/);
  const later = await call("get_publication", { id: 510, include_fulltext: true, fulltext_offset: 10, fulltext_max_chars: 50 });
  assert.equal(later.title, "Decolonial Architecture Futures");
  assert.equal(later.fulltext.length, 50);
  for (const key of ["abstract", "bibtex", "authors", "repository_urls"]) assert.ok(!(key in later), key);
  assert.ok(later.amira_url);
});

test("C17 public mode carries no has_restricted_fulltext", async () => {
  const hit = await call("search_publications", { keyword: "zanzibar-fulltext-token" });
  assert.ok(!("has_restricted_fulltext" in hit.results[0]));
});

test("C18 entity graph: a string that was never a snapshot id is called unknown", async () => {
  const bad = await call("get_entity_graph", { seed: "person:100", snapshot_id: "not-a-snapshot" });
  assert.equal(bad.error.code, "invalid_id");
  assert.match(bad.error.message, /Unknown snapshot id/);
});

// --- D. citations -------------------------------------------------------------------------

const pub = (over) => ({
  o_id: 7777, pub_id: "eref-7777", identifiers: ["eref-7777", "Q123456"], type: "working_paper", title: "A Paper", date: "2025-10-09",
  year: 2025, authors: [{ label: "Doe, Jane", o_id: null }], editors: [], venue: "Institute of Things", venue_ref: null, series: ["Bayreuth Papers"],
  volume: "12", issue: null, pages: null, publisher: null, doi: null, isbn: null, issn: null, abstract: null,
  subjects: [{ label: "Music", o_id: null }, { label: "Migration", o_id: null }], language: "English", urls: [], status: null,
  funders: [], places_of_publication: [{ label: "Bayreuth", o_id: 903 }], relations: [], fulltext: null, has_media: false, thumbnail: null,
  ...over,
});

test("D19 RIS DA is zero-padded YYYY/MM/DD", () => {
  assert.match(lib.publicationCitation(pub({}), "ris").export, /^DA {2}- 2025\/10\/09$/m);
});

test("D20 the venue survives beside a real series; series numbers, address, keywords, Wikidata", () => {
  const bib = lib.publicationBibtex(pub({}));
  assert.match(bib, /^@techreport\{/);
  assert.match(bib, /institution = \{Institute of Things\}/);
  assert.match(bib, /series = \{Bayreuth Papers\}/);
  assert.match(bib, /number = \{12\}/);
  assert.ok(!/volume = /.test(bib), "a report number is not a volume");
  assert.match(bib, /address = \{Bayreuth\}/);
  assert.match(bib, /keywords = \{Music, Migration\}/);
  assert.match(bib, /Repository identifiers: eref-7777\. Wikidata: Q123456/);
  const ris = lib.publicationCitation(pub({}), "ris").export;
  assert.match(ris, /^T2 {2}- Institute of Things$/m);
  assert.match(ris, /^T3 {2}- Bayreuth Papers$/m);
  const csl = lib.publicationCitation(pub({}), "csl-json").export;
  assert.deepEqual([csl["container-title"], csl["collection-title"], csl["collection-number"], csl.volume],
    ["Institute of Things", "Bayreuth Papers", "12", undefined]);
  const thesis = lib.publicationBibtex(pub({ type: "doctoral_thesis", series: ["Some Series"], volume: null,
    degree_granting_institutions: [{ label: "University of Bayreuth", o_id: 200 }] }));
  assert.match(thesis, /^@phdthesis\{/);
  assert.match(thesis, /school = \{University of Bayreuth\}/);
  const thesisCsl = lib.publicationCitation(pub({ type: "doctoral_thesis", series: ["Some Series"], volume: null }), "csl-json").export;
  assert.equal(thesisCsl.publisher, "Institute of Things", "a thesis venue is its institution");
  const post = lib.publicationBibtex(pub({ type: "online_post", volume: null }));
  assert.match(post, /howpublished = \{Institute of Things\}/);
  // Without a separate series the venue keeps the series slot, as before.
  const plain = lib.publicationBibtex(pub({ series: [] }));
  assert.match(plain, /series = \{Institute of Things\}/);
});

// Last: writes retained history, which changes get_snapshot_changes for later calls.
test("C18 get_snapshot_changes: explains missing history, validates ids, cites no deleted record", async () => {
  const none = await call("get_snapshot_changes", {});
  assert.equal(none.status, "history_unavailable");
  assert.match(none.reason, /needs two/);
  assert.match(none.hint, /added_since/);
  assert.equal((await call("get_snapshot_changes", { from_id: "nope" })).error.code, "snapshot_unavailable");
  const before = structuredClone(fixture), after = structuredClone(fixture);
  before.manifest.fetchedAt = "2026-10-01T00:00:00Z";
  after.manifest.fetchedAt = "2026-10-02T00:00:00Z";
  after.data.persons.splice(1, 1);
  after.manifest.counts.persons = after.data.persons.length;
  const cache = lib.snapshotCacheDir(process.env.AMIRA_CACHE_DIR, fixture.manifest.apiBase);
  await lib.writeSnapshotAtomic(cache, before);
  await lib.writeSnapshotAtomic(cache, after);
  const changes = await call("get_snapshot_changes", { corpus: "persons" });
  const deleted = changes.results.find((r) => r.change === "deleted");
  assert.equal(deleted.id, 101);
  assert.ok(!("amira_url" in deleted), "a deleted record has no page to cite");
});
