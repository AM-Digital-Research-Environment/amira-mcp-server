// Exact-assertion coverage for the tools that had only smoke coverage
// (review 2026-10-06, "Testing and CI"): get_institution, get_project,
// get_research_section, list_categories, list_cluster_partners,
// list_collections, list_groups, list_institutions, search_projects, plus
// `fetch` for every record kind, and deeper checks of search_persons,
// get_podcast and list_research_sections.
//
// The shared fixture is extended HERE, in this process only (the shared file
// stays untouched, so no other suite's counts move): a second AMRC institution
// that is a partner by name only, a privileged partner linked by
// dcterms:isPartOf, an AM 2.0 section, a project linked to a section by id
// under a stale label, a group-credited item and a second podcast episode.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
const KNOWLEDGES_DESCRIPTION = "Knowledges section text. ".repeat(16).trim(); // 400 chars: list views abbreviate it
d.persons.push({
  o_id: 102, name: "Kaboré, Awa", affiliations: [{ label: "Université Joseph Ki-Zerbo", o_id: 202 }],
  identifiers: [{ scheme: "orcid", id: "0000-0002-1825-0097", url: "https://orcid.org/0000-0002-1825-0097" }],
  alt_names: ["Awa Kabore-Ouédraogo"],
});
d.organisations.push(
  // An AMRC by NAME only (no dcterms:isPartOf): the offline fallback list.
  { o_id: 202, name: "Université Joseph Ki-Zerbo", kind: "institution", part_of: [], latitude: 12.37, longitude: -1.5,
    wikidata: "http://www.wikidata.org/entity/Q3551690", alt_names: ["UJKZ"],
    identifiers: [{ scheme: "ror", id: "00t5e2y66", url: "https://ror.org/00t5e2y66" }] },
  // A privileged partner by isPartOf link, without coordinates.
  { o_id: 203, name: "Center for Afro-Oriental Studies", kind: "institution", part_of: [{ label: "Privileged partner", o_id: 39073 }],
    latitude: null, longitude: null, wikidata: null, alt_names: ["CEAO"], identifiers: [] },
);
d.research_sections.push({
  o_id: 402, name: "Knowledges", description: KNOWLEDGES_DESCRIPTION, date: { start: "2026-01-01", end: "2032-12-31" },
  pis: [], members: [{ label: "Kaboré, Awa", o_id: 102 }], spokesperson: "Kaboré, Awa", url: "https://example.org/knowledges",
});
d.projects.push({
  o_id: 302, dre_id: "UJKZ_Sound2021", name: "Ouaga Sound Archive", description: "Urban soundscapes of Ouagadougou.",
  // Linked to section 400 by id under a STALE label (the section was renamed).
  sections: [{ label: "Arts and Aesthetics (renamed)", o_id: 400 }, { label: "Knowledges", o_id: 402 }],
  pis: [{ label: "Kaboré, Awa", o_id: 102 }], members: [{ label: "Beier, Ulli", o_id: 100 }],
  funded_by: [{ label: "Université Joseph Ki-Zerbo", o_id: 202 }], date: { start: "2021-01-01", end: null },
  url: "https://example.org/osa", university: "ujkz", alt_names: ["OSA"],
});
d.item_sets.push({ o_id: 801, title: "Sound Collection" });
d.research_items.push({
  ...structuredClone(d.research_items[1]),
  o_id: 504, dre_id: "ujkz-fx-0504", title: "Ouagadougou Street Recording", type: "Sound",
  project: { label: "Ouaga Sound Archive", o_id: 302 }, subjects: [{ label: "Music", o_id: 603 }], places: [],
  languages: [{ label: "French", o_id: 700 }], formats: [], format_notes: ["field recording"],
  contributors: [{ name: "Test Research Group", role: "Publisher", o_id: 201 }, { name: "Kaboré, Awa", role: "Recordist", o_id: 102 }],
  dates: { created: "2021" }, year_min: 2021, year_max: 2021, description: "Street sounds.", has_media: true,
  // 899 is referenced by the item but absent from item_sets: "Collection 899".
  item_sets: [800, 801, 899], university: "ujkz",
  media: [{ o_id: 9504, type: "audio/mpeg", url: "https://example.org/osa.mp3", source: null, size: 2048 }],
});
d.podcasts.push({
  o_id: 531, title: "Fixture Conversations Episode 2", series: { label: "Cluster Conversations", o_id: 555 }, episode: 2,
  date: "2099-01-01", year: 2099, abstract: "A scheduled episode.",
  people: [{ name: "Kaboré, Awa", role: "Host", o_id: 102, affiliation: { label: "Université Joseph Ki-Zerbo", o_id: 202 } }],
  url: "https://example.org/podcast/2", transcript: "Second episode transcript.", languages: [{ label: "French", o_id: 700 }],
  duration: "PT42M", transcript_generated_by: { label: "Whisper large-v3", o_id: 777 },
  media: [{ o_id: 9531, type: "audio/mpeg", url: "https://example.org/ep2.mp3", source: null, size: 4096 }],
});
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, { openai: true }, { name: "tools-coverage" });
const { call, raw } = conn;
test.after(async () => {
  delete process.env.AMIRA_EXPOSURE;
  await conn.close();
});

const url = (id) => lib.itemUrl(id);
const SITE = url(0).replace(/\/s\/amira\/item\/0$/, "");
/** The error of an isError result; errors are text-only (no structuredContent). */
async function errorOf(name, args) {
  const result = await raw(name, args);
  assert.equal(result.isError, true, `${name} should fail`);
  assert.equal(result.structuredContent, undefined, `${name}: error results carry no structuredContent`);
  return JSON.parse(result.content[0].text).error;
}
const omekaIds = (page) => page.results.map((r) => r.omeka_id);
const itemRef = (id, title, type, date) => ({ id: String(id), omeka_id: id, title, type, date, amira_url: url(id) });
const AMRC = { key: "amrc", name: "Africa Multiple Research Centres", omeka_id: 37685, amira_url: url(37685) };

// --- institutions and groups ---------------------------------------------------

