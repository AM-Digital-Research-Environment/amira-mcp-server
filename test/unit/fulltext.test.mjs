// DRE Visualizations' ILAM full-text map (src/fulltextMaps.ts): validation of
// the two public files, the snapshot round trip, and every surface that serves
// them — get_research_item, find_related (research_item), the shared
// `mentions_country` filter and get_fulltext_map.
//
// The shared fixture is extended HERE, in this process only: an "ILAM" item
// set (27724) with five articles (520–524). The map lists 520–523, plus 999
// (absent from the snapshot) and 500 (present, but not an ILAM item), which
// every surface must filter out; 524 is an ILAM article that is not on the map.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const ILAM = 27724;
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
d.item_sets.push({ o_id: ILAM, title: "ILAM" });
const articles = [
  [520, "Mbira tunings in Zimbabwe", 1962],
  [521, "Kalimba and mbira names", 1975],
  [522, "Church hymns in Tanganyika", 1958],
  [523, "Highlife in Accra", 2015],
  [524, "Backmatter", 1968],
];
for (const [o_id, title, year] of articles) {
  d.research_items.push({
    ...structuredClone(d.research_items[1]),
    o_id, dre_id: `ilam-${o_id}`, title, alt_titles: [], item_sets: [ILAM], places: [], subjects: [{ label: "Music", o_id: 603 }],
    dates: { created: `${year}-01-01` }, year_min: year, year_max: year,
  });
}
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));

const PRIVATE_TEXT = "a sentence of private article text that must never be stored";
function mapFile() {
  return {
    schemaVersion: 1,
    itemSetId: ILAM,
    generatedAt: "2026-11-04T06:10:11Z",
    model: { name: "google/embeddinggemma-2", revision: "914f7f8", taskPrefix: "task: sentence similarity | query: " },
    counts: { items: 5, withText: 5, shown: 4, excluded: { furniture: 1, short: 1 }, passages: 20 },
    groups: [{ id: 1, size: 2, label: "Mbira and lamellophones" }, { id: 2, size: 1, label: "Church music" }, { id: 3, size: 1, label: "Empty here" }],
    // 999 is absent from the snapshot and 500 is not an ILAM item: both are filtered out.
    items: [[520, 0.1, 0.2, 1], [521, 0.3, 0.4, 1], [522, 0.5, 0.6, 2], [523, 0.7, 0.8, 0], [999, 0, 0, 3], [500, 0, 0, 2]],
    neighbours: {
      520: [[521, 0.9612], [999, 0.95], [522, 0.9301], [500, 0.92]],
      521: [[520, 0.9612], [523, 0.9]],
      522: [[520, 0.9301]],
      523: [[521, 0.9]],
    },
    places: {
      minMentions: 3,
      items: { 520: [["Zimbabwe", 12], ["Mozambique", 3]], 522: [["United Republic of Tanzania", 5]], 523: [["Ghana", 4]], 999: [["Mali", 9]] },
    },
    labels: { by: "Claude Opus 5.5 (Anthropic)", from: "the titles of each group's articles", date: "2026-11-04" },
    passages: [PRIVATE_TEXT], // an unexpected field: validation must drop it
  };
}
function wordsFile() {
  return {
    schemaVersion: 1, itemSetId: ILAM, generatedAt: "2026-11-04T06:10:11Z", minArticles: 10, articles: 4,
    years: [1958, 1962, 1975, 2015],
    totals: [20000, 40000, 30000, 3000],
    words: { mbira: [1, 40, 2, 15], "hip-hop": [3, 6], hymn: [0, 10, 3, 1] },
  };
}
const SOURCE = { repository: "AM-Digital-Research-Environment/DRE-Visualizations", tag: lib.FULLTEXT_SOURCE.tag,
  map: lib.FULLTEXT_SOURCE.map, words: lib.FULLTEXT_SOURCE.words };
const fulltext = lib.parseFulltextMaps({ source: SOURCE, map: mapFile(), words: wordsFile() });
await lib.writeSnapshot(dataDir, { ...fixture, fulltext });

const conn = await connectInMemory(lib, {}, { name: "fulltext" });
const { call } = conn;
test.after(async () => {
  delete process.env.AMIRA_EXPOSURE;
  await conn.close();
});
const url = (id) => lib.itemUrl(id);

