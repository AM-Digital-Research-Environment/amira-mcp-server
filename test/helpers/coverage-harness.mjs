// The harness of the exact-assertion tool coverage (test/unit/tools-coverage-*.test.mjs),
// for the tools that had only smoke coverage
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
// under a stale label, a group-credited item, a second podcast episode and a
// video with three speakers.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "./env.mjs";
import { connectInMemory } from "./mcp.mjs";

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
// Linked to its project the way the live sets are (dcterms:isPartOf + dre:id);
// set 800 has no link, so its project is inferred from its members (#18).
d.item_sets.push({ o_id: 801, title: "Sound Collection", project: { label: "Ouaga Sound Archive", o_id: 302 }, code: "UJKZ_Sound2021" });
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
// A video shared by two authority persons and one name-only speaker.
d.videos.push({
  o_id: 542, title: "Round Table on Sound", abstract: null, playlists: [], date: "2024-05-01", year: 2024,
  speakers: [{ name: "Kaboré, Awa", role: "Speaker", o_id: 102 }, { name: "Fendler, Ute", role: "Speaker", o_id: 101 },
    { name: "Diallo, Mariam", role: "Speaker", o_id: null }],
  languages: [], url: "https://www.youtube.com/watch?v=fixture542", transcript: null,
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
const ref = (label, id) => ({ label, omeka_id: id, amira_url: url(id) });
const AMRC = { key: "amrc", name: "Africa Multiple Research Centres", omeka_id: 37685, amira_url: url(37685) };

export {
  lib, fixture, d, KNOWLEDGES_DESCRIPTION, conn, call, raw, url, SITE, errorOf, omekaIds, itemRef, ref, AMRC,
};
