// Unit tests for the Omeka JSON-LD transform — every value type the API emits
// (literal, resource:item, uri, numeric:timestamp, numeric:interval,
// customvocab) and every record type the snapshot carries. Runs offline against
// the built library: `npm run build` first (npm test does).
import test from "node:test";
import assert from "node:assert/strict";
import {
  LanguageIndex,
  maxModified,
  nameMatchesQuery,
  samePerson,
  transformItemSet,
  transformLanguage,
  transformLocation,
  transformOrganisation,
  transformPerson,
  transformPodcast,
  transformProject,
  transformPublication,
  transformResearchItem,
  transformSection,
  transformVideo,
  uniFromDreId,
  itemUrl,
} from "../../server/lib.js";

/** Minimal TransformContext for tests. */
const ctx = {
  roleLabel: (term) => ({ "marcrel:aut": "author", "marcrel:spk": "speaker", "marcrel:ivr": "interviewer" })[term] ?? null,
  classTerm: (id) => ({ 297: "fabio:JournalArticle", 220: "fabio:BookChapter", 444: "fabio:WorkingPaper" })[id] ?? null,
};

const lit = (v) => ({ type: "literal", "@value": v });
const res = (id, label) => ({ type: "resource:item", value_resource_id: id, display_title: label });
const uri = (href, label) => ({ type: "uri", "@id": href, ...(label ? { "o:label": label } : {}) });
const ts = (v) => ({ type: "numeric:timestamp", "@value": v });
const interval = (v) => ({ type: "numeric:interval", "@value": v });
const vocab = (id, label) => ({ type: "customvocab:3", value_resource_id: id, display_title: label });

test("research item: every value type lands in the right field", () => {
  const item = {
    "o:id": 7392,
    "o:title": "Volume 8: Yoruba Architecture",
    "o:media": [{ "o:id": 1 }],
    "dre:id": [lit("abg-99-0000")],
    "dcterms:title": [lit("Volume 8: Yoruba Architecture")],
    "fabio:hasTranslatedTitle": [lit("Band 8")],
    "dcterms:type": [res(10, "Image")],
    "dcterms:isPartOf": [res(1790, "Of Art Worlds")],
    "dcterms:subject": [res(2390, "Yoruba (African people)"), res(3144, "Wall Painting")],
    "dcterms:spatial": [res(1921, "Bayreuth"), lit("Somewhere unreconciled")],
    "dcterms:language": [res(1858, "English")],
    "dcterms:format": [res(3193, "book"), lit("handwritten manuscript")],
    "marcrel:aut": [res(149, "Beier, Ulli")],
    "dcterms:created": [ts("2013-01-01")],
    "fabio:hasDateCollected": [interval("1950-01-01/1960-12-31")],
    "dcterms:dateCopyrighted": [ts("2049-01-01")], // rights date: kept in dates, excluded from years
    "dcterms:modified": [ts("2024-05-05")], // admin date: kept in dates, excluded from years
    "dcterms:description": [lit("First."), lit("Second.")],
    "frapo:isFundedBy": [res(99, "DFG")],
    "dcterms:provenance": [res(7, "Iwalewahaus")],
    "dcterms:accessRights": [lit("Public")],
    "dcterms:identifier": [lit("KG_00001")],
    "bibo:doi": [uri("https://doi.org/10.1234/x")],
    "fabio:hasURL": [uri("https://example.org/page")],
    "dre:wisskiUrl": [uri("https://wisski.example/item")],
    "dcterms:replaces": [res(7686, "Earlier report")],
  };
  const out = transformResearchItem(item, ctx, (oId) => (oId === 1790 ? "ubt" : "external"));

  assert.equal(out.o_id, 7392);
  assert.equal(out.dre_id, "abg-99-0000");
  assert.deepEqual(out.alt_titles, ["Band 8"]);
  assert.equal(out.type, "Image");
  assert.equal(out.project.o_id, 1790);
  assert.equal(out.university, "ubt");
  assert.deepEqual(out.subjects.map((s) => s.label), ["Yoruba (African people)", "Wall Painting"]);
  // literal place degrades to label-only ref
  assert.deepEqual(out.places, [
    { label: "Bayreuth", o_id: 1921 },
    { label: "Somewhere unreconciled", o_id: null },
  ]);
  // format split: resource -> formats, literal -> format_notes
  assert.deepEqual(out.formats, [{ label: "book", o_id: 3193 }]);
  assert.deepEqual(out.format_notes, ["handwritten manuscript"]);
  assert.deepEqual(out.contributors, [{ name: "Beier, Ulli", role: "Author", o_id: 149 }]);
  // dates: timestamp + interval; rights/admin dates are exposed but excluded from the year range
  assert.equal(out.dates.created, "2013-01-01");
  assert.equal(out.dates.collected, "1950-01-01/1960-12-31");
  assert.equal(out.dates.copyrighted, "2049-01-01");
  assert.equal(out.dates.modified, "2024-05-05");
  assert.equal(out.year_min, 1950);
  assert.equal(out.year_max, 2013);
  assert.equal(out.description, "First.\nSecond.");
  assert.deepEqual(out.sponsors, ["DFG"]);
  assert.deepEqual(out.provenance, ["Iwalewahaus"]);
  assert.equal(out.doi, "https://doi.org/10.1234/x");
  assert.deepEqual(out.urls, ["https://example.org/page"]);
  assert.equal(out.wisski_url, "https://wisski.example/item");
  assert.deepEqual(out.related, [{ relation: "replaces", ref: { label: "Earlier report", o_id: 7686 } }]);
  assert.equal(out.has_media, true);
});