const UBT = {
  id: "200", omeka_id: 200, name: "University of Bayreuth", name_variants: ["UBT"], kind: "institution",
  part_of: [{ id: "37685", omeka_id: 37685, name: "Africa Multiple Research Centres", amira_url: url(37685) }],
  partner_categories: [AMRC], latitude: 49.94, longitude: 11.58, wikidata: null, identifiers: [],
  project_count: 1, projects: [{ id: "300", omeka_id: 300, name: "Fixture Art Worlds" }],
  affiliated_person_count: 1, affiliated_persons: ["Beier, Ulli"],
  contributed_item_count: 0, contributed_items: [], amira_url: url(200),
};
const UJKZ = {
  id: "202", omeka_id: 202, name: "Université Joseph Ki-Zerbo", name_variants: ["UJKZ"], kind: "institution",
  part_of: [], partner_categories: [AMRC], latitude: 12.37, longitude: -1.5,
  wikidata: "http://www.wikidata.org/entity/Q3551690",
  identifiers: [{ scheme: "ror", id: "00t5e2y66", url: "https://ror.org/00t5e2y66" }],
  project_count: 1, projects: [{ id: "302", omeka_id: 302, name: "Ouaga Sound Archive" }],
  affiliated_person_count: 1, affiliated_persons: ["Kaboré, Awa"],
  contributed_item_count: 0, contributed_items: [], amira_url: url(202),
};

test("get_institution: by name, acronym, folded spelling, id and every typed-id prefix", async () => {
  for (const args of [{ name: "University of Bayreuth" }, { name: "UBT" }, { name: "  ubt  " }, { id: 200 }, { id: "200" },
    { id: "organisation:200" }, { id: "organization:200" }, { id: "institution:200" }, { name: "200" }]) {
    assert.deepEqual(await call("get_institution", args), UBT, JSON.stringify(args));
  }
  for (const args of [{ name: "Université Joseph Ki-Zerbo" }, { name: "Universite Joseph Ki-Zerbo" }, { name: "UJKZ" }, { id: "organisation:202" }]) {
    assert.deepEqual(await call("get_institution", args), UJKZ, JSON.stringify(args));
  }
  // id wins over name when both are given.
  assert.equal((await call("get_institution", { id: 202, name: "UBT" })).omeka_id, 202);
});

test("get_institution: partner category from an isPartOf link; groups get item credits, no categories", async () => {
  assert.deepEqual(await call("get_institution", { name: "CEAO" }), {
    id: "203", omeka_id: 203, name: "Center for Afro-Oriental Studies", name_variants: ["CEAO"], kind: "institution",
    part_of: [{ id: "39073", omeka_id: 39073, name: "Privileged partner", amira_url: url(39073) }],
    partner_categories: [{ key: "privileged", name: "Privileged partner", omeka_id: 39073, amira_url: url(39073) }],
    wikidata: null, identifiers: [], project_count: 0, projects: [], affiliated_person_count: 0, affiliated_persons: [],
    contributed_item_count: 0, contributed_items: [], amira_url: url(203),
  });
  assert.deepEqual(await call("get_institution", { id: "group:201" }), {
    id: "201", omeka_id: 201, name: "Test Research Group", kind: "group", part_of: [], partner_categories: [],
    wikidata: null, identifiers: [], project_count: 0, projects: [], affiliated_person_count: 0, affiliated_persons: [],
    contributed_item_count: 1, contributed_items: [itemRef(504, "Ouagadougou Street Recording", "Sound", "2021")],
    amira_url: url(201),
  });
});

test("get_institution: not_found and missing_entity are text-only errors", async () => {
  for (const args of [{ name: "Nowhere University" }, { id: 999999 }, { id: "organisation:abc" }, { id: "person:100" }]) {
    const error = await errorOf("get_institution", args);
    assert.equal(error.code, "not_found", JSON.stringify(args));
    assert.equal(error.suggested_tool, "list_institutions");
  }
  assert.equal((await errorOf("get_institution", { name: "Nowhere University" })).message,
    "No institution or group matching 'Nowhere University'.");
  assert.equal((await errorOf("get_institution", {})).code, "missing_entity");
  assert.equal((await errorOf("get_institution", { name: "   " })).code, "missing_entity", "a blank optional name is dropped");
});

test("list_institutions: rows, acronym/variant keyword, pagination and limit clamp", async () => {
  const all = await call("list_institutions");
  assert.deepEqual(all, {
    count: 3, total_matches: 3, offset: 0, has_more: false,
    results: [
      { name: "University of Bayreuth", id: "200", omeka_id: 200, name_variants: ["UBT"], project_count: 1,
        partner_categories: ["Africa Multiple Research Centres"], latitude: 49.94, longitude: 11.58, amira_url: url(200) },
      { name: "Université Joseph Ki-Zerbo", id: "202", omeka_id: 202, name_variants: ["UJKZ"], project_count: 1,
        partner_categories: ["Africa Multiple Research Centres"], latitude: 12.37, longitude: -1.5, amira_url: url(202) },
      { name: "Center for Afro-Oriental Studies", id: "203", omeka_id: 203, name_variants: ["CEAO"], project_count: 0,
        partner_categories: ["Privileged partner"], amira_url: url(203) },
    ],
  });
  for (const [keyword, expected] of [["ujkz", [202]], ["ceao", [203]], ["UBT", [200]], ["Ki-Zerbo", [202]],
    ["universite", [202]], ["university", [200]], ["Test Research Group", []]]) {
    const page = await call("list_institutions", { keyword });
    assert.deepEqual(omekaIds(page), expected, keyword);
    assert.deepEqual(page.filters, { keyword });
  }
  const first = await call("list_institutions", { limit: 1 });
  assert.deepEqual([first.count, first.has_more, first.next_offset], [1, true, 1]);
  const last = await call("list_institutions", { limit: 1, offset: 2 });
  assert.deepEqual([omekaIds(last), last.has_more, last.next_offset], [[203], false, undefined]);
  const clamped = await call("list_institutions", { limit: 500 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit, clamped.count], [500, 200, 3]);
  assert.equal((await call("list_institutions", { limit: 200 })).requested_limit, undefined, "an honoured limit is not echoed");
});

test("list_groups: groups only, with credited-item counts", async () => {
  const expected = { name: "Test Research Group", id: "201", omeka_id: 201, contributed_item_count: 1, amira_url: url(201) };
  assert.deepEqual(await call("list_groups"), { count: 1, total_matches: 1, offset: 0, has_more: false, results: [expected] });
  assert.deepEqual((await call("list_groups", { keyword: "research group" })).results, [expected]);
  assert.equal((await call("list_groups", { keyword: "Bayreuth" })).total_matches, 0, "institutions are not groups");
  const clamped = await call("list_groups", { limit: 1000 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit], [1000, 200]);
});

