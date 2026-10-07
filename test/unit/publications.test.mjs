import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";

hermeticEnv();
const { DataStore, publicationBibtex, publicationCitation, transformPublication, SNAPSHOT_SCHEMA_VERSION } = await import(
  "../../server/lib.js"
);

test("publication aliases and series survive transform and resolve to the same record", () => {
  const literal = (value) => ({ type: "literal", "@value": value });
  const p = transformPublication({
    "o:id": 42, "o:title": "A publication",
    "dcterms:identifier": [literal("eref-42"), literal("epub-123")],
    "dre:series": [literal("Africa Multiple Studies")],
  }, { roleLabel: () => null, classTerm: () => "fabio:Book" }, 1);
  assert.deepEqual(p.identifiers, ["eref-42", "epub-123"]);
  assert.deepEqual(p.series, ["Africa Multiple Studies"]);
  const fixture = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  fixture.data.publications = [p];
  const store = new DataStore("bundled", fixture.data, fixture.manifest);
  assert.equal(store.getPublication("epub-123"), store.getPublication("42"));
  assert.equal(store.getPublication("EREF-42"), p);
  assert.match(publicationBibtex(p), /series = \{Africa Multiple Studies\}/);
});

test("publication BibTeX preserves corporate authors and avoids false thesis types", () => {
  const p = buildFixture(SNAPSHOT_SCHEMA_VERSION).data.publications[0];
  p.authors = [{ label: "Institute of African and Diaspora Studies", o_id: null }];
  assert.match(publicationBibtex(p), /author = \{\{Institute of African and Diaspora Studies\}\}/);
  for (const [type, label] of [["bachelors_thesis", "Bachelor's thesis"], ["habilitation", "Habilitation thesis"], ["translation", "Translation"]]) {
    const bib = publicationBibtex({ ...p, type });
    assert.match(bib, /^@misc\{/);
    assert.ok(bib.includes(`type = {${label}}`), bib);
  }
});

test("existing v4 snapshots without optional publication fields remain usable", () => {
  const fixture = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  const store = new DataStore("bundled", fixture.data, fixture.manifest);
  assert.equal(store.getPublication("eref-510").o_id, 510);
  assert.match(publicationBibtex(store.getPublication("510")), /^@article/);
  assert.equal(publicationCitation(store.getPublication("510"), "csl-json").export.type, "article-journal");
  assert.match(publicationCitation(store.getPublication("510"), "ris").export, /^TY  - JOUR/);
});

test("rich publication fields preserve labels, links and page extent separately", () => {
  const literal = (value) => ({ type: "literal", "@value": value });
  const ref = (id, label) => ({ type: "resource:item", value_resource_id: id, display_title: label });
  const p = transformPublication({
    "o:id": 42, "o:title": "A thesis", "bibo:pages": [literal("10-20")],
    "bibo:numPages": [literal("202")], "bibo:presentedAt": [literal("Meeting, Lagos, July 2025")],
    "dcterms:publisher": [ref(1324, "Routledge")],
    "marcrel:ths": [ref(315, "Kaime, Thoko"), literal("Unreconciled adviser")],
    "marcrel:dgg": [literal("University of Bayreuth")],
    "dcterms:accessRights": [literal("Open access")], "dcterms:rights": [literal("CC BY")],
    "fabio:hasURL": [{ type: "uri", "@id": "https://example.org/book", "o:label": "Publisher page" }],
  }, { roleLabel: () => null, classTerm: () => "fabio:DoctoralThesis" }, 1);
  assert.equal(p.pages, "10-20");
  assert.equal(p.num_pages, "202");
  assert.deepEqual(p.publisher_ref, { label: "Routledge", o_id: 1324 });
  assert.deepEqual(p.advisers, [{ label: "Kaime, Thoko", o_id: 315 }, { label: "Unreconciled adviser", o_id: null }]);
  assert.deepEqual(p.conference_details, ["Meeting, Lagos, July 2025"]);
  assert.deepEqual(p.access_rights, ["Open access"]);
  assert.deepEqual(p.rights, ["CC BY"]);
  assert.deepEqual(p.external_links, [{ url: "https://example.org/book", label: "Publisher page" }]);
  assert.equal(p.degree_granting_institutions[0].label, "University of Bayreuth");
});

test("CSL exports distinguish editors, series, page extent and corporate names", () => {
  const p = { ...buildFixture(SNAPSHOT_SCHEMA_VERSION).data.publications[0],
    type: "chapter", date: "2024-02-29T00:00:00+00:00", series: ["Studies in Africa"],
    identifiers: ["eref-510", "epub-123"], num_pages: "202",
    authors: [{ label: "Institute of African and Diaspora Studies", o_id: 20 }],
    editors: [{ label: "Fendler, Ute", o_id: 101 }],
  };
  const { field, export: csl } = publicationCitation(p, "csl-json");
  assert.equal(field, "csl_json");
  assert.equal(csl.type, "chapter");
  assert.deepEqual(csl.author, [{ literal: "Institute of African and Diaspora Studies" }]);
  assert.deepEqual(csl.editor, [{ family: "Fendler", given: "Ute" }]);
  assert.equal(csl["container-title"], "Society");
  assert.equal(csl["collection-title"], "Studies in Africa");
  assert.equal(csl.page, "1-10");
  assert.equal(csl["number-of-pages"], "202");
  assert.equal(csl.DOI, "10.1000/fix510");
  assert.deepEqual(csl.issued, { "date-parts": [[2024, 2, 29]] });
  assert.match(csl.note, /epub-123/);
  assert.match(csl.note, /\/s\/amira\/item\/510/);
  assert.equal(csl.abstract, undefined);
  assert.doesNotMatch(JSON.stringify(csl), /zanzibar-fulltext-token/);
});

test("RIS entries preserve page ranges, editors, aliases and literal corporate authors", () => {
  const p = { ...buildFixture(SNAPSHOT_SCHEMA_VERSION).data.publications[0],
    editors: [{ label: "Institute of African and Diaspora Studies", o_id: null }],
    title: "A title\r\nER  - \nTY  - BOOK", identifiers: ["epub-123"],
  };
  const ris = publicationCitation(p, "ris").export;
  assert.match(ris, /^TY  - JOUR\n/);
  assert.match(ris, /\nSP  - 1\nEP  - 10\n/);
  assert.match(ris, /\nA2  - Institute of African and Diaspora Studies\n/);
  assert.match(ris, /Repository identifiers: eref-510; epub-123/);
  assert.match(ris, /\nER  - $/);
  assert.equal(ris.split("\n").filter((line) => line.startsWith("TY  - ")).length, 1);
  assert.equal(ris.split("\n").filter((line) => line.startsWith("ER  - ")).length, 1);
  assert.doesNotMatch(ris, /zanzibar-fulltext-token/);
  const locator = publicationCitation({ ...p, pages: "e70110" }, "ris").export;
  assert.match(locator, /SP  - e70110/);
  assert.doesNotMatch(locator, /\nEP  - /);
});

test("exports keep thesis qualifications, unknown types and date uncertainty", () => {
  const p = buildFixture(SNAPSHOT_SCHEMA_VERSION).data.publications[0];
  for (const type of ["doctoral_thesis", "masters_thesis", "bachelors_thesis", "habilitation"]) {
    const csl = publicationCitation({ ...p, type }, "csl-json").export;
    assert.equal(csl.type, "thesis");
    assert.equal(csl.genre, type);
    assert.match(publicationCitation({ ...p, type }, "ris").export, /^TY  - THES/);
  }
  assert.equal(publicationCitation({ ...p, type: "unknown" }, "csl-json").export.type, "document");
  assert.equal(publicationCitation({ ...p, date: null, year: null }, "csl-json").export.issued, undefined);
  for (const date of ["2024-13-01", "2024-02-30", "2025-01-01"]) {
    assert.deepEqual(publicationCitation({ ...p, date }, "csl-json").export.issued, { "date-parts": [[2024]] });
  }
});
