// Exact assertions for institutions, facets, projects, sections, people and podcasts. The extended fixture and the
// helpers come from test/helpers/coverage-harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {
  lib, d, KNOWLEDGES_DESCRIPTION, call, raw, url, SITE, errorOf, omekaIds, itemRef, ref, AMRC,
} from "../helpers/coverage-harness.mjs";

// --- institutions and groups ---------------------------------------------------

const UBT = {
  id: "200", omeka_id: 200, name: "University of Bayreuth", name_variants: ["UBT"], kind: "institution",
  part_of: [{ id: "37685", omeka_id: 37685, name: "Africa Multiple Research Centres", amira_url: url(37685) }],
  partner_categories: [AMRC], latitude: 49.94, longitude: 11.58, wikidata: null, identifiers: [],
  project_count: 1, projects: [{ id: "300", omeka_id: 300, name: "Fixture Art Worlds", amira_url: url(300) }],
  affiliated_person_count: 1, affiliated_persons: ["Beier, Ulli"], affiliated_person_refs: [ref("Beier, Ulli", 100)],
  contributed_item_count: 0, contributed_items: [], amira_url: url(200),
};
const UJKZ = {
  id: "202", omeka_id: 202, name: "Université Joseph Ki-Zerbo", name_variants: ["UJKZ"], kind: "institution",
  part_of: [], partner_categories: [AMRC], latitude: 12.37, longitude: -1.5,
  wikidata: "http://www.wikidata.org/entity/Q3551690",
  identifiers: [{ scheme: "ror", id: "00t5e2y66", url: "https://ror.org/00t5e2y66" }],
  project_count: 1, projects: [{ id: "302", omeka_id: 302, name: "Ouaga Sound Archive", amira_url: url(302) }],
  affiliated_person_count: 1, affiliated_persons: ["Kaboré, Awa"], affiliated_person_refs: [ref("Kaboré, Awa", 102)],
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
  // Whole words of one name resolve, as list_institutions finds them ("LACC" in
  // "University of Lagos African Cluster Centre (LACC)" used to be not_found).
  for (const [name, oId] of [["Ki-Zerbo", 202], ["joseph ki zerbo", 202], ["Bayreuth", 200]]) {
    assert.equal((await call("get_institution", { name })).omeka_id, oId, name);
  }
});

test("get_institution: partner category from an isPartOf link; groups get item credits, no categories", async () => {
  assert.deepEqual(await call("get_institution", { name: "CEAO" }), {
    id: "203", omeka_id: 203, name: "Center for Afro-Oriental Studies", name_variants: ["CEAO"], kind: "institution",
    part_of: [{ id: "39073", omeka_id: 39073, name: "Privileged partner", amira_url: url(39073) }],
    partner_categories: [{ key: "privileged", name: "Privileged partner", omeka_id: 39073, amira_url: url(39073) }],
    wikidata: null, identifiers: [], project_count: 0, projects: [], affiliated_person_count: 0, affiliated_persons: [],
    affiliated_person_refs: [], contributed_item_count: 0, contributed_items: [], amira_url: url(203),
  });
  assert.deepEqual(await call("get_institution", { id: "group:201" }), {
    id: "201", omeka_id: 201, name: "Test Research Group", kind: "group", part_of: [], partner_categories: [],
    wikidata: null, identifiers: [], project_count: 0, projects: [], affiliated_person_count: 0, affiliated_persons: [],
    affiliated_person_refs: [],
    contributed_item_count: 1, contributed_items: [itemRef(504, "Ouagadougou Street Recording", "Sound", "2021")],
    amira_url: url(201),
  });
});