test("list_cluster_partners: all four categories, each filter form, invalid_category", async () => {
  const partner = (id, name, extra = {}) => ({ id: String(id), omeka_id: id, name, ...extra, amira_url: url(id) });
  const amrc = {
    key: "amrc", name: "Africa Multiple Research Centres", omeka_id: 37685,
    description: "AMRC/coordinating host institutions represented in Omeka's partner-category authority.",
    member_count: 2, amira_url: url(37685),
    partners: [
      partner(202, "Université Joseph Ki-Zerbo", { latitude: 12.37, longitude: -1.5, wikidata: "http://www.wikidata.org/entity/Q3551690" }),
      partner(200, "University of Bayreuth", { latitude: 49.94, longitude: 11.58, wikidata: null }),
    ],
  };
  const privileged = {
    key: "privileged", name: "Privileged partner", omeka_id: 39073,
    description: "Privileged partner institution; Bahia/CEAO belongs here, not under AMRCs.",
    member_count: 1, amira_url: url(39073), partners: [partner(203, "Center for Afro-Oriental Studies", { wikidata: null })],
  };
  const all = await call("list_cluster_partners");
  assert.equal(all.filters, undefined);
  assert.equal(all.category_count, 4);
  assert.equal(all.partner_count, 3);
  assert.match(all.source, /isPartOf/);
  assert.deepEqual(all.categories.map((c) => [c.key, c.omeka_id, c.member_count]),
    [["amrc", 37685, 2], ["privileged", 39073, 1], ["cooperation", 39072, 0], ["global", 39071, 0]]);
  assert.deepEqual(all.categories[0], amrc);
  assert.deepEqual(all.categories[1], privileged);

  for (const category of ["amrc", "AMRC", "Africa Multiple Research Centres", "research centres"]) {
    const one = await call("list_cluster_partners", { category });
    assert.deepEqual(one, { source: all.source, filters: { category }, category_count: 1, partner_count: 2, categories: [amrc] }, category);
  }
  // A label fragment resolves to the first category whose name contains it.
  assert.deepEqual((await call("list_cluster_partners", { category: "partner" })).categories, [privileged]);
  const cooperation = await call("list_cluster_partners", { category: "cooperation" });
  assert.deepEqual([cooperation.partner_count, cooperation.categories[0].partners], [0, []]);

  const error = await errorOf("list_cluster_partners", { category: "nope" });
  assert.deepEqual(error, {
    code: "invalid_category", message: "Unknown partner category 'nope'.", suggested_tool: "list_cluster_partners",
    available_values: [
      { key: "amrc", name: "Africa Multiple Research Centres" }, { key: "privileged", name: "Privileged partner" },
      { key: "cooperation", name: "Cooperation partners" }, { key: "global", name: "Global partner Centres of African Studies" },
    ],
  });
});

// --- facets ----------------------------------------------------------------------

test("list_collections: ranked item sets with string id, omeka_id, IIIF and item-set links", async () => {
  const row = (id, collection, count) => ({ collection, id: String(id), omeka_id: id, item_count: count,
    iiif_collection: `${SITE}/iiif/3/collection/${id}`, amira_url: `${SITE}/s/amira/item-set/${id}` });
  assert.deepEqual(await call("list_collections"), {
    distinct_collections: 3, count: 3, total_matches: 3, offset: 0, has_more: false,
    results: [row(800, "Fixture Collection", 3), row(801, "Sound Collection", 1), row(899, "Collection 899", 1)],
  });
  assert.deepEqual(await call("list_collections", { keyword: "sound" }), {
    distinct_collections: 1, filters: { keyword: "sound" }, count: 1, total_matches: 1, offset: 0, has_more: false,
    results: [row(801, "Sound Collection", 1)],
  });
  const paged = await call("list_collections", { limit: 1, offset: 1 });
  assert.deepEqual([omekaIds(paged), paged.next_offset], [[801], 2]);
  const clamped = await call("list_collections", { limit: 201 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit], [201, 200]);
});

test("list_categories: formats (and the genres alias), languages with ISO codes, resource types", async () => {
  const formats = {
    category: "formats", distinct_values: 3, count: 3, total_matches: 3, offset: 0, has_more: false,
    results: [
      { value: "photograph", item_count: 1, amira_url: url(610) },
      { value: "gelatin print", item_count: 1, amira_url: null },
      { value: "field recording", item_count: 1, amira_url: null },
    ],
  };
  assert.deepEqual(await call("list_categories", { category: "formats" }), formats);
  assert.deepEqual(await call("list_categories", { category: "genres" }), formats, "'genres' is an alias of 'formats'");
  assert.deepEqual(await call("list_categories", { category: "languages" }), {
    category: "languages", distinct_values: 2, count: 2, total_matches: 2, offset: 0, has_more: false,
    results: [
      { value: "French", code: "fra", item_count: 2, amira_url: url(700) },
      { value: "English", code: "eng", item_count: 1, amira_url: url(701) },
    ],
  });
  assert.deepEqual(await call("list_categories", { category: "resource_types" }), {
    category: "resource_types", distinct_values: 3, count: 3, total_matches: 3, offset: 0, has_more: false,
    results: [
      { value: "Image", item_count: 3, amira_url: null },
      { value: "Audio", item_count: 1, amira_url: null },
      { value: "Sound", item_count: 1, amira_url: null },
    ],
  });
  const english = await call("list_categories", { category: "languages", keyword: "ENG" });
  assert.deepEqual([english.filters, english.results.map((r) => r.value)], [{ keyword: "ENG" }, ["English"]]);
  const clamped = await call("list_categories", { category: "formats", limit: 9999, offset: 2 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit, clamped.results.map((r) => r.value)],
    [9999, 500, ["field recording"]]);
  assert.equal((await raw("list_categories", { category: "tags" })).isError, true, "the old tags facet is gone");
});

// --- projects and sections ----------------------------------------------------------

const projectSummary = (id, name, university, sections, pis, itemCount) =>
  ({ id: String(id), omeka_id: id, name, university, research_sections: sections, principal_investigators: pis,
    item_count: itemCount, amira_url: url(id) });
