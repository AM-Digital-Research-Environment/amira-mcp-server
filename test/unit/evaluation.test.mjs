// Deterministic replay of the dated evaluation sets in test/evaluations/. Each
// question has an oracle: the exact tool calls a careful model would make. The
// replay runs only when the bundled data/ snapshot is the one the set was
// verified on — the answers are facts about that snapshot, not invariants — and
// skips otherwise (CI unit jobs use the fixture; release jobs crawl fresh data).
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { hermeticEnv, REPO_ROOT } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const DATA_DIR = fileURLToPath(new URL("../../data", import.meta.url));
hermeticEnv();
process.env.AMIRA_DATA_DIR = DATA_DIR;
const lib = await import("../../server/lib.js");

/** The snapshot each evaluation set was verified against. */
const SETS = {
  "amira-2026-10-06.xml": "2026-10-06T15:37:16.611Z",
  "publications.xml": "2026-09-09T08:12:42.277Z",
};

function qaPairs(file) {
  const xml = fs.readFileSync(`${REPO_ROOT}/test/evaluations/${file}`, "utf8");
  return [...xml.matchAll(/<question>([\s\S]*?)<\/question>\s*<answer>([\s\S]*?)<\/answer>/g)].map((m) => ({ question: m[1].trim(), answer: m[2].trim() }));
}

let snapshot = null;
try {
  snapshot = fs.existsSync(DATA_DIR) ? (await lib.loadSnapshot(DATA_DIR)).manifest : null;
} catch { /* an unusable data/ directory simply means no replay */ }

const conn = snapshot ? await connectInMemory(lib, { openai: true }, { name: "evaluation" }) : null;
const call = (name, args = {}) => conn.call(name, args);
test.after(() => conn?.close());

/** Oracles for amira-2026-10-06.xml, in question order. */
const ORACLES_2026_10_06 = [
  async () => {
    const total = (await call("list_publication_facets", { facet: "type", language: "fr" })).total_publications;
    const articles = (await call("search_publications", { language: "fr", type: "article", limit: 1 })).total_matches;
    return `${total}, ${articles}`;
  },
  async () => String((await call("list_publication_facets", { facet: "language" })).missing_values),
  async () => {
    const [a, b] = [await call("get_publication", { id: "epub-9405" }), await call("get_publication", { id: "eref-95983" })];
    assert.equal(a.amira_url, b.amira_url);
    return a.amira_url;
  },
  async () => {
    const overview = (await call("get_collection_overview")).counts.publications_with_fulltext;
    const search = (await call("search_publications", { has_fulltext: true, limit: 1 })).total_matches;
    assert.equal(overview, search);
    return String(search);
  },
  async () => (await call("get_publication", { id: 29949 })).advisers[0].amira_url,
  async () => String((await call("search_research_items", { country: "Côte d'Ivoire", limit: 1 })).total_matches),
  async () => {
    const niger = (await call("search_research_items", { country: "Niger", limit: 1 })).total_matches;
    const nigeria = (await call("search_research_items", { country: "Nigeria", limit: 1 })).total_matches;
    return `${niger}, ${nigeria}`;
  },
  async () => String((await call("search_research_items", { has_media: true, limit: 1 })).total_matches),
  async () => {
    const episodes = (await call("search_podcasts", { limit: 100 })).results;
    const models = new Map();
    for (const e of episodes) {
      const name = (await call("get_podcast", { id: e.id })).transcript_generated_by?.name ?? "none";
      models.set(name, (models.get(name) ?? 0) + 1);
    }
    const [[model, count]] = [...models].sort((a, b) => b[1] - a[1]);
    return `${model}, ${count}`;
  },
  async () => {
    const lcsh = (await call("list_subjects", { vocabulary: "lcsh", limit: 1 })).distinct_subjects;
    const tags = (await call("list_subjects", { vocabulary: "tag", limit: 1 })).distinct_subjects;
    return `${lcsh}, ${tags}`;
  },
  async () => {
    const [person] = (await call("resolve_entity", { query: "Drescher, Martina", type: "person" })).results;
    return (await call("get_person", { id: person.omeka_id })).identifiers.find((i) => i.scheme === "gnd").id;
  },
  async () => (await call("get_institution", { name: "UJKZ" })).amira_url,
  async () => (await call("get_research_item", { id: 10185 })).provenance[0].amira_url,
  async () => (await call("get_research_item", { id: 10185 })).identifiers.find((i) => i.value === "30625").type,
  async () => String((await call("list_locations", { near: { latitude: 7.3775, longitude: 3.947, km: 150 } })).total_matches),
];

for (const [file, fetchedAt] of Object.entries(SETS)) {
  const pairs = qaPairs(file);
  const oracles = file === "amira-2026-10-06.xml" ? ORACLES_2026_10_06 : null;
  if (oracles) {
    test(`${file}: one oracle per question`, () => assert.equal(oracles.length, pairs.length));
  }
  const skip = !snapshot ? "no bundled data/ snapshot"
    : snapshot.fetchedAt !== fetchedAt ? `verified on the ${fetchedAt} snapshot; data/ holds ${snapshot.fetchedAt}`
    : !oracles ? "no deterministic oracles for this set" : false;
  pairs.forEach(({ question, answer }, i) => {
    test(`${file} #${i + 1}: ${question.slice(0, 60)}…`, { skip }, async () => {
      assert.equal(await oracles[i](), answer);
    });
  });
}
