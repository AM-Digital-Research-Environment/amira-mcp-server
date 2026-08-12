// Generated research-item citations (src/citation.ts, issue #4).
//
// The builder is a pure function of one record, so it is tested here directly
// against synthetic items — the cases that matter are contributor-role and
// name-shape edges the fixture snapshot does not (and should not) contain.
// test/unit/tools.test.mjs covers the wiring into get_research_item.
import test from "node:test";
import assert from "node:assert/strict";
import { generateItemCitation } from "../../server/lib.js";

delete process.env.AMIRA_EXPOSURE;

/** A minimal ResearchItemRec — only the fields a citation reads. */
function item(over = {}) {
  return {
    o_id: 7392,
    title: "Yoruba Architecture and Wall Painting",
    type: "Image",
    year_min: 2013,
    year_max: 2013,
    contributors: [{ name: "Beier, Ulli", role: "Author", o_id: 149 }],
    provenance: [],
    doi: null,
    ...over,
  };
}

const sources = { collection: "Of Art Worlds", project: "Of Art Worlds" };
const cite = (over, src = sources, format) => generateItemCitation(item(over), src, format);

test("the readable citation carries creator, medium, date, collection and the amira_url", () => {
  const { citation, field } = cite({});
  assert.equal(field, "bibtex", "BibTeX is the default export");
  assert.equal(
    citation,
    "Beier, Ulli. “Yoruba Architecture and Wall Painting.” Image, 2013. Of Art Worlds. " +
      "AMIRA, Africa Multiple Cluster of Excellence, University of Bayreuth. " +
      "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392.",
  );
});

test("an undated item is n.d. — and the full stop is not doubled", () => {
  const { citation } = cite({ year_min: null, year_max: null });
  assert.ok(citation.includes("Image, n.d. Of Art Worlds."), citation);
  assert.ok(!citation.includes("n.d.."), "n.d. already ends the segment");
});

test("a date range spans both years; BibTeX takes the earliest", () => {
  const { citation, export: bib } = cite({ year_min: 1955, year_max: 1968 });
  assert.ok(citation.includes("Image, 1955–1968."), citation);
  assert.ok(bib.includes("year = {1955}"), bib);

  const { export: csl } = cite({ year_min: 1955, year_max: 1968 }, sources, "csl-json");
  assert.deepEqual(csl.issued, { "date-parts": [[1955], [1968]] });
});

test("only authorial roles stay implicit; anything else is named", () => {
  assert.ok(cite({}).citation.startsWith("Beier, Ulli. “"), "an Author needs no role label");
  const photo = cite({ contributors: [{ name: "Greven, Katharina", role: "Photographer", o_id: 303 }] });
  assert.ok(photo.citation.startsWith("Greven, Katharina (Photographer). “"), photo.citation);
});

test("creator roles outrank record-keeping ones, and a person credited twice appears once", () => {
  // The real shape of item 7398: Beier is both Collector and Photographer.
  const { citation, export: bib } = cite({
    contributors: [
      { name: "Beier, Ulli", role: "Collector", o_id: 149 },
      { name: "Beier, Ulli", role: "Photographer", o_id: 149 },
      { name: "Greven, Katharina", role: "Photographer", o_id: 303 },
    ],
  });
  assert.ok(citation.startsWith("Beier, Ulli (Photographer) and Greven, Katharina (Photographer)."), citation);
  assert.equal(bib.match(/Beier/g).length, 1, "no duplicate author");
  assert.ok(bib.includes("author = {Beier, Ulli and Greven, Katharina}"), bib);
});

test("custody and funding credits are never creators", () => {
  const { citation, export: bib } = cite({
    contributors: [
      { name: "Deutsche Forschungsgemeinschaft", role: "Sponsor", o_id: 1 },
      { name: "Ghana Broadcasting Corporation Gramophone Library", role: "Repository", o_id: 2 },
    ],
  });
  // Title-first, with the holding repository still credited after the date.
  assert.ok(citation.startsWith("“Yoruba"), citation);
  assert.ok(citation.includes("Ghana Broadcasting Corporation Gramophone Library."), citation);
  assert.ok(!bib.includes("author = "), bib);
  assert.ok(bib.includes("organization = {Ghana Broadcasting Corporation Gramophone Library}"), bib);
});

test("record-keeping roles are the fallback when nobody created the artefact", () => {
  const { citation } = cite({ contributors: [{ name: "Fendler, Ute", role: "Interviewer", o_id: 101 }] });
  assert.ok(citation.startsWith("Fendler, Ute (Interviewer)."), citation);
});

test("four or more creators become et al. — the export keeps them all", () => {
  const contributors = ["A, One", "B, Two", "C, Three", "D, Four"].map((name) => ({ name, role: "Author", o_id: null }));
  const { citation, export: bib } = cite({ contributors });
  assert.ok(citation.startsWith("A, One et al. “"), citation);
  assert.ok(bib.includes("author = {A, One and B, Two and C, Three and D, Four}"), bib);
});