test("research item without dre:id falls back to omeka-<o:id>", () => {
  const out = transformResearchItem({ "o:id": 42, "o:title": "X" }, ctx, () => "external");
  assert.equal(out.dre_id, "omeka-42");
  assert.equal(out.year_min, null);
  assert.equal(out.has_media, false);
});

test("project: temporal interval splits, university from dre:id prefix", () => {
  const out = transformProject({
    "o:id": 1790,
    "o:title": "Of Art Worlds",
    "dre:id": [lit("UBT_ArtWorld2019")],
    "dcterms:temporal": [interval("2019-06-01/2022-05-31")],
    "dcterms:creator": [res(5, "Vierke, Ulf")],
    "dcterms:isPartOf": [res(20, "Arts & Aesthetics")],
    "frapo:isFundedBy": [res(99, "University of Bayreuth")],
  });
  assert.equal(out.university, "ubt");
  assert.deepEqual(out.date, { start: "2019-06-01", end: "2022-05-31" });
  assert.deepEqual(out.pis.map((p) => p.label), ["Vierke, Ulf"]);
  assert.deepEqual(out.sections.map((s) => s.label), ["Arts & Aesthetics"]);
});

test("uniFromDreId covers all prefixes", () => {
  assert.equal(uniFromDreId("UBT_X"), "ubt");
  assert.equal(uniFromDreId("ULG_X"), "unilag");
  assert.equal(uniFromDreId("UJKZ_X"), "ujkz");
  assert.equal(uniFromDreId("UFB_X"), "ufba");
  assert.equal(uniFromDreId("Ext_ILAM"), "external");
  assert.equal(uniFromDreId(null), "external");
});

test("publication: class -> type, pageStart/End fallback, numeric volume", () => {
  const out = transformPublication(
    {
      "o:id": 30001,
      "o:title": "A Paper",
      "dcterms:identifier": [lit("eref-94882")],
      "dcterms:date": [ts("2025")],
      "bibo:authorList": [res(40589, "Bango, Yanda"), lit("External, Author")],
      "dcterms:isPartOf": [lit("African Studies Working Papers")],
      "bibo:volume": [{ type: "numeric:integer", "@value": 42 }],
      "bibo:pageStart": [{ type: "numeric:integer", "@value": 7 }],
      "bibo:pageEnd": [{ type: "numeric:integer", "@value": 21 }],
      "bibo:uri": [uri("https://eref.uni-bayreuth.de/id/eprint/94882/"), uri("https://epub.uni-bayreuth.de/id/eprint/8617/")],
    },
    ctx,
    444,
  );
  assert.equal(out.pub_id, "eref-94882");
  assert.equal(out.type, "working_paper");
  assert.equal(out.year, 2025);
  assert.equal(out.volume, "42");
  assert.equal(out.pages, "7-21");
  assert.deepEqual(out.authors.map((a) => a.label), ["Bango, Yanda", "External, Author"]);
  assert.equal(out.authors[1].o_id, null);
  assert.equal(out.venue, "African Studies Working Papers");
  assert.equal(out.urls.length, 2);
});

test("podcast: customvocab speakers, missing transcript stays null", () => {
  const out = transformPodcast(
    {
      "o:id": 39096,
      "o:title": "Episode 1",
      "dcterms:isPartOf": [res(39200, "Cluster Conversations")],
      "bibo:number": [{ type: "numeric:integer", "@value": 1 }],
      "dcterms:date": [ts("2021-03-01")],
      "marcrel:spk": [vocab(149, "Guest, A")],
    },
    ctx,
  );
  assert.equal(out.episode, 1);
  assert.equal(out.year, 2021);
  assert.deepEqual(out.people, [{ name: "Guest, A", role: "Speaker", o_id: 149 }]);
  assert.equal(out.transcript, null);
});