// --- validation and the snapshot round trip ------------------------------------

test("validation keeps only the declared fields, so no text can reach the snapshot", async () => {
  assert.equal(fulltext.map.passages, undefined);
  assert.equal(fulltext.map.model.taskPrefix, undefined);
  const stored = await readFile(path.join(dataDir, "fulltext_maps.json"), "utf8");
  assert.ok(!stored.includes(PRIVATE_TEXT));
  const { manifest, fulltext: loaded } = await lib.loadSnapshot(dataDir);
  assert.deepEqual(manifest.fulltextMaps, { repository: SOURCE.repository, tag: SOURCE.tag, item_set: ILAM, generated_at: "2026-11-04T06:10:11Z", articles: 6 });
  assert.deepEqual(loaded, fulltext);
});

test("validation rejects malformed or inconsistent files", () => {
  const parse = (map, words) => () => lib.parseFulltextMaps({ source: SOURCE, map, words });
  const bad = (edit) => { const m = mapFile(); edit(m); return m; };
  const badWords = (edit) => { const w = wordsFile(); edit(w); return w; };
  assert.throws(parse(bad((m) => { m.schemaVersion = 2; }), wordsFile()));
  assert.throws(parse(bad((m) => { m.items[0] = [520, 0.1, 0.2]; }), wordsFile()));
  assert.throws(parse(bad((m) => { m.items.push([520, 0, 0, 1]); }), wordsFile()), /duplicate/);
  assert.throws(parse(bad((m) => { m.items[0][3] = 9; }), wordsFile()), /undeclared group/);
  assert.throws(parse(bad((m) => { m.neighbours["520"][0][1] = 1.5; }), wordsFile()));
  assert.throws(parse(mapFile(), badWords((w) => { w.itemSetId = 1; })), /different item sets/);
  assert.throws(parse(mapFile(), badWords((w) => { w.totals.pop(); })), /differ in length/);
  assert.throws(parse(mapFile(), badWords((w) => { w.words.mbira.push(1); })), /odd-length/);
  assert.throws(parse(mapFile(), badWords((w) => { w.words.mbira = [7, 1]; })), /missing year/);
  // Word keys are single word forms: a phrase would be a fragment of text.
  assert.throws(parse(mapFile(), badWords((w) => { w.words["the mbira is"] = [0, 1]; })));
});

test("a snapshot whose map file disagrees with its manifest does not load", async () => {
  const dir = tempDir("amira-fulltext-");
  await lib.writeSnapshot(dir, { ...fixture, fulltext });
  const manifestPath = path.join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, fulltextMaps: { ...manifest.fulltextMaps, tag: "v0.0.1" } }));
  await assert.rejects(lib.loadSnapshot(dir), /fulltext_maps\.json/);
});

test("a snapshot carrying an older pin is stale, one without a map is not", () => {
  const probe = { maxModified: fixture.manifest.maxModified, totalItems: fixture.manifest.totalItemsOnInstance };
  const base = { ...fixture.manifest, schemaVersion: lib.SNAPSHOT_SCHEMA_VERSION };
  assert.equal(lib.isStale(base, probe), false);
  assert.equal(lib.isStale({ ...base, fulltextMaps: { tag: lib.FULLTEXT_SOURCE.tag } }, probe), false);
  assert.equal(lib.isStale({ ...base, fulltextMaps: { tag: "v2.0.0" } }, probe), true);
});

// --- get_research_item ---------------------------------------------------------