const P300 = projectSummary(300, "Fixture Art Worlds", "University of Bayreuth", ["Arts & Aesthetics"], ["Beier, Ulli"], 2);
const P301 = projectSummary(301, "Fixture Music Library", "External collection", ["External"], [], 1);
const P302 = projectSummary(302, "Ouaga Sound Archive", "Université Joseph Ki-Zerbo",
  ["Arts and Aesthetics (renamed)", "Knowledges"], ["Kaboré, Awa"], 1);

test("search_projects: summaries, every filter, combinations and paging", async () => {
  assert.deepEqual(await call("search_projects"), { count: 3, total_matches: 3, offset: 0, has_more: false, results: [P300, P301, P302] });
  const cases = [
    [{ keyword: "art worlds" }, [300]],
    [{ keyword: "soundscapes" }, [302]], // description
    [{ keyword: "OSA" }, [302]], // name variant
    [{ keyword: "   " }, [300, 301, 302]], // blank optional filter dropped
    [{ university: "ujkz" }, [302]],
    [{ university: "Université Joseph" }, [302]],
    [{ university: "Bayreuth" }, [300]],
    [{ university: "external" }, [301]],
    [{ research_section: "Knowledges" }, [302]],
    [{ research_section: "external" }, [301]],
    [{ principal_investigator: "Ulli Beier" }, [300]],
    [{ principal_investigator: "Kabore" }, [302]],
    [{ member: "Beier" }, [302]],
    [{ member: "Ute Fendler" }, [300]],
    [{ institution: "Ki-Zerbo" }, [302]],
    [{ institution: "Bayreuth" }, [300]],
    [{ university: "ujkz", member: "Beier" }, [302]],
    [{ university: "ubt", member: "Beier" }, []],
  ];
  for (const [args, expected] of cases) {
    const page = await call("search_projects", args);
    assert.deepEqual(omekaIds(page), expected, JSON.stringify(args));
    assert.equal(page.total_matches, expected.length);
  }
  assert.deepEqual((await call("search_projects", { keyword: " soundscapes " })).filters, { keyword: "soundscapes" }, "arguments are trimmed");
  const first = await call("search_projects", { limit: 2 });
  assert.deepEqual([omekaIds(first), first.has_more, first.next_offset], [[300, 301], true, 2]);
  const clamped = await call("search_projects", { limit: 101 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit], [101, 100]);
});

test("search_projects research_section should match the section a project links by id",
  // Fixed in 1.19: search_projects resolves the section by name or id and follows the id link.
  async () => {
    // The other two section views already follow the id link:
    assert.deepEqual(omekaIds(await call("search_research_items", { research_section: "Arts & Aesthetics" })).sort(), [500, 501, 504]);
    assert.deepEqual((await call("get_research_section", { name: "Arts & Aesthetics" })).projects.map((p) => p.omeka_id), [300, 302]);
    // ...but search_projects drops 302 (returns [300]), and cannot take an id at all.
    assert.deepEqual(omekaIds(await call("search_projects", { research_section: "Arts & Aesthetics" })), [300, 302]);
    assert.deepEqual(omekaIds(await call("search_projects", { research_section: "section:400" })), [300, 302]);
  });

test("get_project: detail, sample items, media count, every id form", async () => {
  const p300 = {
    id: "300", omeka_id: 300, name: "Fixture Art Worlds", university: "University of Bayreuth",
    research_sections: ["Arts & Aesthetics"], principal_investigators: ["Beier, Ulli"], members: ["Fendler, Ute"],
    funded_by: ["University of Bayreuth"], description: "A fixture project about art worlds.",
    date: { start: "2019-06-01", end: "2022-05-31" }, website: null, item_count: 2, items_with_media: 1,
    items_by_resource_type: { Image: 2 },
    top_subjects: [{ subject: "Islam", item_count: 2 }, { subject: "Architecture", item_count: 1 }],
    sample_items: [itemRef(500, "Yoruba Architecture Study", "Image", "2013"), itemRef(501, "Mosque Photograph Series", "Image", "1955–1968")],
    amira_url: url(300),
  };
  for (const id of [300, "300", "project:300", "UBT_Fixture2019", "ubt_fixture2019", " project:300 "]) {
    assert.deepEqual(await call("get_project", { id }), p300, JSON.stringify(id));
  }
  assert.deepEqual(await call("get_project", { id: "project:302" }), {
    id: "302", omeka_id: 302, name: "Ouaga Sound Archive", name_variants: ["OSA"], university: "Université Joseph Ki-Zerbo",
    research_sections: ["Arts and Aesthetics (renamed)", "Knowledges"], principal_investigators: ["Kaboré, Awa"],
    members: ["Beier, Ulli"], funded_by: ["Université Joseph Ki-Zerbo"], description: "Urban soundscapes of Ouagadougou.",
    date: { start: "2021-01-01", end: null }, website: "https://example.org/osa", item_count: 1, items_with_media: 1,
    items_by_resource_type: { Sound: 1 }, top_subjects: [{ subject: "Music", item_count: 1 }],
    sample_items: [itemRef(504, "Ouagadougou Street Recording", "Sound", "2021")], amira_url: url(302),
  });
  for (const id of [999999, "project:999", "pub:510"]) {
    const error = await errorOf("get_project", { id });
    assert.deepEqual([error.code, error.suggested_tool], ["not_found", "search_projects"], String(id));
  }
  assert.equal((await errorOf("get_project", { id: 999999 })).message, "No project with id '999999'.");
});

test("get_project: sample_items stop at ten while counts cover every item", async () => {
  const store = await lib.ensureStore();
  const list = store.itemsForProject(301); // the store's own index array
  const template = list[0];
  list.push(...Array.from({ length: 11 }, (_, i) => ({ ...template, o_id: 7000 + i, title: `Extra ${i}`, has_media: i % 2 === 0, type: "Text" })));
  try {
    const p = await call("get_project", { id: 301 });
    assert.equal(p.item_count, 12);
    assert.equal(p.sample_items.length, 10);
    assert.equal(p.items_with_media, 6);
    assert.deepEqual(p.items_by_resource_type, { Text: 11, Audio: 1 }, "ranked by count");
    assert.deepEqual(p.sample_items.map((r) => r.omeka_id), [502, ...Array.from({ length: 9 }, (_, i) => 7000 + i)]);
  } finally {
    list.splice(1);
  }
});