test("video: transcript captured, playlists linked", () => {
  const out = transformVideo(
    {
      "o:id": 39218,
      "o:title": "A lecture",
      "dcterms:date": [ts("2023-11-02")],
      "dcterms:isPartOf": [res(39193, "Lectures")],
      "bibo:content": [lit("full transcript text …")],
      "fabio:hasURL": [uri("https://www.youtube.com/watch?v=x")],
    },
    ctx,
  );
  assert.equal(out.transcript, "full transcript text …");
  assert.equal(out.year, 2023);
  assert.deepEqual(out.playlists.map((p) => p.label), ["Lectures"]);
});

test("organisation kinds + location parents + person affiliations", () => {
  const org = transformOrganisation({
    "o:id": 7,
    "o:title": "Iwalewahaus",
    "dcterms:type": [res(1, "Institution")],
    "geo:lat": [lit("49.94")],
    "geo:long": [lit("11.57")],
  });
  assert.equal(org.kind, "institution");
  assert.equal(org.latitude, 49.94);
  const group = transformOrganisation({ "o:id": 8, "o:title": "RG X", "dcterms:type": [res(2, "Group")] });
  assert.equal(group.kind, "group");

  const loc = transformLocation({
    "o:id": 1921,
    "o:title": "Bayreuth",
    "geo:lat": [lit("49.9427")],
    "geo:long": [lit("11.5763")],
    "dcterms:isPartOf": [res(1900, "Germany")],
    "dcterms:identifier": [uri("http://www.wikidata.org/entity/Q3923")],
  });
  assert.equal(loc.parent.label, "Germany");
  assert.equal(loc.wikidata, "http://www.wikidata.org/entity/Q3923");

  const person = transformPerson({
    "o:id": 149,
    "o:title": "Beier, Ulli",
    "dcterms:isPartOf": [res(1224, "University of Bayreuth")],
  });
  assert.deepEqual(person.affiliations, [{ label: "University of Bayreuth", o_id: 1224 }]);
});

test("section + language + maxModified", () => {
  const sec = transformSection({
    "o:id": 20,
    "o:title": "Arts & Aesthetics",
    "dcterms:temporal": [interval("2019/2025")],
    "fabio:hasURL": [uri("https://www.africamultiple.uni-bayreuth.de/x")],
    "marcrel:spk": [res(5, "Vierke, Ulf")],
  });
  assert.deepEqual(sec.date, { start: "2019", end: "2025" });
  assert.equal(sec.spokesperson, "Vierke, Ulf");

  const lang = transformLanguage({ "o:id": 1861, "o:title": "French", "dcterms:alternative": [lit("fra")] });
  assert.deepEqual(lang, { o_id: 1861, name: "French", code: "fra" });

  const max = maxModified(
    [{ "o:modified": { "@value": "2026-06-01T00:00:00+00:00" } }, { "o:modified": { "@value": "2026-06-09T07:36:56+00:00" } }],
    null,
  );
  assert.equal(max, "2026-06-09T07:36:56+00:00");
});

test("LanguageIndex: legacy/639-1 aliases resolve to the canonical record", () => {
  const idx = new LanguageIndex([
    { o_id: 1861, name: "French", code: "fra" },
    { o_id: 1856, name: "German", code: "deu" },
  ]);
  for (const q of ["French", "fr", "fra", "fre", "français"]) assert.equal(idx.resolve(q), "French", q);
  for (const q of ["ger", "de", "deutsch"]) assert.equal(idx.resolve(q), "German", q);
  assert.equal(idx.resolve("klingon"), null);
  assert.ok(idx.matches([{ label: "French", o_id: 1861 }], "fre"));
  assert.ok(!idx.matches([{ label: "German", o_id: 1856 }], "fre"));
});

test("name matching: order-independent, accent-insensitive", () => {
  assert.ok(samePerson("Baumann, Oliver", "Oliver Baumann"));
  assert.ok(nameMatchesQuery("Baumann, Oliver", "baumann"));
  assert.ok(nameMatchesQuery("Frédérick Madore", "Frederick Madore"));
  assert.ok(!samePerson("Baumann, Oliver", "Baumann, Otto"));
});

test("itemUrl shape", () => {
  assert.equal(itemUrl(7392), "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392");
});

test("research item: item sets + thumbnail captured; transformItemSet", () => {
  const out = transformResearchItem(
    {
      "o:id": 9,
      "o:title": "X",
      "o:item_set": [{ "o:id": 6259 }, { "o:id": 27724 }],
      "o:media": [{ "o:id": 1 }],
      thumbnail_display_urls: { large: "https://site/files/large/abc.jpg", medium: null, square: null },
    },
    ctx,
    () => "external",
  );
  assert.deepEqual(out.item_sets, [6259, 27724]);
  assert.equal(out.thumbnail, "https://site/files/large/abc.jpg");

  assert.deepEqual(transformItemSet({ "o:id": 29918, "o:title": "Publications" }), {
    o_id: 29918,
    title: "Publications",
  });
});
