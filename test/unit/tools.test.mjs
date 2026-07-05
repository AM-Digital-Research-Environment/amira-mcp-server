// Deterministic tool-layer tests: the REAL bundled server (server/lib.js)
// running against the tiny fixture snapshot, driven in-process through the MCP
// SDK's InMemoryTransport. This exercises registration, zod schemas, handlers,
// pagination, windowing and exposure gating end-to-end — offline, no live data.
//
// AMIRA_DATA_DIR must be set BEFORE the bundle is imported (config reads the
// environment at module load), hence the dynamic import after env setup.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";

const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "amira-fixture-"));
process.env.AMIRA_DATA_DIR = fixtureDir;
process.env.AMIRA_LIVE_REFRESH = "0";
delete process.env.AMIRA_EXPOSURE;

const lib = await import("../../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

await lib.writeSnapshot(fixtureDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const server = lib.createAmiraServer({ openai: true });
const client = new Client({ name: "tools-unit", version: "0.0.0" });
await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

/** Call a tool and parse its compact-JSON text body. */
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

test.after(async () => {
  await client.close();
  await server.close();
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("tool surface: 26 rich tools + search/fetch = 28", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.equal(names.length, 28, names.join(", "));
  for (const expected of ["list_journals", "search", "fetch", "get_collection_overview"]) {
    assert.ok(names.includes(expected), expected);
  }
});

test("overview: journal + fulltext/transcript coverage counts", async () => {
  const o = await call("get_collection_overview");
  assert.equal(o.counts.publications, 2);
  assert.equal(o.counts.publications_with_fulltext, 1);
  assert.equal(o.counts.journals, 1);
  assert.equal(o.counts.podcasts_with_transcript, 1);
  assert.equal(o.counts.videos_with_transcript, 1);
});

test("search_research_items: AND filters, zero-result suggestions", async () => {
  const both = await call("search_research_items", { subject: "Islam", resource_type: "Image" });
  assert.equal(both.total_matches, 2); // items 500 + 501
  const zero = await call("search_research_items", { subject: "Islam", resource_type: "Audio" });
  assert.equal(zero.total_matches, 0);
  assert.ok(zero.suggestions.some((s) => s.remove_filter === "resource_type" && s.would_match === 2));
  // filters echo never contains pagination knobs
  const echoed = await call("search_research_items", { subject: "Islam", limit: 1, offset: 0 });
  assert.deepEqual(Object.keys(echoed.filters), ["subject"]);
});

test("location matches any level; country matches only the chain root", async () => {
  const byLocation = await call("search_research_items", { location: "Nigeria" });
  assert.equal(byLocation.total_matches, 2); // Lagos item 500 + Nigeria item 501
  const byCountry = await call("search_research_items", { country: "Nigeria" });
  assert.equal(byCountry.total_matches, 2);
  const lagosLocation = await call("search_research_items", { location: "Lagos" });
  assert.equal(lagosLocation.total_matches, 1); // item 500 only
  const lagosCountry = await call("search_research_items", { country: "Lagos" });
  assert.equal(lagosCountry.total_matches, 0); // Lagos is not a country root
});

test("list_years: ranged items count into every bucket; from/to windows", async () => {
  const years = await call("list_years", { from: 1960, to: 1965 });
  assert.equal(years.dated_items, 2);
  assert.equal(years.undated_items, 2);
  assert.equal(years.distinct_buckets, 6); // 1960..1965, all from item 501
  assert.ok(years.results.every((r) => r.item_count === 1));
  const decades = await call("list_years", { bucket: "decade" });
  const labels = Object.fromEntries(decades.results.map((r) => [r.decade, r.item_count]));
  assert.equal(labels["1950s"], 1);
  assert.equal(labels["1960s"], 1);
  assert.equal(labels["2010s"], 1);
});

test("search_publications: fulltext reach, snippet, has_fulltext/venue/author filters", async () => {
  const hit = await call("search_publications", { keyword: "zanzibar-fulltext-token" });
  assert.equal(hit.total_matches, 1);
  assert.equal(hit.results[0].matched_in, "fulltext");
  assert.ok(hit.results[0].fulltext_snippet.includes("zanzibar-fulltext-token"));
  assert.equal(hit.results[0].has_fulltext, true);

  assert.equal((await call("search_publications", { has_fulltext: true })).total_matches, 1);
  assert.equal((await call("search_publications", { has_fulltext: false })).total_matches, 1);
  assert.equal((await call("search_publications", { venue: "Society" })).total_matches, 1);
  assert.equal((await call("search_publications", { author: "Ute Fendler" })).total_matches, 1); // reversed order
});

test("get_publication: fulltext opt-in, windowing, venue link, new fields", async () => {
  const def = await call("get_publication", { id: 510 });
  assert.equal(def.has_fulltext, true);
  assert.ok(def.fulltext_length > 500);
  assert.ok(!("fulltext" in def), "fulltext omitted by default");
  assert.ok(def.fulltext_hint.includes("include_fulltext"));
  assert.equal(def.venue, "Society");
  assert.equal(def.venue_omeka_id, 520);
  assert.ok(def.venue_amira_url.endsWith("/item/520"));
  assert.equal(def.venue_issn, "0147-2011");
  assert.equal(def.status, "Peer reviewed");
  assert.deepEqual(def.funders, ["Deutsche Forschungsgemeinschaft"]);
  assert.equal(def.has_media, true);
  assert.ok(def.bibtex.includes("journal = {Society}"));

  const windowed = await call("get_publication", { id: 510, include_fulltext: true, fulltext_max_chars: 100 });
  assert.equal(windowed.fulltext.length, 100);
  assert.equal(windowed.fulltext_offset, 0);
  assert.equal(windowed.fulltext_returned_chars, 100);
  assert.equal(windowed.fulltext_truncated, true);

  const past = await call("get_publication", { id: 510, include_fulltext: true, fulltext_offset: 10_000_000 });
  assert.equal(past.fulltext_returned_chars, 0);
  assert.ok(!("fulltext_truncated" in past) || past.fulltext_truncated === undefined);
});

test("list_journals: ranked by publication count with citable links", async () => {
  const j = await call("list_journals", {});
  assert.equal(j.total_matches, 1);
  assert.equal(j.results[0].journal, "Society");
  assert.equal(j.results[0].publication_count, 1);
  assert.equal(j.results[0].issn, "0147-2011");
  assert.equal(j.results[0].country, "Germany");
  assert.ok(j.results[0].amira_url.endsWith("/item/520"));
});

test("find_related: publications join subject/person pivots", async () => {
  const rel = await call("find_related", { entity_type: "subject", value: "Architecture" });
  assert.equal(rel.matched_items, 1); // research item 500
  assert.equal(rel.matched_publications, 1); // publication 510
  assert.ok(rel.related_publications[0].amira_url.endsWith("/item/510"));
  assert.ok(rel.related_people.some((p) => p.name === "Fendler, Ute")); // via pub authors

  const person = await call("find_related", { entity_type: "person", value: "Ute Fendler" });
  assert.equal(person.matched_publications, 1);
});

test("transcript search + windowing (videos, podcasts)", async () => {
  const vids = await call("search_videos", { keyword: "planetary-token" });
  assert.equal(vids.total_matches, 1);
  assert.equal(vids.results[0].matched_in, "transcript");
  assert.ok(vids.results[0].transcript_snippet.includes("planetary-token"));

  const pods = await call("search_podcasts", { keyword: "kilimanjaro-token" });
  assert.equal(pods.total_matches, 1);
  assert.equal(pods.results[0].matched_in, "transcript");

  const sliced = await call("get_video", { id: 540, include_transcript: true, transcript_max_chars: 100 });
  assert.equal(sliced.transcript.length, 100);
  assert.equal(sliced.transcript_truncated, true);
});

test("get_person: publications listed with role; caps documented", async () => {
  const person = await call("get_person", { name: "Ulli Beier" });
  assert.equal(person.name, "Beier, Ulli");
  assert.equal(person.publication_count, 1);
  assert.equal(person.publications[0].role, "author");
  assert.ok(!person.publications_truncated);
});

test("openai search reaches publication fulltext; fetch windows it", async () => {
  const search = await call("search", { query: "zanzibar" });
  assert.ok(search.results.some((r) => r.id === "pub:510"), JSON.stringify(search.results));

  const def = await call("fetch", { id: "pub:510" });
  assert.equal(def.metadata.has_fulltext, true);
  assert.equal(def.metadata.fulltext_included, false);
  assert.ok(def.text.includes("Full text omitted"));

  const withFt = await call("fetch", { id: "pub:510", include_fulltext: true, fulltext_max_chars: 200 });
  assert.equal(withFt.metadata.fulltext_included, true);
  assert.equal(withFt.metadata.fulltext_returned_chars, 200);
  assert.equal(withFt.metadata.fulltext_truncated, true);
  assert.ok(withFt.text.length > def.text.length);
  assert.ok(withFt.metadata.venue_amira_url.endsWith("/item/520"));
});

test("exposure minimal: fields stripped, structured filters and tools refused", async (t) => {
  process.env.AMIRA_EXPOSURE = "minimal";
  t.after(() => delete process.env.AMIRA_EXPOSURE);

  const item = await call("get_research_item", { id: 500 });
  assert.ok(!("subjects" in item) && !("contributors" in item) && !("places" in item));
  assert.equal(item.description, null); // descriptive text hidden
  assert.equal(item.title, "Yoruba Architecture Study"); // minimal core stays

  const filtered = await call("search_research_items", { subject: "Islam" });
  assert.equal(filtered.error.code, "exposure_restricted");
  const related = await call("find_related", { entity_type: "subject", value: "Islam" });
  assert.equal(related.error.code, "exposure_restricted");
  const persons = await call("search_persons", {});
  assert.equal(persons.error.code, "exposure_restricted");

  // keyword only reaches titles at minimal: the description-only token misses
  const kw = await call("search_research_items", { keyword: "unique-keyword-xyz" });
  assert.equal(kw.total_matches, 0);

  const overview = await call("get_collection_overview");
  assert.equal(overview.metadata_exposure, "minimal");
  assert.ok(!("items_by_research_section" in overview));
  assert.ok("items_by_resource_type" in overview); // type is minimal-level
});

test("exposure descriptive: text searchable, relations still hidden", async (t) => {
  process.env.AMIRA_EXPOSURE = "descriptive";
  t.after(() => delete process.env.AMIRA_EXPOSURE);

  const kw = await call("search_research_items", { keyword: "unique-keyword-xyz" });
  assert.equal(kw.total_matches, 1);
  const item = await call("get_research_item", { id: 502 });
  assert.ok(item.description.includes("unique-keyword-xyz"));
  assert.ok(!("subjects" in item));
});

test("exposure structured: transcripts/fulltext unreachable and refused on opt-in", async (t) => {
  process.env.AMIRA_EXPOSURE = "structured";
  t.after(() => delete process.env.AMIRA_EXPOSURE);

  const vids = await call("search_videos", { keyword: "planetary-token" });
  assert.equal(vids.total_matches, 0); // transcript not searched
  const pubs = await call("search_publications", { keyword: "zanzibar-fulltext-token" });
  assert.equal(pubs.total_matches, 0); // fulltext not searched

  const video = await call("get_video", { id: 540, include_transcript: true });
  assert.equal(video.error.code, "text_access_disabled");
  const pub = await call("get_publication", { id: 510, include_fulltext: true });
  assert.equal(pub.error.code, "text_access_disabled");

  // existence stays visible; access marked disabled
  const meta = await call("get_video", { id: 540 });
  assert.equal(meta.has_transcript, true);
  assert.equal(meta.transcript_access, "disabled");

  // structured navigation works at this level
  const subjects = await call("list_subjects", {});
  assert.ok(subjects.total_matches >= 2);
});