test("get_research_item: closest articles, AI-labelled group and countries, filtered to the snapshot", async () => {
  const item = await call("get_research_item", { id: 520 });
  assert.deepEqual(item.closest_in_content, [
    { title: "Kalimba and mbira names", date: "1975", score: 0.9612, omeka_id: 521, amira_url: url(521) },
    { title: "Church hymns in Tanganyika", date: "1958", score: 0.9301, omeka_id: 522, amira_url: url(522) },
  ]);
  const map = item.full_text_map;
  assert.equal(map.on_map, true);
  assert.deepEqual(map.group, { id: 1, label: "Mbira and lamellophones", label_ai_generated: true, articles: 2 });
  assert.match(map.group_note, /AI-generated \(Claude Opus 5\.5/);
  assert.deepEqual(map.countries_named, [{ country: "Zimbabwe", mentions: 12 }, { country: "Mozambique", mentions: 3 }]);
  assert.match(map.countries_note, /at least 3 times/);
  assert.match(map.neighbours_note, /private and never served/);
  assert.equal(map.source.url, `https://github.com/${SOURCE.repository}/tree/${SOURCE.tag}`);

  const unclustered = (await call("get_research_item", { id: 523 })).full_text_map;
  assert.equal(unclustered.group, null);
  assert.match(unclustered.group_note, /unclustered/);
});

test("get_research_item: an ILAM article off the map says so; other items carry nothing", async () => {
  const off = await call("get_research_item", { id: 524 });
  assert.equal(off.closest_in_content, undefined);
  assert.equal(off.full_text_map.on_map, false);
  assert.match(off.full_text_map.note, /1 articles with full text excluded/);
  const other = await call("get_research_item", { id: 500 });
  assert.equal(other.full_text_map, undefined);
  assert.equal(other.closest_in_content, undefined);
});

test("get_research_item: the full-text fields are descriptive-level", async () => {
  process.env.AMIRA_EXPOSURE = "minimal";
  try {
    const item = await call("get_research_item", { id: 520 });
    assert.equal(item.full_text_map, undefined);
    assert.equal(item.closest_in_content, undefined);
  } finally { delete process.env.AMIRA_EXPOSURE; }
});

// --- find_related --------------------------------------------------------------

test("find_related research_item: the map neighbours are the matched items", async () => {
  const r = await call("find_related", { entity_type: "research_item", value: "research_item:520" });
  assert.equal(r.value, "520");
  assert.equal(r.seed_label, "Mbira tunings in Zimbabwe");
  assert.equal(r.amira_url, url(520));
  assert.equal(r.matched_items, 2);
  assert.deepEqual(r.closest_in_content.map((n) => [n.omeka_id, n.same_group ?? false]), [[521, true], [522, false]]);
  assert.equal(r.content_group.label_ai_generated, true);
  assert.match(r.content_group.note, /AI-generated/);
  assert.deepEqual(r.related_subjects.map((s) => [s.name, s.count]), [["Music", 2]]);
  for (const key of ["related_projects", "related_research_sections", "related_people", "related_countries", "related_formats"]) {
    assert.ok(Array.isArray(r[key]), key);
  }
});

test("find_related research_item: refusals name the reason", async () => {
  assert.equal((await call("find_related", { entity_type: "research_item", value: "500" })).error.code, "not_on_fulltext_map");
  const off = (await call("find_related", { entity_type: "research_item", value: "524" })).error;
  assert.equal(off.code, "not_on_fulltext_map");
  assert.match(off.message, /Backmatter/);
  assert.equal((await call("find_related", { entity_type: "research_item", value: "123456" })).error.code, "not_found");
});

// --- mentions_country ----------------------------------------------------------

test("mentions_country: aliases, per-row counts, suggestions and the shared selection", async () => {
  const page = await call("search_research_items", { mentions_country: "Tanzania" });
  assert.deepEqual(page.results.map((r) => [r.omeka_id, r.country_mentions]), [[522, { "United Republic of Tanzania": 5 }]]);
  assert.match(page.mentions_note, /gazetteer/);
  assert.equal((await call("search_research_items", { mentions_country: "Mali" })).total_matches, 0, "999 is not in the snapshot");
  const miss = await call("search_research_items", { mentions_country: "Zimbabwi" });
  assert.deepEqual(miss.did_you_mean, [{ filter: "mentions_country", values: ["Zimbabwe"] }]);
  const both = await call("search_research_items", { mentions_country: "Zimbabwe", year_to: 1970 });
  assert.deepEqual(both.results.map((r) => r.omeka_id), [520]);
  const years = await call("list_years", { filters: { mentions_country: "Ghana" } });
  assert.deepEqual(years.results.map((r) => [r.year, r.item_count]), [[2015, 1]]);
});

test("mentions_country is refused below the descriptive level", async () => {
  process.env.AMIRA_EXPOSURE = "minimal";
  try {
    assert.equal((await call("search_research_items", { mentions_country: "Ghana" })).error.code, "exposure_restricted");
    assert.equal((await call("get_fulltext_map", {})).error.code, "exposure_restricted");
    assert.equal((await call("find_related", { entity_type: "research_item", value: "520" })).error.code, "exposure_restricted");
  } finally { delete process.env.AMIRA_EXPOSURE; }
});

// --- get_fulltext_map ----------------------------------------------------------

test("get_fulltext_map overview: groups with members, AI-label caveat, countries and coverage", async () => {
  const o = await call("get_fulltext_map", {});
  assert.deepEqual(o.collection, { title: "ILAM", omeka_id: ILAM, amira_url: lib.itemUrl(ILAM).replace("/item/", "/item-set/") });
  assert.deepEqual(o.coverage, { articles: 5, with_full_text: 5, on_map: 4, not_on_map_with_full_text: 1, exclusion_reasons: { furniture: 1, short: 1 } });
  assert.deepEqual(o.groups.map((g) => [g.id, g.articles, g.label_ai_generated]), [[1, 2, true], [2, 1, true]], "group 3 has no article in the snapshot");
  assert.deepEqual(o.groups[0].sample, [{ title: "Mbira tunings in Zimbabwe", amira_url: url(520) }, { title: "Kalimba and mbira names", amira_url: url(521) }]);
  assert.equal(o.unclustered_articles, 1);
  assert.match(o.group_note, /AI-generated/);
  assert.deepEqual(o.countries_named.map((c) => [c.country, c.articles, c.mentions]),
    [["Ghana", 1, 4], ["Mozambique", 1, 3], ["United Republic of Tanzania", 1, 5], ["Zimbabwe", 1, 12]]);
  assert.match(o.privacy, /neither read nor quoted/);
});

test("get_fulltext_map group: members by year, each with its amira_url", async () => {
  const g = await call("get_fulltext_map", { group: 1 });
  assert.deepEqual(g.group, { id: 1, label: "Mbira and lamellophones", label_ai_generated: true, articles: 2 });
  assert.match(g.group_note, /AI-generated/);
  assert.deepEqual(g.results, [
    { title: "Mbira tunings in Zimbabwe", date: "1962", omeka_id: 520, amira_url: url(520) },
    { title: "Kalimba and mbira names", date: "1975", omeka_id: 521, amira_url: url(521) },
  ]);
  assert.equal((await call("get_fulltext_map", { group: 99 })).error.code, "not_found");
});

test("get_fulltext_map words: rates per 10,000 words, sparse years, near forms", async () => {
  const w = (await call("get_fulltext_map", { words: ["Mbira", "hiphop", "zz"] })).words;
  assert.deepEqual(w.counted, ["mbira"]);
  assert.deepEqual(w.not_counted, [{ word: "hiphop", similar: ["hip-hop"] }, { word: "zz" }]);
  assert.deepEqual(w.years.map((y) => [y.year, y.counts.mbira, y.per_10k.mbira, y.sparse ?? false]),
    [[1958, 0, 0, false], [1962, 40, 10, false], [1975, 15, 5, false], [2015, 0, 0, true]]);
  assert.deepEqual(w.totals.mbira, { count: 55, per_10k: 5.91 });
  assert.equal(w.min_articles, 10);
  assert.match(w.note, /at least 10 articles/);
  const ranged = (await call("get_fulltext_map", { words: ["hymn"], year_from: 1960, year_to: 2020 })).words;
  assert.deepEqual(ranged.years.map((y) => y.year), [1962, 1975, 2015]);
  assert.deepEqual(ranged.totals.hymn, { count: 1, per_10k: 0.14 });
  assert.equal((await call("get_fulltext_map", { words: ["mbira"], year_from: 2000, year_to: 1990 })).error.code, "invalid_range");
});

test("no surface returns more than the public derived numbers", async () => {
  const bodies = [
    await call("get_research_item", { id: 520 }),
    await call("find_related", { entity_type: "research_item", value: "520" }),
    await call("get_fulltext_map", {}),
    await call("get_fulltext_map", { words: ["mbira"] }),
  ];
  for (const body of bodies) assert.ok(!JSON.stringify(body).includes(PRIVATE_TEXT));
});
