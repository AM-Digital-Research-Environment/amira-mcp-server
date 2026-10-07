// 1.19 behaviour end to end against the fixture snapshot: place matching,
// typed-id interoperability, person resolution, new record fields, filters,
// exports, prompts, completions, resources, profiles and the shared policy.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

const conn = await connectInMemory(lib, { openai: true }, { name: "features" });
const { client, call, raw } = conn;
test.after(() => conn.close());

const errorOf = (result) => {
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  return JSON.parse(result.content[0].text).error;
};
const ids = (page) => page.results.map((r) => r.omeka_id ?? Number(r.id));

test("country is an exact match on the chain root, with aliases", async () => {
  assert.deepEqual(ids(await call("search_research_items", { country: "Nigeria" })).sort(), [500, 501]);
  assert.equal((await call("search_research_items", { country: "Niger" })).total_matches, 0, "Niger is not a substring of Nigeria any more");
  assert.deepEqual(ids(await call("search_research_items", { country: "Ivory Coast" })), [503], "alias of the stored Côte d'Ivoire");
  const rows = (await call("list_locations", { country: "Nigeria" })).results.map((r) => r.name).sort();
  assert.deepEqual(rows, ["Lagos", "Nigeria"]);
});

test("location: exact at any level, word-prefix fallback, suggestions on a miss", async () => {
  assert.deepEqual(ids(await call("search_research_items", { location: "Lagos" })), [500]);
  assert.deepEqual(ids(await call("search_research_items", { location: "Nigeria" })).sort(), [500, 501]);
  assert.deepEqual(ids(await call("search_research_items", { location: "Bayr" })), [502], "prefix of an unknown name");
  const miss = await call("search_research_items", { location: "Lagoss" });
  assert.equal(miss.total_matches, 0);
  assert.deepEqual(miss.did_you_mean, [{ filter: "location", values: ["Lagos"] }]);
  // find_related uses the same matcher: "Lagos" names one city exactly.
  assert.equal((await call("find_related", { entity_type: "location", value: "Lagos" })).matched_items, 1);
});

test("typed ids from either vocabulary work in every tool", async () => {
  assert.equal((await call("get_research_item", { id: "item:500" })).omeka_id, 500);
  assert.equal((await call("get_research_item", { id: "research_item:500" })).omeka_id, 500);
  assert.equal((await call("get_publication", { id: "publication:510" })).omeka_id, 510);
  assert.equal((await call("fetch", { id: "research_item:500" })).id, "research_item:500");
  assert.equal((await call("fetch", { id: "publication:510" })).title, "Decolonial Architecture Futures");
  assert.equal((await call("get_project", { id: "project:300" })).omeka_id, 300);
  assert.equal((await call("get_research_section", { id: "section:400" })).name, "Arts & Aesthetics");
  assert.equal((await call("get_institution", { id: "organisation:200" })).name, "University of Bayreuth");
  assert.equal((await call("get_person", { id: "person:100" })).name, "Beier, Ulli");
  const graph = await call("get_entity_graph", { seed: "item:500" });
  assert.equal(graph.seed, "research_item:500");
  const passages = await call("get_text_passages", { ids: ["pub:510"], keyword: "decolonial" });
  assert.deepEqual(passages.unavailable_ids, []);
  assert.equal((await call("resolve_entity", { query: "item:500" })).results[0].id, "research_item:500");
});

test("get_person: fragments are not people; profiles carry identifiers and collaborators", async () => {
  const fragment = errorOf(await raw("get_person", { name: "Bei" }));
  assert.equal(fragment.code, "not_found");
  assert.equal(fragment.suggested_tool, "resolve_entity");
  const beier = await call("get_person", { name: "Ulli Beier" });
  assert.deepEqual(beier.identifiers, [{ scheme: "gnd", id: "118508121", url: "https://d-nb.info/gnd/118508121" }]);
  assert.equal(beier.publication_count, 1, "only publications crediting the full name");
  assert.ok(Array.isArray(beier.top_collaborators));
});

test("research item detail: media, IIIF, provenance links, typed identifiers, affiliation at the time", async () => {
  const it = await call("get_research_item", { id: 500 });
  assert.deepEqual(it.media, [{ type: "image/webp", url: "https://data.africamultiple.uni-bayreuth.de/files/original/fx.webp", source: null, size: 1234 }]);
  assert.match(it.iiif_manifest, /\/iiif\/3\/500\/manifest$/);
  assert.deepEqual(it.provenance, [{ name: "Iwalewahaus", amira_url: lib.itemUrl(205) }]);
  assert.deepEqual(it.identifiers, [{ value: "FX_00500", type: "Locally defined identifier" }]);
  assert.equal(it.contributors[0].affiliation_at_time, "Iwalewahaus");
  assert.equal(it.extent, "126 KB");
  assert.equal(it.created, "2026-03-26T10:29:56+00:00");
  const summary = (await call("search_research_items", { location: "Lagos" })).results[0];
  assert.equal(summary.has_media, true);
  assert.deepEqual(summary.media_types, ["image/webp"]);
});