test("get_institution: not_found and missing_entity are text-only errors", async () => {
  for (const args of [{ name: "Nowhere University" }, { id: 999999 }, { id: "organisation:abc" }]) {
    const error = await errorOf("get_institution", args);
    assert.equal(error.code, "not_found", JSON.stringify(args));
    assert.equal(error.suggested_tool, "list_institutions");
  }
  // A typed id of another kind names the tool that reads it.
  const wrongKind = await errorOf("get_institution", { id: "person:100" });
  assert.deepEqual([wrongKind.code, wrongKind.suggested_tool], ["not_found", "get_person"]);
  assert.equal(wrongKind.message, "'person:100' is a person id, not an institution id.");
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

test("list_collections: one row per project, cited by the project page, with its item sets (#18)", async () => {
  const row = (id, collection, count, project, projectId, sets) => ({ collection, item_count: count, id: String(id), omeka_id: id,
    ...(project !== collection ? { project } : {}), project_id: projectId, item_sets: sets.map(([setId, code]) => ({ id: setId, code })),
    iiif_collection: sets.length ? `${SITE}/iiif/3/collection/${sets[0][0]}` : null, amira_url: url(id) });
  // Item 504 sits in sets 800, 801 and 899 but belongs to project 302 only;
  // set 899 is missing from the snapshot and no longer shows as "Collection 899".
  const art = row(300, "Fixture Collection", 2, "Fixture Art Worlds", "UBT_Fixture2019", [[800, null]]);
  const music = row(301, "Fixture Music Library", 1, "Fixture Music Library", "Ext_FixtureMusic", []);
  const sound = row(302, "Sound Collection", 1, "Ouaga Sound Archive", "UJKZ_Sound2021", [[801, "UJKZ_Sound2021"]]);
  assert.deepEqual(await call("list_collections"), {
    distinct_collections: 3, count: 3, total_matches: 3, offset: 0, has_more: false, results: [art, music, sound],
  });
  for (const keyword of ["sound", "Ouaga", "ujkz_sound"]) {
    assert.deepEqual(await call("list_collections", { keyword }), {
      distinct_collections: 1, filters: { keyword }, count: 1, total_matches: 1, offset: 0, has_more: false, results: [sound],
    }, keyword);
  }
  const paged = await call("list_collections", { limit: 1, offset: 1 });
  assert.deepEqual([omekaIds(paged), paged.next_offset], [[301], 2]);

  // Every collection key resolves to the same project-scoped records.
  for (const collection of ["801", "302", "UJKZ_Sound2021", "collection:801", "project:302", "Sound Coll", "Ouaga Sound"]) {
    assert.deepEqual(omekaIds(await call("search_research_items", { collection })), [504], collection);
  }
  assert.deepEqual(omekaIds(await call("search_research_items", { collection: "800" })), [500, 501]);
  const cohorts = await call("compare_collections", { cohorts: [{ type: "collection", id: "UJKZ_Sound2021" }, { type: "collection", id: "800" }] });
  assert.deepEqual(cohorts.cohorts.map((c) => [c.id, c.name, c.amira_url, c.total_items]),
    [[302, "Sound Collection", url(302), 1], [300, "Fixture Collection", url(300), 2]]);
  assert.deepEqual((await call("get_research_item", { id: "504" })).collections,
    [{ title: "Sound Collection", ...Object.fromEntries(Object.entries(sound).filter(([k]) => !["collection", "item_count"].includes(k))) }]);
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
    principal_investigator_refs: [ref("Beier, Ulli", 100)], member_refs: [ref("Fendler, Ute", 101)],
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
    members: ["Beier, Ulli"], principal_investigator_refs: [ref("Kaboré, Awa", 102)], member_refs: [ref("Beier, Ulli", 100)],
    funded_by: ["Université Joseph Ki-Zerbo"], description: "Urban soundscapes of Ouagadougou.",
    date: { start: "2021-01-01", end: null }, website: "https://example.org/osa", item_count: 1, items_with_media: 1,
    items_by_resource_type: { Sound: 1 }, top_subjects: [{ subject: "Music", item_count: 1 }],
    sample_items: [itemRef(504, "Ouagadougou Street Recording", "Sound", "2021")], amira_url: url(302),
  });
  for (const id of [999999, "project:999"]) {
    const error = await errorOf("get_project", { id });
    assert.deepEqual([error.code, error.suggested_tool], ["not_found", "search_projects"], String(id));
  }
  const wrongKind = await errorOf("get_project", { id: "pub:510" });
  assert.deepEqual([wrongKind.code, wrongKind.suggested_tool], ["not_found", "get_publication"]);
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
  description: "Fixture section on arts.", principal_investigators: ["Beier, Ulli"], members: [],
  principal_investigator_refs: [ref("Beier, Ulli", 100)], member_refs: [], spokesperson: null, website: null,
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
    description: KNOWLEDGES_DESCRIPTION, principal_investigators: [], members: ["Kaboré, Awa"],
    principal_investigator_refs: [], member_refs: [ref("Kaboré, Awa", 102)], spokesperson: "Kaboré, Awa",
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
    coverage_note: "Counts describe the records AMIRA holds, not the person's full work; present the profile as a summary of " +
      "these records. Publications come from University of Bayreuth repositories (EPub, ERef), and only works from " +
      "2019 on filed under the Cluster (its repository division or the EXC 2052 grant) are harvested: a Bayreuth " +
      "researcher's other publications are absent, and a partner-centre researcher's appear only if deposited " +
      "there. A count of zero is not evidence that none exist.",
    as_principal_investigator: [{ id: "302", omeka_id: 302, name: "Ouaga Sound Archive", amira_url: url(302) }],
    as_member: [], as_section_principal_investigator: [],
    as_section_member: [{ id: "402", omeka_id: 402, name: "Knowledges", funding_phase: "AM 2.0 (2026–2032)", amira_url: url(402) }],
    contributed_item_count: 1,
    contributed_items: [{ role: "Recordist", ...itemRef(504, "Ouagadougou Street Recording", "Sound", "2021") }],
    publication_count: 0, publications: [],
    podcast_count: 1,
    podcasts: [{ role: "Host", id: "531", omeka_id: 531, title: "Fixture Conversations Episode 2", date: "2099-01-01", amira_url: url(531) }],
    video_count: 1,
    videos: [{ role: "Speaker", id: "542", omeka_id: 542, title: "Round Table on Sound", date: "2024-05-01", amira_url: url(542) }],
    collaborators_note: "People credited with this person on the same records, not a measure of collaboration. " +
      "shared_authorships and shared_editorships count co-written and co-edited works (a volume once); " +
      "shared_recordings counts joint podcast or video appearances; works with more than 10 authors are left out. " +
      "Report them as shared credits.",
    // Test Research Group, credited on item 504 too, is a group, not a collaborator.
    collaborator_count: 2,
    top_collaborators: [
      { name: "Diallo, Mariam", shared_items: 0, shared_publications: 0, shared_authorships: 0, shared_editorships: 0,
        shared_recordings: 1, amira_url: null },
      { name: "Fendler, Ute", shared_items: 0, shared_publications: 0, shared_authorships: 0, shared_editorships: 0,
        shared_recordings: 1, amira_url: url(101) },
    ],
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

test("get_person: research-section roles are reported apart from project roles", async () => {
  // Beier leads section 400 and project 300; section roles never leak into the project lists.
  const beier = await call("get_person", { id: 100 });
  assert.deepEqual(beier.as_section_principal_investigator,
    [{ id: "400", omeka_id: 400, name: "Arts & Aesthetics", funding_phase: "AM 1.0 (2019–2025)", amira_url: url(400) }]);
  assert.deepEqual(beier.as_section_member, []);
  assert.deepEqual(beier.as_principal_investigator.map((p) => p.omeka_id), [300]);
  assert.deepEqual(beier.as_member.map((p) => p.omeka_id), [302]);
  // Fendler is credited on a project only.
  const fendler = await call("get_person", { id: 101 });
  assert.deepEqual([fendler.as_section_principal_investigator, fendler.as_section_member], [[], []]);
});

test("get_person: podcast and video appearances, by id or by name alone", async () => {
  const beier = await call("get_person", { id: 100 });
  assert.deepEqual([beier.podcast_count, beier.podcasts], [0, []]);
  assert.deepEqual(beier.videos,
    [{ role: "Speaker", id: "540", omeka_id: 540, title: "A Fixture Lecture", date: "2023-11-02", amira_url: url(540) }]);
  const fendler = await call("get_person", { id: 101 });
  assert.deepEqual([fendler.podcasts.map((p) => p.omeka_id), fendler.videos.map((v) => v.omeka_id)], [[530], [542]]);
  // Credited only as a video speaker, with no authority record: still a person.
  const diallo = await call("get_person", { name: "Mariam Diallo" });
  assert.deepEqual([diallo.name, diallo.found_in_authority_list, diallo.amira_url], ["Diallo, Mariam", false, null]);
  assert.deepEqual(diallo.videos.map((v) => v.omeka_id), [542]);
  assert.deepEqual(diallo.top_collaborators.map((c) => [c.name, c.shared_recordings]), [["Fendler, Ute", 1], ["Kaboré, Awa", 1]]);
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
  for (const id of [999999, "podcast:abc"]) {
    const error = await errorOf("get_podcast", { id });
    assert.deepEqual([error.code, error.suggested_tool], ["not_found", "search_podcasts"], String(id));
  }
  const wrongKind = await errorOf("get_podcast", { id: "video:540" });
  assert.deepEqual([wrongKind.code, wrongKind.suggested_tool], ["not_found", "get_video"]);
});