const S400 = {
  id: "400", omeka_id: 400, name: "Arts & Aesthetics", funding_phase: "AM 1.0 (2019–2025)", date: { start: "2019", end: "2025" },
  description: "Fixture section on arts.", principal_investigators: ["Beier, Ulli"], members: [], spokesperson: null, website: null,
  // 302 links this section by id under a stale label and still counts.
  project_count: 2, item_count: 3, projects: [P300, P302], amira_url: url(400),
};

test("get_research_section: by name or id, projects linked by id, funding phases", async () => {
  for (const args of [{ name: "Arts & Aesthetics" }, { name: " arts & aesthetics " }, { id: 400 }, { id: "400" },
    { id: "section:400" }, { id: "research_section:400" }]) {
    assert.deepEqual(await call("get_research_section", args), S400, JSON.stringify(args));
  }
  assert.deepEqual(await call("get_research_section", { name: "Knowledges" }), {
    id: "402", omeka_id: 402, name: "Knowledges", funding_phase: "AM 2.0 (2026–2032)", date: { start: "2026-01-01", end: "2032-12-31" },
    description: KNOWLEDGES_DESCRIPTION, principal_investigators: [], members: ["Kaboré, Awa"], spokesperson: "Kaboré, Awa",
    website: "https://example.org/knowledges", project_count: 1, item_count: 1, projects: [P302], amira_url: url(402),
  });
  const external = await call("get_research_section", { id: "section:401" });
  assert.deepEqual([external.funding_phase, external.projects, external.item_count], [null, [P301], 1]);

  assert.deepEqual(await errorOf("get_research_section", { name: "Nope" }), {
    code: "not_found", message: "No research section named 'Nope'.", suggested_tool: "list_research_sections",
    available_values: ["Arts & Aesthetics", "External", "Knowledges"],
  });
  assert.equal((await errorOf("get_research_section", { id: 999 })).message, "No research section with id '999'.");
  assert.equal((await errorOf("get_research_section", { id: "project:300" })).code, "not_found");
  assert.equal((await errorOf("get_research_section", {})).code, "missing_entity");
});

test("list_research_sections: counts by id link, abbreviated descriptions", async () => {
  const summary = (s, extra) => ({ name: s.name, funding_phase: s.funding_phase, date: s.date,
    principal_investigators: s.principal_investigators, member_count: s.members.length, id: s.id, omeka_id: s.omeka_id,
    project_count: s.project_count, item_count: s.item_count, description: s.description, website: s.website, amira_url: s.amira_url, ...extra });
  const brief = `${KNOWLEDGES_DESCRIPTION.slice(0, 280).trimEnd()}…`;
  assert.deepEqual(await call("list_research_sections"), {
    count: 3,
    results: [
      summary(S400),
      { name: "External", funding_phase: null, date: { start: null, end: null }, principal_investigators: [], member_count: 0,
        id: "401", omeka_id: 401, project_count: 1, item_count: 1, description: null, website: null, amira_url: url(401) },
      { name: "Knowledges", funding_phase: "AM 2.0 (2026–2032)", date: { start: "2026-01-01", end: "2032-12-31" },
        principal_investigators: [], member_count: 1, id: "402", omeka_id: 402, project_count: 1, item_count: 1,
        description: brief, website: "https://example.org/knowledges", amira_url: url(402) },
    ],
  });
  assert.equal(brief.length, 281);
});

// --- people and podcasts ----------------------------------------------------------------

test("search_persons: name order, accents, variants, affiliation filters, paging", async () => {
  const person = (id, name, affiliations) => ({ id: String(id), omeka_id: id, name, affiliations, amira_url: url(id) });
  assert.deepEqual(await call("search_persons"), {
    count: 3, total_matches: 3, offset: 0, has_more: false,
    results: [person(100, "Beier, Ulli", ["University of Bayreuth"]), person(101, "Fendler, Ute", []),
      person(102, "Kaboré, Awa", ["Université Joseph Ki-Zerbo"])],
  });
  for (const [args, expected] of [
    [{ keyword: "Ulli Beier" }, [100]], [{ keyword: "beier, ulli" }, [100]], [{ keyword: "Be" }, [100]],
    [{ keyword: "kabore" }, [102]], [{ keyword: "Awa Kaboré" }, [102]], [{ keyword: "Ouedraogo" }, [102]],
    [{ keyword: "Bayreuth" }, [100]], [{ affiliation: "Ki-Zerbo" }, [102]], [{ affiliation: "Beier" }, []],
    [{ keyword: "Fendler", affiliation: "Bayreuth" }, []], [{ keyword: "Nobody Atall" }, []],
  ]) {
    const page = await call("search_persons", args);
    assert.deepEqual(omekaIds(page), expected, JSON.stringify(args));
    assert.deepEqual(page.filters, args);
  }
  const first = await call("search_persons", { limit: 1, offset: 1 });
  assert.deepEqual([omekaIds(first), first.next_offset], [[101], 2]);
  const clamped = await call("search_persons", { limit: 250 });
  assert.deepEqual([clamped.requested_limit, clamped.effective_limit], [250, 100]);
});

test("get_person: id, typed id and either name order agree; credits, projects, collaborators", async () => {
  const expected = {
    name: "Kaboré, Awa", found_in_authority_list: true, id: "102", omeka_id: 102, affiliations: ["Université Joseph Ki-Zerbo"],
    identifiers: [{ scheme: "orcid", id: "0000-0002-1825-0097", url: "https://orcid.org/0000-0002-1825-0097" }],
    name_variants: ["Awa Kabore-Ouédraogo"],
    as_principal_investigator: [{ id: "302", omeka_id: 302, name: "Ouaga Sound Archive", amira_url: url(302) }],
    as_member: [], contributed_item_count: 1,
    contributed_items: [{ role: "Recordist", ...itemRef(504, "Ouagadougou Street Recording", "Sound", "2021") }],
    publication_count: 0, publications: [], collaborator_count: 1,
    top_collaborators: [{ name: "Test Research Group", shared_items: 1, shared_publications: 0, amira_url: url(201) }],
    amira_url: url(102),
  };
  assert.deepEqual(await call("get_person", { id: 102 }), expected);
  assert.deepEqual(await call("get_person", { id: "person:102" }), expected);
  for (const name of ["Kaboré, Awa", "Awa Kabore", "AWA KABORÉ"]) {
    assert.deepEqual(await call("get_person", { name }), { ...expected, query: name }, name);
  }
  assert.deepEqual(await errorOf("get_person", { id: 999999 }),
    { code: "not_found", message: "Unknown person id.", suggested_tool: "resolve_entity" });
  const fragment = await errorOf("get_person", { name: "Kab" });
  assert.equal(fragment.code, "not_found");
  assert.ok(fragment.available_values.includes("Kaboré, Awa (person:102)"), JSON.stringify(fragment.available_values));
});