test("has_media, added_since and modified_since filters; invalid dates are refused", async () => {
  assert.deepEqual(ids(await call("search_research_items", { has_media: true })), [500]);
  assert.deepEqual(ids(await call("search_research_items", { added_since: "2026-01-01" })), [500]);
  assert.deepEqual(ids(await call("search_research_items", { modified_since: "2026-09-01" })), [500]);
  assert.equal((await call("search_research_items", { modified_since: "2026-10-01" })).total_matches, 0);
  assert.equal(errorOf(await raw("search_research_items", { added_since: "last week" })).code, "invalid_date");
  assert.equal(errorOf(await raw("search_publications", { added_since: "2026-13-45" })).code, "invalid_date");
});

test("multi-word keywords match every word; quoted phrases stay literal", async () => {
  assert.deepEqual(ids(await call("search_research_items", { keyword: "Lagos painting" })), [500]);
  assert.equal((await call("search_research_items", { keyword: '"painting Lagos"' })).total_matches, 0);
});

test("relaxation hints name real parameters", async () => {
  const empty = await call("search_research_items", { subject: "Architecture", year_from: 1900, year_to: 1901 });
  assert.ok(empty.suggestions.some((s) => s.remove_filter === "year_from/year_to"));
});

test("exposure gate is shared: list_years accepts keyword filters below structured", async () => {
  process.env.AMIRA_EXPOSURE = "descriptive";
  try {
    const years = await call("list_years", { filters: { keyword: "Yoruba" } });
    assert.equal(years.dated_items, 1);
    assert.equal(errorOf(await raw("list_years", { filters: { subject: "Islam" } })).code, "exposure_restricted");
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});

test("subjects carry their vocabulary and authority URI", async () => {
  const lcsh = await call("list_subjects", { vocabulary: "lcsh" });
  assert.deepEqual(lcsh.results.map((r) => [r.subject, r.vocabulary, r.authority_uri]),
    [["Architecture", "lcsh", "http://id.loc.gov/authorities/subjects/sh85006611"]]);
  assert.deepEqual((await call("list_subjects", { vocabulary: "tag" })).results.map((r) => r.subject), ["Islam"]);
});

test("list_locations: Wikidata ids and geographic filters", async () => {
  const nigeria = (await call("list_locations", { keyword: "Nigeria" })).results[0];
  assert.equal(nigeria.wikidata, "http://www.wikidata.org/entity/Q1033");
  const near = await call("list_locations", { near: { latitude: 6.5, longitude: 3.4, km: 50 } });
  assert.deepEqual(near.results.map((r) => r.name), ["Lagos"]);
  const box = await call("list_locations", { bbox: [5, 45, 15, 55] });
  assert.deepEqual(box.results.map((r) => r.name).sort(), ["Bayreuth", "Germany"]);
});

test("organisations resolve by acronym and list rows carry ids", async () => {
  assert.equal((await call("get_institution", { name: "UBT" })).omeka_id, 200);
  const rows = (await call("list_institutions", { keyword: "UBT" })).results;
  assert.deepEqual(rows.map((r) => [r.id, r.omeka_id]), [["200", 200]]);
  assert.deepEqual((await call("list_collections")).results.map((r) => r.id), ["800"]);
});

test("search_podcasts filters by language; podcasts and videos return string ids", async () => {
  assert.equal((await call("search_podcasts", { language: "en" })).total_matches, 1);
  assert.equal((await call("search_podcasts", { language: "fr" })).total_matches, 0);
  assert.equal((await call("search_videos")).results[0].id, "540");
});

test("export links resolve to complete files", async () => {
  const result = await raw("search_research_items", { country: "Nigeria", export: "csv" });
  const link = result.content.find((c) => c.type === "resource_link");
  assert.match(link.uri, /^amira:\/\/export\/research_items\/csv\//);
  assert.equal(result.structuredContent.export.total_matches, 2);
  const csv = (await client.readResource({ uri: link.uri })).contents[0];
  assert.equal(csv.mimeType, "text/csv");
  const lines = csv.text.trim().split("\r\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^omeka_id,title,/);

  const bib = await raw("search_publications", { export: "bibtex" });
  const bibLink = bib.content.find((c) => c.type === "resource_link");
  const text = (await client.readResource({ uri: bibLink.uri })).contents[0].text;
  assert.equal((text.match(/^@/gm) ?? []).length, 2);
  await assert.rejects(client.readResource({ uri: "amira://export/research_items/pdf/e30" }));
});

test("record and dataset resources", async () => {
  const rec = JSON.parse((await client.readResource({ uri: "amira://record/research_item/500" })).contents[0].text);
  assert.equal(rec.title, "Yoruba Architecture Study");
  const place = JSON.parse((await client.readResource({ uri: "amira://record/location/900" })).contents[0].text);
  assert.equal(place.wikidata, "http://www.wikidata.org/entity/Q1033");
  await assert.rejects(client.readResource({ uri: "amira://record/research_item/999999" }));
  const ds = JSON.parse((await client.readResource({ uri: "amira://dataset" })).contents[0].text);
  assert.equal(ds["@type"], "Dataset");
  assert.ok(ds.variableMeasured.some((v) => v.name === "research_items" && v.value === 4));
  const templates = await client.listResourceTemplates();
  assert.deepEqual(templates.resourceTemplates.map((t) => t.uriTemplate).sort(),
    ["amira://export/{corpus}/{format}/{query}", "amira://record/{kind}/{id}"]);
});

test("prompts and argument completion", async () => {
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(),
    ["literature_review", "person_profile", "place_report", "project_dossier", "transcript_evidence"]);
  const prompt = await client.getPrompt({ name: "person_profile", arguments: { name: "Beier, Ulli" } });
  assert.match(prompt.messages[0].content.text, /resolve_entity/);
  assert.match(prompt.messages[0].content.text, /amira_url/);
  const completion = await client.complete({ ref: { type: "ref/prompt", name: "person_profile" }, argument: { name: "name", value: "Fen" } });
  assert.deepEqual(completion.completion.values, ["Fendler, Ute"]);
  const place = await client.complete({ ref: { type: "ref/prompt", name: "place_report" }, argument: { name: "place", value: "lag" } });
  assert.deepEqual(place.completion.values, ["Lagos"]);
});

test("discovery: no annotation titles, entry tools always loaded", async () => {
  const { tools } = await client.listTools();
  assert.ok(tools.every((t) => !t.annotations?.title));
  assert.deepEqual(tools.filter((t) => t._meta?.["anthropic/alwaysLoad"]).map((t) => t.name).sort(),
    ["get_collection_overview", "resolve_entity"]);
});

test("profiles remove tools and the apps that render them", async () => {
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const [profile, members] of Object.entries(lib.TOOL_PROFILES)) {
    for (const tool of members ?? []) assert.ok(names.has(tool), `${profile} lists unknown tool ${tool}`);
  }
  const discovery = await connectInMemory(lib, { openai: true, profile: "discovery" }, { name: "profile" });
  try {
    const listed = (await discovery.client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(listed, [...lib.TOOL_PROFILES.discovery].sort());
    const apps = (await discovery.client.listResources()).resources.filter((r) => r.uri.startsWith("ui://")).map((r) => r.uri).sort();
    assert.deepEqual(apps, ["ui://amira/graph", "ui://amira/map", "ui://amira/overview", "ui://amira/related"]);
    await assert.rejects(discovery.client.callTool({ name: "list_years", arguments: {} }));
  } finally {
    await discovery.close();
  }
});

test("empty required arguments are refused clearly; blank optional ones are ignored", async () => {
  assert.equal(errorOf(await raw("get_project", { id: "   " })).code, "invalid_argument");
  const blank = await call("search_research_items", { collection: "  ", subject: "Islam " });
  assert.equal(blank.total_matches, 2);
  assert.deepEqual(blank.filters, { subject: "Islam" });
});

test("ranked search interleaves corpora on equal scores", async () => {
  const hits = (await call("search", { query: "fixture", limit: 6 })).results.map((r) => r.id.split(":")[0]);
  assert.ok(new Set(hits.slice(0, 4)).size > 1, `first hits should mix corpora: ${hits}`);
});

test("pages stop under the size budget and continue without gaps", async () => {
  const store = lib.currentStore();
  const original = [...store.items];
  const filler = (i) => ({ ...original[0], o_id: 90_000 + i, dre_id: `fx-big-${i}`, title: `Bulk ${i} ` + "x".repeat(2_000) });
  store.items.push(...Array.from({ length: 40 }, (_, i) => filler(i)));
  try {
    const seen = [];
    let offset = 0, limited = false;
    for (;;) {
      // resource_type, not keyword: the keyword index is memoised per snapshot.
      const page = await call("search_research_items", { resource_type: "Image", limit: 100, offset });
      assert.ok(JSON.stringify(page).length < 45_000);
      limited ||= page.response_limited === true;
      seen.push(...ids(page));
      if (!page.has_more) break;
      assert.equal(page.next_offset, offset + page.count);
      offset = page.next_offset;
    }
    assert.ok(limited, "the oversized page reports response_limited");
    const expected = original.filter((it) => it.type === "Image").length + 40;
    assert.equal(seen.length, expected);
    assert.equal(new Set(seen).size, expected);
  } finally {
    store.items.splice(0, store.items.length, ...original);
  }
});
