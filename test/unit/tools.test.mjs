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
// The cache MUST be isolated too. loadInitial() prefers whichever of
// {bundled, cache} carries the newer manifest, so a real snapshot left in
// ~/.amira-mcp/cache by `npm run test:live` outranks the fixture and every
// assertion here silently runs against live data instead.
process.env.AMIRA_CACHE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), "amira-fixture-cache-"));
delete process.env.AMIRA_EXPOSURE;

const lib = await import("../../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");

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

test("tool contracts are deterministic, documented, and read-only", async () => {
  const first = await client.listTools();
  const second = await client.listTools();
  assert.deepEqual(
    second.tools.map((tool) => tool.name),
    first.tools.map((tool) => tool.name),
    "tool ordering must stay stable for client/prompt caches",
  );
  for (const tool of first.tools) {
    assert.ok(tool.title, `${tool.name}: title`);
    assert.ok(tool.description, `${tool.name}: description`);
    assert.equal(tool.inputSchema?.type, "object", `${tool.name}: object input schema`);
    assert.equal(tool.inputSchema?.additionalProperties, false, `${tool.name}: rejects unknown arguments`);
    assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name}: readOnlyHint`);
    assert.equal(tool.annotations?.destructiveHint, false, `${tool.name}: destructiveHint`);
    assert.equal(tool.annotations?.idempotentHint, true, `${tool.name}: idempotentHint`);
    assert.equal(tool.annotations?.openWorldHint, false, `${tool.name}: openWorldHint`);
  }
});

test("tool-level failures set isError and preserve their structured payload", async () => {
  const result = await client.callTool({ name: "get_research_item", arguments: { id: 999999999 } });
  const payload = JSON.parse(result.content?.[0]?.text ?? "{}");
  assert.equal(result.isError, true);
  assert.equal(payload.error?.code, "not_found");
  assert.deepEqual(result.structuredContent, payload);
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

// The generator itself is tested in test/unit/citation.test.mjs; this is the
// wiring — that the tool builds it from the record it is returning, and that
// `citation_format` moves the export to the right key.
test("get_research_item: generated citation defaults to BibTeX, switches on citation_format", async () => {
  const item = await call("get_research_item", { id: 500 });
  assert.deepEqual(item.citation, [], "the raw dcterms:bibliographicCitation is absent on this item");
  assert.equal(
    item.generated_citation,
    "Beier, Ulli. “Yoruba Architecture Study.” Image, 2013. Fixture Collection. " +
      "AMIRA, Africa Multiple Cluster of Excellence, University of Bayreuth. " +
      "https://data.africamultiple.uni-bayreuth.de/s/amira/item/500.",
  );
  assert.ok(item.bibtex.startsWith("@misc{amira-500,"), item.bibtex);
  assert.ok(item.bibtex.includes("series = {Fixture Collection}"), "the collection title, not `Collection 800`");
  assert.ok(item.bibtex.includes("note = {Project: Fixture Art Worlds. Provenance: Iwalewahaus. AMIRA item 500}"));

  // An item with no collection falls back to the project name.
  const noSet = await call("get_research_item", { id: 502 });
  assert.ok(noSet.generated_citation.includes("Audio, n.d. Fixture Music Library."), noSet.generated_citation);

  const ris = await call("get_research_item", { id: 500, citation_format: "ris" });
  assert.ok(!("bibtex" in ris), "one export per call");
  assert.ok(ris.ris.startsWith("TY  - FIGURE"), ris.ris);
  assert.equal(ris.generated_citation, item.generated_citation);

  const csl = await call("get_research_item", { id: 500, citation_format: "csl-json" });
  assert.equal(csl.csl_json.type, "graphic");
  assert.deepEqual(csl.csl_json.author, [{ family: "Beier", given: "Ulli" }]);

  const bad = await client.callTool({ name: "get_research_item", arguments: { id: 500, citation_format: "mla" } });
  assert.equal(bad.isError, true, "an unknown format is rejected by the schema");
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

// get_research_item / get_project / get_publication have always taken either a
// string or a number; get_video and get_podcast used to demand a number, so a
// client that stringifies ids (several do) got a validation error on exactly
// those two tools. They now follow the same convention as the rest.
test("get_video / get_podcast accept a string id, like every other get_*", async () => {
  for (const [tool, id] of [["get_video", 540], ["get_podcast", 530]]) {
    const byNumber = await call(tool, { id });
    const byString = await call(tool, { id: String(id) });
    assert.deepEqual(byString, byNumber, `${tool}: string and number ids must agree`);
    assert.equal(byString.id, id);
  }

  // A non-numeric id stays a clean not_found, never a crash.
  const missing = await call("get_video", { id: "not-a-number" });
  assert.equal(missing.error.code, "not_found");
  assert.equal(missing.error.suggested_tool, "search_videos");
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

// --- v1.7.0 regressions -------------------------------------------------------

test("accent folding: the same concept matches whichever spelling is asked", async () => {
  // Item 503 has an UNACCENTED title, an ACCENTED subject/place and an
  // ACCENTED description — before folding, the right spelling depended on
  // which tool you asked, and the model had no way to know which.
  for (const spelling of ["Côte d'Ivoire", "Cote d'Ivoire", "COTE D'IVOIRE"]) {
    assert.equal((await call("search_research_items", { keyword: spelling })).total_matches, 1, `keyword ${spelling}`);
    assert.equal((await call("search_research_items", { subject: spelling })).total_matches, 1, `subject ${spelling}`);
    assert.equal((await call("search_research_items", { location: spelling })).total_matches, 1, `location ${spelling}`);
    assert.equal((await call("search_research_items", { country: spelling })).total_matches, 1, `country ${spelling}`);
    assert.equal((await call("list_subjects", { keyword: spelling })).total_matches, 1, `list_subjects ${spelling}`);
    assert.equal((await call("list_locations", { keyword: spelling })).total_matches, 1, `list_locations ${spelling}`);
    assert.equal((await call("find_related", { entity_type: "subject", value: spelling })).matched_items, 1, `find_related ${spelling}`);
  }
  // Accented body text is reachable from an unaccented query and vice versa.
  assert.equal((await call("search_research_items", { keyword: "developpement" })).total_matches, 1);
  assert.equal((await call("search_research_items", { keyword: "développement" })).total_matches, 1);
  // The openai search surface folds too, and its snippet offsets stay valid.
  const s = await call("search", { query: "cote d'ivoire" });
  assert.ok(s.results.some((r) => r.id === "item:503"), JSON.stringify(s.results));
});

test("fetch: the appended window is sized to what max_chars leaves, so paging has no gap", async () => {
  const full = await call("get_publication", { id: 510, include_fulltext: true });
  const total = full.fulltext_length;

  // A max_chars the header does not fill on its own: the window shrinks to fit
  // and *_returned_chars must describe exactly what landed in `text`.
  const MAX = 900;
  const marker = "Full text:\n";
  const capped = await call("fetch", { id: "pub:510", include_fulltext: true, max_chars: MAX });
  assert.ok(capped.text.includes(marker), "the full text was appended");
  const appended = capped.text.slice(capped.text.indexOf(marker) + marker.length);
  assert.equal(capped.metadata.fulltext_returned_chars, appended.length, "returned_chars describes the body");
  assert.ok(capped.text.length <= MAX, "body still honours max_chars");
  assert.ok(appended.length < total, "the full text was windowed, not whole");
  assert.ok(full.fulltext.startsWith(appended), "page 1 is a true prefix of the full text");

  // Paging on offset + returned_chars must continue exactly where page 1 ended.
  // This is the regression: the window used to take its full quota, capText
  // then trimmed the tail, and page 2 skipped the header's worth of characters.
  const page2 = await call("fetch", {
    id: "pub:510",
    include_fulltext: true,
    max_chars: MAX,
    fulltext_offset: capped.metadata.fulltext_returned_chars,
  });
  const appended2 = page2.text.slice(page2.text.indexOf(marker) + marker.length);
  assert.equal(
    appended + appended2,
    full.fulltext.slice(0, appended.length + appended2.length),
    "page 1 + page 2 reconstruct the text with no dropped characters",
  );

  // A max_chars the metadata header alone fills: report that, rather than
  // appending a slice capText would then trim into a lie.
  const tiny = await call("fetch", { id: "pub:510", include_fulltext: true, max_chars: 200 });
  assert.equal(tiny.metadata.fulltext_included, false);
  assert.equal(tiny.metadata.has_fulltext, true);
  assert.equal(tiny.metadata.fulltext_length, total);
  assert.ok(tiny.metadata.fulltext_hint.includes("max_chars"));
  assert.ok(!tiny.text.includes(marker), "no partial full text smuggled into the body");
  assert.ok(!("fulltext_returned_chars" in tiny.metadata), "nothing to report as returned");

  // Transcripts take the identical path (one helper, both fields).
  const tMarker = "Transcript:\n";
  const vid = await call("fetch", { id: "video:540", include_transcript: true, max_chars: 700 });
  assert.ok(vid.text.includes(tMarker), "the transcript was appended");
  const tAppended = vid.text.slice(vid.text.indexOf(tMarker) + tMarker.length);
  assert.equal(vid.metadata.transcript_returned_chars, tAppended.length);
  assert.ok(vid.text.length <= 700);
  const wholeTranscript = await call("get_video", { id: 540, include_transcript: true });
  assert.ok(wholeTranscript.transcript.startsWith(tAppended), "the window is a true prefix");
});

test("search ranking: a title hit outranks a long full-text hit", async () => {
  // Publication 510's full text repeats its tokens ~30x; item 500 has the term
  // in its title once. Length must not beat relevance.
  const ranked = await call("search", { query: "architecture" });
  const titleHit = ranked.results.findIndex((r) => r.id === "item:500");
  const bodyHit = ranked.results.findIndex((r) => r.id === "pub:510");
  assert.ok(titleHit >= 0, "the title match is returned");
  assert.ok(bodyHit === -1 || titleHit < bodyHit, `title ${titleHit} should precede fulltext ${bodyHit}`);
});

test("search types filter restricts the result set to the named kinds", async () => {
  const projects = await call("search", { query: "fixture", types: ["project"] });
  assert.ok(projects.results.length > 0);
  assert.ok(projects.results.every((r) => r.id.startsWith("project:")), JSON.stringify(projects.results));

  const two = await call("search", { query: "fixture", types: ["project", "video"] });
  assert.ok(two.results.every((r) => r.id.startsWith("project:") || r.id.startsWith("video:")));

  // No types = every corpus, as before.
  const all = await call("search", { query: "fixture" });
  assert.ok(all.results.length >= two.results.length);
});

const APPS = [
  { tool: "list_years", uri: "ui://amira/timeline" },
  { tool: "get_collection_overview", uri: "ui://amira/overview" },
  { tool: "list_research_sections", uri: "ui://amira/sections" },
  { tool: "find_related", uri: "ui://amira/related" },
];

test("MCP Apps: each opted-in tool links to a self-contained ui:// resource", async () => {
  const { tools } = await client.listTools();
  const { resources } = await client.listResources();

  for (const { tool, uri } of APPS) {
    // The extension contract: the tool points at a ui:// resource via _meta.ui.
    const t = tools.find((x) => x.name === tool);
    assert.equal(t._meta?.ui?.resourceUri, uri, tool);
    assert.deepEqual(t._meta.ui.visibility, ["model", "app"], tool);

    const listed = resources.find((r) => r.uri === uri);
    assert.ok(listed, `${uri} is actually served`);
    assert.equal(listed.mimeType, "text/html;profile=mcp-app", uri);

    const read = await client.readResource({ uri });
    const html = read.contents[0].text;
    assert.equal(read.contents[0].mimeType, "text/html;profile=mcp-app", uri);
    assert.ok(html.startsWith("<!doctype html>"), uri);
    // It must speak the MCP Apps dialect...
    assert.ok(html.includes("ui/initialize"), uri);
    assert.ok(html.includes("ui/notifications/tool-result"), uri);
    assert.ok(html.includes("ui/notifications/initialized"), uri);
    // ...and be self-contained, so no csp domains are needed to render it.
    assert.ok(!/<script[^>]+src=/i.test(html), `${uri}: no external scripts`);
    assert.ok(!/<link[^>]+href=/i.test(html), `${uri}: no external stylesheets`);
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="[^"]*"/g, "")), `${uri}: no remote origins`);
    // Colours come from the DRE theme and were validated against its surfaces.
    assert.ok(html.includes("#007a50") && html.includes("#35a87d"), `${uri}: DRE accent in both modes`);
  }

  // Hosts without the extension must still get the plain result, unchanged.
  const years = await call("list_years", { bucket: "decade" });
  assert.ok(Array.isArray(years.results) && years.results.length > 0);
  const overview = await call("get_collection_overview");
  assert.equal(overview.counts.publications, 2);
});