test("get_podcast: detail, every id form, transcript windowing, media, generated-by, schedule status", async () => {
  const transcript = d.podcasts[0].transcript;
  const p530 = {
    id: "530", omeka_id: 530, title: "Fixture Conversations Episode 1", episode: 1, date: "2021-03-01", date_status: "published",
    duration: null, abstract: "Talking about research.", series: { title: "Cluster Conversations", amira_url: url(555) },
    people: [{ name: "Fendler, Ute", role: "Speaker" }], languages: ["English"], url: "https://example.org/podcast/1", media: [],
    has_transcript: true, transcript_length: transcript.length,
    transcript_hint: "Set include_transcript=true for the text (page long ones with transcript_offset / transcript_max_chars).",
    amira_url: url(530),
  };
  for (const id of [530, "530", "podcast:530"]) assert.deepEqual(await call("get_podcast", { id }), p530, String(id));

  const { transcript_hint: _hint, ...withoutHint } = p530;
  assert.deepEqual(await call("get_podcast", { id: 530, include_transcript: true }), {
    ...withoutHint, transcript, transcript_offset: 0, transcript_returned_chars: transcript.length,
  });
  const window = await call("get_podcast", { id: 530, include_transcript: true, transcript_offset: 50, transcript_max_chars: 20 });
  assert.deepEqual([window.transcript, window.transcript_offset, window.transcript_returned_chars, window.transcript_truncated],
    [transcript.slice(50, 70), 50, 20, true]);
  const past = await call("get_podcast", { id: 530, include_transcript: true, transcript_offset: 10_000 });
  assert.deepEqual([past.transcript, past.transcript_returned_chars, past.transcript_truncated], ["", 0, undefined]);

  assert.deepEqual(await call("get_podcast", { id: "podcast:531" }), {
    id: "531", omeka_id: 531, title: "Fixture Conversations Episode 2", episode: 2, date: "2099-01-01", date_status: "scheduled",
    duration: "PT42M", abstract: "A scheduled episode.", series: { title: "Cluster Conversations", amira_url: url(555) },
    people: [{ name: "Kaboré, Awa", role: "Host", affiliation_at_time: "Université Joseph Ki-Zerbo" }], languages: ["French"],
    url: "https://example.org/podcast/2", media: [{ type: "audio/mpeg", url: "https://example.org/ep2.mp3", size: 4096 }],
    iiif_manifest: `${SITE}/iiif/3/531/manifest`,
    transcript_generated_by: { name: "Whisper large-v3", amira_url: url(777) },
    has_transcript: true, transcript_length: 26,
    transcript_hint: "Set include_transcript=true for the text (page long ones with transcript_offset / transcript_max_chars).",
    amira_url: url(531),
  });
  for (const id of [999999, "video:540", "podcast:abc"]) {
    const error = await errorOf("get_podcast", { id });
    assert.deepEqual([error.code, error.suggested_tool], ["not_found", "search_podcasts"], String(id));
  }
});

// --- fetch: every record kind -------------------------------------------------------------

test("fetch: research items, under both id vocabularies", async () => {
  const expected = {
    title: "Yoruba Architecture Study",
    text: [
      "Title: Yoruba Architecture Study", `AMIRA record: ${url(500)}`, "Type: Image", "University: University of Bayreuth",
      "Project: Fixture Art Worlds", "Contributors: Beier, Ulli (Author)", "Date: 2013", "Subjects: Architecture; Islam",
      "Places: Lagos (Nigeria)", "Languages: French", "Formats: photograph", "Sponsors: DFG", "Provenance: Iwalewahaus",
      "\nDescription:\nWall painting studies from Lagos.",
    ].join("\n"),
    url: url(500),
    metadata: { kind: "research_item", omeka_id: 500, amira_url: url(500), type: "Image", date: "2013", university: "University of Bayreuth",
      project_omeka_id: 300, subjects: ["Architecture", "Islam"], places: ["Lagos"], has_media: true },
  };
  for (const id of ["item:500", "research_item:500", "item:abg-fx-0500"]) {
    assert.deepEqual(await call("fetch", { id }), { id, ...expected }, id);
  }
  const capped = await call("fetch", { id: "item:500", max_chars: 50 });
  assert.equal(capped.text, expected.text.slice(0, 50));
  assert.equal(capped.metadata.truncated, true);
});

test("fetch: publications, with full-text opt-in and offset windowing", async () => {
  const fulltext = d.publications[0].fulltext;
  const meta = { kind: "publication", omeka_id: 510, amira_url: url(510), type: "article", year: 2024, authors: ["Fendler, Ute"],
    venue: "Society", venue_amira_url: url(520), doi: "https://doi.org/10.1000/fix510", publication_url: "https://doi.org/10.1000/fix510",
    repository_urls: ["https://epub.uni-bayreuth.de/id/eprint/510/"], has_fulltext: true };
  const head = ["Title: Decolonial Architecture Futures", `AMIRA record: ${url(510)}`, "Type: article", "Authors: Fendler, Ute",
    "Venue: Society", "Year: 2024", "Vol. 61, pp. 1-10", "DOI: https://doi.org/10.1000/fix510", "Status: Peer reviewed",
    "\nAbstract:\nOn architecture and decolonial thought."].join("\n");
  for (const id of ["pub:510", "publication:510", "pub:eref-510"]) {
    const doc = await call("fetch", { id });
    assert.deepEqual(doc, {
      id, title: "Decolonial Architecture Futures", url: url(510),
      text: `${head}\n[Full text omitted (${fulltext.length} chars) — call fetch again with include_fulltext=true to append it (page long ones with fulltext_offset / fulltext_max_chars).]`,
      metadata: { ...meta, fulltext_included: false, fulltext_length: fulltext.length,
        fulltext_hint: "Set include_fulltext=true to append the full text (page long ones with fulltext_offset / fulltext_max_chars)." },
    }, id);
  }
  const page = await call("fetch", { id: "pub:510", include_fulltext: true, fulltext_offset: 7, fulltext_max_chars: 100 });
  assert.equal(page.text, `${head}\nFull text:\n${fulltext.slice(7, 107)}`);
  assert.deepEqual(page.metadata, { ...meta, fulltext_included: true, fulltext_length: fulltext.length, fulltext_offset: 7,
    fulltext_returned_chars: 100, fulltext_truncated: true });

  const bare = await call("fetch", { id: "pub:511", include_fulltext: true });
  assert.deepEqual(bare.metadata, { kind: "publication", omeka_id: 511, amira_url: url(511), type: "working_paper", year: 2020,
    authors: ["Beier, Ulli"], venue: "Working Papers Series", publication_url: "https://eref.uni-bayreuth.de/id/eprint/511/",
    repository_urls: ["https://eref.uni-bayreuth.de/id/eprint/511/"], has_fulltext: false, fulltext_included: false, fulltext_length: 0 });
  assert.doesNotMatch(bare.text, /Full text/);
});

