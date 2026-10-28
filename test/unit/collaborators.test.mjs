// get_person collaborators count shared work, not shared credits. A review of
// 1.27.0 answers by the researchers they described (October 2026) found a
// podcast's sound engineer listed among a speaker's collaborators. The shared
// fixture is extended in this process only: a sound engineer on a new episode,
// and an item the same person transcribed.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const d = fixture.data;
d.persons.push({ o_id: 103, name: "Okafor, Chidi", affiliations: [], identifiers: [] });
d.podcasts.push({
  o_id: 532, title: "Fixture Conversations Episode 3", series: { label: "Cluster Conversations", o_id: 555 }, episode: 3,
  date: "2022-06-01", year: 2022, abstract: null,
  people: [
    { name: "Fendler, Ute", role: "Host", o_id: 101 },
    { name: "Beier, Ulli", role: "Speaker", o_id: 100 },
    { name: "Okafor, Chidi", role: "Sound engineer", o_id: 103 },
  ],
  url: "https://example.org/podcast/3", transcript: null, languages: [],
});
d.research_items.push({
  ...structuredClone(d.research_items[1]),
  o_id: 505, dre_id: "ubt-fx-0505", title: "Interview Transcript",
  contributors: [{ name: "Fendler, Ute", role: "Interviewer", o_id: 101 }, { name: "Okafor, Chidi", role: "Transcriber", o_id: 103 }],
});
// An edited volume and two of its chapters, whose records repeat the volume's
// editors, and an 11-author working paper.
d.persons.push({ o_id: 104, name: "Mensah, Ama", affiliations: [], identifiers: [] },
  { o_id: 105, name: "Bello, Tunde", affiliations: [], identifiers: [] },
  { o_id: 106, name: "Chukwu, Ada", affiliations: [], identifiers: [] });
const pub = (o_id, fields) => ({ ...structuredClone(d.publications[0]), o_id, pub_id: `eref-${o_id}`, doi: null, fulltext: null, ...fields });
const volumeEditors = [{ label: "Fendler, Ute", o_id: 101 }, { label: "Mensah, Ama", o_id: 104 }];
d.publications.push(
  pub(560, { type: "book", title: "Shared Memory : Essays on Commemoration", authors: [], editors: volumeEditors,
    venue: "Shared Memory", venue_ref: null }),
  pub(561, { type: "chapter", title: "Monuments in Motion", authors: [{ label: "Beier, Ulli", o_id: 100 }],
    editors: volumeEditors, venue: "Shared Memory : essays on commemoration", venue_ref: null }),
  pub(562, { type: "chapter", title: "Introduction", authors: [{ label: "Fendler, Ute", o_id: 101 }, { label: "Bello, Tunde", o_id: 105 }],
    editors: volumeEditors, venue: "Shared Memory : Essays on Commemoration", venue_ref: null }),
  pub(563, { type: "working_paper", title: "A Position Paper", editors: [], venue: null, venue_ref: null,
    authors: [{ label: "Beier, Ulli", o_id: 100 }, { label: "Chukwu, Ada", o_id: 106 },
      ...Array.from({ length: 9 }, (_, i) => ({ label: `Member, Team ${i + 1}`, o_id: null }))] }),
);
fixture.manifest.counts = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "collaborators" });
const { call } = conn;
test.after(() => conn.close());

const names = (person) => person.top_collaborators.map((c) => c.name);

test("get_person: people sharing an episode on air are collaborators; its sound engineer is not", async () => {
  const fendler = await call("get_person", { id: 101 });
  assert.ok(names(fendler).includes("Beier, Ulli"), JSON.stringify(names(fendler)));
  assert.ok(!names(fendler).includes("Okafor, Chidi"), JSON.stringify(names(fendler)));
  const beier = await call("get_person", { id: 100 });
  assert.ok(!names(beier).includes("Okafor, Chidi"), JSON.stringify(names(beier)));
});

test("get_person: crew credits still list the records, but give their holder no collaborators", async () => {
  const okafor = await call("get_person", { id: 103 });
  assert.deepEqual(okafor.podcasts.map((p) => [p.omeka_id, p.role]), [[532, "Sound engineer"]]);
  assert.deepEqual(okafor.contributed_items.map((i) => [i.omeka_id, i.role]), [[505, "Transcriber"]]);
  assert.deepEqual([okafor.collaborator_count, okafor.top_collaborators], [0, []]);
});

const row = (person, name) => person.top_collaborators.find((c) => c.name === name);

test("get_person: a chapter author and the volume's editors are not collaborators", async () => {
  const beier = await call("get_person", { id: 100 });
  assert.equal(row(beier, "Mensah, Ama"), undefined);
  // Fendler shares a podcast episode with Beier, not the chapter.
  assert.deepEqual([row(beier, "Fendler, Ute").shared_publications, row(beier, "Fendler, Ute").shared_recordings], [0, 1]);
});

test("get_person: co-editors count once per volume, co-authors once per record", async () => {
  const fendler = await call("get_person", { id: 101 });
  const mensah = row(fendler, "Mensah, Ama");
  assert.deepEqual([mensah.shared_editorships, mensah.shared_authorships, mensah.shared_publications], [1, 0, 1]);
  const bello = row(fendler, "Bello, Tunde");
  assert.deepEqual([bello.shared_authorships, bello.shared_editorships, bello.shared_publications], [1, 0, 1]);
  assert.equal(row(fendler, "Beier, Ulli").shared_publications, 0);
});

test("get_person: publications with more than ten authors add no collaborators and are counted apart", async () => {
  const beier = await call("get_person", { id: 100 });
  assert.equal(row(beier, "Chukwu, Ada"), undefined);
  assert.ok(!beier.top_collaborators.some((c) => c.name.startsWith("Member, Team")), JSON.stringify(names(beier)));
  assert.equal(beier.large_team_publication_count, 1);
  assert.ok(beier.publications.some((p) => p.omeka_id === 563), "the paper itself stays listed");
  assert.equal((await call("get_person", { id: 101 })).large_team_publication_count, undefined);
});

test("get_person: the collaborators note says what the list measures", async () => {
  const { collaborators_note: note } = await call("get_person", { id: 101 });
  assert.match(note, /^People credited with this person on the same records, not a measure of collaboration/);
});

test("get_person: the coverage note states the harvest's selection", async () => {
  const { coverage_note: note } = await call("get_person", { id: 101 });
  assert.match(note, /^Counts describe the records AMIRA holds/);
  assert.match(note, /from 2019 on filed under the Cluster/);
  assert.match(note, /EXC 2052/);
});