test("corporate names are brace-protected so BibTeX cannot split them on 'and'", () => {
  const { export: bib } = cite({
    contributors: [{ name: "Institute of African and Diaspora Studies", role: "Creator", o_id: 3 }],
  });
  assert.ok(bib.includes("author = {{Institute of African and Diaspora Studies}}"), bib);

  // CSL keeps them literal too — citeproc must not invert them into a surname.
  const { export: csl } = cite(
    { contributors: [{ name: "Institute of African and Diaspora Studies", role: "Creator", o_id: 3 }] },
    sources,
    "csl-json",
  );
  assert.deepEqual(csl.author, [{ literal: "Institute of African and Diaspora Studies" }]);
});

test("the project is noted only when it differs from the collection", () => {
  const same = cite({}).export;
  assert.ok(!same.includes("Project:"), same);
  const differs = cite({}, { collection: "ILAM", project: "Digital Return" }).export;
  assert.ok(differs.includes("note = {Project: Digital Return. AMIRA item 7392}"), differs);
  assert.ok(differs.includes("series = {ILAM}"), differs);
});

test("provenance rides in the note, never in the readable citation", () => {
  const { citation, export: bib } = cite({ provenance: ["Iwalewahaus", "Bayreuth"] });
  assert.ok(!citation.includes("Iwalewahaus"), citation);
  assert.ok(bib.includes("note = {Provenance: Iwalewahaus; Bayreuth. AMIRA item 7392}"), bib);
});

test("a DOI is exported bare, and the cited link stays the amira_url", () => {
  const doi = { doi: "https://doi.org/10.1111/rode.12901" };
  const bib = cite(doi).export;
  assert.ok(bib.includes("doi = {10.1111/rode.12901}"), bib);
  assert.ok(bib.includes("url = {https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392}"), bib);
  assert.equal(cite(doi, sources, "csl-json").export.DOI, "10.1111/rode.12901");
});

test("RIS types follow the medium and the record closes with ER", () => {
  const ris = cite({}, sources, "ris").export;
  assert.equal(cite({}, sources, "ris").field, "ris");
  assert.ok(ris.startsWith("TY  - FIGURE\nID  - amira-7392\n"), ris);
  assert.ok(ris.includes("AU  - Beier, Ulli"), ris);
  assert.ok(ris.includes("T2  - Of Art Worlds"), ris);
  assert.ok(ris.endsWith("\nER  - "), ris);
  assert.ok(cite({ type: "Moving image" }, sources, "ris").export.startsWith("TY  - VIDEO"));
  assert.ok(cite({ type: "Audio" }, sources, "ris").export.startsWith("TY  - SOUND"));
  assert.ok(cite({ type: "Manuscript" }, sources, "ris").export.startsWith("TY  - MANSCPT"));
  assert.ok(cite({ type: "Nothing we map" }, sources, "ris").export.startsWith("TY  - GEN"));
});

test("CSL-JSON is an object, typed by medium", () => {
  const { export: csl, field } = cite({}, sources, "csl-json");
  assert.equal(field, "csl_json");
  assert.equal(csl.type, "graphic");
  assert.equal(csl.id, "amira-7392");
  assert.equal(csl["collection-title"], "Of Art Worlds");
  assert.equal(csl.URL, "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392");
  assert.equal(cite({ type: "Manuscript" }, sources, "csl-json").export.type, "manuscript");
  assert.equal(cite({ type: "Dataset" }, sources, "csl-json").export.type, "dataset");
});

test("manuscripts are the one archival case BibTeX types as unpublished", () => {
  assert.ok(cite({ type: "Manuscript" }).export.startsWith("@unpublished{amira-7392,"));
  assert.ok(cite({}).export.startsWith("@misc{amira-7392,"));
  // @unpublished demands a note; the AMIRA id guarantees one exists.
  assert.ok(cite({ type: "Manuscript" }).export.includes("note = {AMIRA item 7392}"));
});

test("below `structured` exposure the citation drops people and collections, not citability", async (t) => {
  process.env.AMIRA_EXPOSURE = "descriptive";
  t.after(() => delete process.env.AMIRA_EXPOSURE);

  const { citation, export: bib } = cite({ provenance: ["Iwalewahaus"] });
  assert.equal(
    citation,
    "“Yoruba Architecture and Wall Painting.” Image, 2013. " +
      "AMIRA, Africa Multiple Cluster of Excellence, University of Bayreuth. " +
      "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392.",
  );
  assert.ok(!bib.includes("author = "), bib);
  assert.ok(!bib.includes("series = "), bib);
  assert.ok(!bib.includes("Provenance:"), bib);
  assert.ok(bib.includes("url = {https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392}"), bib);
});