test("fetch: videos and podcasts, with transcript opt-in and windowing", async () => {
  const vt = d.videos[0].transcript;
  const video = await call("fetch", { id: "video:540", include_transcript: true });
  assert.equal(video.text, [`Title: A Fixture Lecture`, `AMIRA record: ${url(540)}`, "Date: 2023-11-02", "Speakers: Beier, Ulli",
    "Playlists: Lectures", "Watch: https://www.youtube.com/watch?v=fixture540", "\nDescription:\nA lecture recording.",
    `Transcript:\n${vt}`].join("\n"));
  assert.deepEqual(video.metadata, { kind: "youtube_video", omeka_id: 540, amira_url: url(540), date: "2023-11-02",
    date_status: "published", playlists: ["Lectures"], speakers: ["Beier, Ulli"], watch_url: "https://www.youtube.com/watch?v=fixture540",
    has_transcript: true, transcript_included: true, transcript_length: vt.length, transcript_offset: 0, transcript_returned_chars: vt.length });
  const noTranscript = await call("fetch", { id: "video:541", include_transcript: true });
  assert.deepEqual(noTranscript.metadata, { kind: "youtube_video", omeka_id: 541, amira_url: url(541), date: "2022-01-01",
    date_status: "published", watch_url: "https://www.youtube.com/watch?v=fixture541", has_transcript: false,
    transcript_included: false, transcript_length: 0 });

  const pt = d.podcasts[0].transcript;
  const podcast = await call("fetch", { id: "podcast:530" });
  assert.deepEqual(podcast.metadata, { kind: "podcast", omeka_id: 530, amira_url: url(530), series: "Cluster Conversations", episode: 1,
    date: "2021-03-01", date_status: "published", listen_url: "https://example.org/podcast/1", has_transcript: true,
    transcript_included: false, transcript_length: pt.length,
    transcript_hint: "Set include_transcript=true to append the transcript (page long ones with transcript_offset / transcript_max_chars)." });
  assert.match(podcast.text, /^Title: Fixture Conversations Episode 1\nAMIRA record: .+\nSeries: Cluster Conversations\nEpisode: 1\nDate: 2021-03-01\nPeople: Fendler, Ute \(Speaker\)\nListen: https:\/\/example.org\/podcast\/1\n\nDescription:\nTalking about research.\n\[Transcript omitted/);
  const window = await call("fetch", { id: "podcast:530", include_transcript: true, transcript_offset: 10, transcript_max_chars: 30 });
  assert.ok(window.text.endsWith(`\nTranscript:\n${pt.slice(10, 40)}`));
  assert.deepEqual([window.metadata.transcript_offset, window.metadata.transcript_returned_chars, window.metadata.transcript_truncated],
    [10, 30, true]);
  assert.equal((await call("fetch", { id: "podcast:531" })).metadata.date_status, "scheduled");
});

test("fetch: projects and research sections", async () => {
  for (const id of ["project:300", "project:UBT_Fixture2019"]) {
    assert.deepEqual(await call("fetch", { id }), {
      id, title: "Fixture Art Worlds", url: url(300),
      text: ["Project: Fixture Art Worlds", `AMIRA record: ${url(300)}`, "University: University of Bayreuth",
        "Research sections: Arts & Aesthetics", "Principal investigators: Beier, Ulli", "Members: Fendler, Ute",
        "Funded by: University of Bayreuth", "Dates: 2019-06-01 – 2022-05-31", "Digitised items: 2",
        "\nDescription:\nA fixture project about art worlds."].join("\n"),
      metadata: { kind: "project", omeka_id: 300, amira_url: url(300), university: "University of Bayreuth",
        research_sections: ["Arts & Aesthetics"], item_count: 2 },
    }, id);
  }
  for (const id of ["section:400", "research_section:400"]) {
    assert.deepEqual(await call("fetch", { id }), {
      id, title: "Arts & Aesthetics", url: url(400),
      text: ["Research section: Arts & Aesthetics", `AMIRA record: ${url(400)}`, "Dates: 2019 – 2025",
        "Principal investigators: Beier, Ulli", "\nDescription:\nFixture section on arts."].join("\n"),
      metadata: { kind: "research_section", omeka_id: 400, amira_url: url(400), dates: { start: "2019", end: "2025" } },
    }, id);
  }
  assert.match((await call("fetch", { id: "section:402" })).text, /\nSpokesperson: Kaboré, Awa\n/);
});

test("fetch: unknown ids and kinds fetch cannot render are text-only not_found errors", async () => {
  for (const id of ["item:999999", "pub:999999", "video:1", "podcast:1", "project:1", "section:1", "section:abc",
    "person:100", "subject:600", "500", "nonsense"]) {
    assert.deepEqual(await errorOf("fetch", { id }),
      { code: "not_found", message: `No record with id '${id}'.`, suggested_tool: "search" }, id);
  }
});

// --- exposure levels ------------------------------------------------------------------------

/** The structured-only tools this file covers, each with valid arguments. */
const STRUCTURED_ONLY = [
  ["list_institutions", {}], ["get_institution", { name: "UBT" }], ["list_cluster_partners", {}], ["list_groups", {}],
  ["search_projects", {}], ["get_project", { id: 300 }], ["list_research_sections", {}], ["get_research_section", { id: 400 }],
  ["search_persons", {}], ["get_person", { id: 100 }], ["list_collections", {}],
  ["list_categories", { category: "languages" }], ["list_categories", { category: "genres" }],
];

for (const level of ["minimal", "descriptive", "structured"]) {
  test(`exposure=${level}: structured-only tools ${level === "structured" ? "answer" : "refuse with exposure_restricted"}`, async () => {
    process.env.AMIRA_EXPOSURE = level;
    try {
      for (const [name, args] of STRUCTURED_ONLY) {
        if (level === "structured") {
          const result = await raw(name, args);
          assert.equal(result.isError, undefined, `${name} must answer at structured`);
          continue;
        }
        const error = await errorOf(name, args);
        assert.equal(error.code, "exposure_restricted", name);
        assert.match(error.message, new RegExp(`AMIRA_EXPOSURE=${level}\\b.*'structured'`), name);
      }
      // Resource types are minimal-level metadata: always available.
      assert.equal((await call("list_categories", { category: "resource_types" })).total_matches, 3);
    } finally {
      delete process.env.AMIRA_EXPOSURE;
    }
  });
}

test("exposure: get_podcast and fetch strip what each level hides", async () => {
  try {
    process.env.AMIRA_EXPOSURE = "minimal";
    const pod = await call("get_podcast", { id: 530 });
    assert.equal(pod.abstract, null);
    assert.ok(!("series" in pod) && !("people" in pod) && !("languages" in pod));
    assert.deepEqual([pod.has_transcript, pod.transcript_access, pod.transcript_hint], [true, "disabled", undefined]);
    assert.equal((await errorOf("get_podcast", { id: 530, include_transcript: true })).code, "text_access_disabled");
    const item = await call("fetch", { id: "item:500" });
    assert.equal(item.text, ["Title: Yoruba Architecture Study", `AMIRA record: ${url(500)}`, "Type: Image", "Date: 2013"].join("\n"));
    assert.deepEqual(item.metadata, { kind: "research_item", omeka_id: 500, amira_url: url(500), type: "Image", date: "2013", has_media: true });

    process.env.AMIRA_EXPOSURE = "descriptive";
    const described = await call("fetch", { id: "item:500" });
    assert.match(described.text, /\n\nDescription:\nWall painting studies from Lagos\.$/);
    assert.doesNotMatch(described.text, /Subjects:|Project:|Contributors:/);
    assert.equal((await call("get_podcast", { id: 530 })).abstract, "Talking about research.");
    assert.equal((await call("fetch", { id: "section:400" })).text.includes("Principal investigators"), false);

    process.env.AMIRA_EXPOSURE = "structured";
    const pub = await call("fetch", { id: "pub:510", include_fulltext: true });
    const length = d.publications[0].fulltext.length;
    assert.ok(pub.text.endsWith(`\n[Full text exists (${length} chars) but access is disabled by the server's exposure policy.]`));
    assert.deepEqual([pub.metadata.fulltext_included, pub.metadata.fulltext_access, pub.metadata.authors],
      [false, "disabled", ["Fendler, Ute"]]);
    const video = await call("fetch", { id: "video:540", include_transcript: true });
    assert.equal(video.metadata.transcript_access, "disabled");
    assert.ok(!video.text.includes("planetary-token"), "no transcript text leaks into the body");
    const structuredPod = await call("get_podcast", { id: 531 });
    assert.deepEqual([structuredPod.series.title, structuredPod.transcript_access], ["Cluster Conversations", "disabled"]);
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});

// --- cross-tool contracts ---------------------------------------------------------------------

test("every list row and detail carries a string id and its numeric omeka_id", async () => {
  const lists = [
    ["search_research_items", {}], ["search_projects", {}], ["list_research_sections", {}], ["search_persons", {}],
    ["list_institutions", {}], ["list_groups", {}], ["list_collections", {}], ["search_publications", {}],
    ["search_podcasts", {}], ["search_videos", {}], ["list_subjects", {}], ["list_journals", {}], ["resolve_entity", { query: "Fixture" }],
  ];
  for (const [name, args] of lists) {
    const page = await call(name, args);
    assert.ok(page.results.length > 0, name);
    for (const row of page.results) {
      assert.equal(typeof row.omeka_id, "number", `${name}: ${JSON.stringify(row)}`);
      if (name === "resolve_entity") assert.match(row.id, new RegExp(`:${row.omeka_id}$`), name);
      else assert.equal(row.id, String(row.omeka_id), `${name}: ${JSON.stringify(row)}`);
    }
  }
  // list_locations rows carry the pair whenever the place is an authority.
  for (const row of (await call("list_locations")).results) assert.equal(row.id, String(row.omeka_id));
  const details = [
    ["get_research_item", { id: 500 }], ["get_project", { id: 302 }], ["get_research_section", { id: 402 }],
    ["get_person", { id: 102 }], ["get_institution", { id: 201 }], ["get_publication", { id: 510 }],
    ["get_podcast", { id: 531 }], ["get_video", { id: 541 }],
  ];
  for (const [name, args] of details) {
    const detail = await call(name, args);
    assert.equal(detail.id, String(detail.omeka_id), name);
    assert.equal(detail.omeka_id, Number(args.id), name);
  }
});

test("limits above a research tool's maximum are clamped and echoed", async () => {
  const resolved = await call("resolve_entity", { query: "a", limit: 100 });
  assert.deepEqual([resolved.requested_limit, resolved.effective_limit], [100, 50]);
  const passages = await call("get_text_passages", { ids: ["pub:510"], keyword: "zanzibar-fulltext-token", limit: 100 });
  assert.deepEqual([passages.requested_limit, passages.effective_limit, passages.count], [100, 20, 20]);
  assert.equal(passages.total_matches, 30);
  assert.equal(passages.next_offset, 20);
  const graph = await call("get_entity_graph", { seed: "person:100" });
  const edge = graph.edges[0];
  const evidence = await call("get_entity_graph", { seed: graph.seed, edge_id: edge.id, snapshot_id: graph.snapshot_id, limit: 99 });
  assert.deepEqual([evidence.requested_limit, evidence.effective_limit], [99, 50]);
  assert.equal(evidence.total_matches, edge.evidence_total);
});

test("the OpenAI search tool echoes a clamped limit like every other tool",
  // Fixed in 1.19: the clamp is echoed, and the output schema allows the two fields.
  async () => {
    const page = await call("search", { query: "fixture", limit: 100 });
    assert.deepEqual([page.requested_limit, page.effective_limit], [100, 50]);
  });
