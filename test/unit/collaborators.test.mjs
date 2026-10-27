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

test("get_person: the coverage note states the harvest's selection", async () => {
  const { coverage_note: note } = await call("get_person", { id: 101 });
  assert.match(note, /^Counts describe the records AMIRA holds/);
  assert.match(note, /from 2019 on filed under the Cluster/);
  assert.match(note, /EXC 2052/);
});
