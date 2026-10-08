// Empty-result guidance on the search tools (src/tools/pagination.ts
// emptySearchHint). A filtered search that finds nothing says that a filter may
// be the cause instead of returning a bare empty list; a search that matches is
// unchanged. With AMIRA_GUIDANCE=off the hint goes, and so do
// search_research_items' relaxation counts (`suggestions`) and place spellings
// (`did_you_mean`), which are the same kind of advice.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

const conn = await connectInMemory(lib, {}, { name: "empty-results" });
test.after(() => conn.close());

const RELAX = "No record matches all these filters. Drop or broaden them one at a time to find the one that excludes everything.";

/** One filtered search per tool that matches nothing in the fixture. */
const EMPTY_SEARCHES = [
  ["search_research_items", { subject: "Islam", resource_type: "Audio" }],
  ["search_research_items", { keyword: "no-such-word-qq" }],
  ["search_projects", { keyword: "no-such-word-qq" }],
  ["search_publications", { keyword: "no-such-word-qq" }],
  ["search_publications", { keyword: "no-such-word-qq", citation_format: "bibtex" }],
  ["search_podcasts", { keyword: "no-such-word-qq" }],
  ["search_videos", { keyword: "no-such-word-qq" }],
  ["search_persons", { keyword: "Ute", affiliation: "Bayreuth" }],
];

/** Searches that match: their bodies must not change. */
const MATCHING_SEARCHES = [
  ["search_research_items", { subject: "Islam", resource_type: "Image" }],
  ["search_research_items", {}],
  ["search_projects", {}],
  ["search_publications", { keyword: "decolonial" }],
  ["search_podcasts", {}],
  ["search_videos", {}],
  ["search_persons", { keyword: "Ute" }],
];

test("a filtered search that finds nothing carries the relax hint", async () => {
  for (const [tool, args] of EMPTY_SEARCHES) {
    const page = await conn.call(tool, args);
    assert.equal(page.total_matches, 0, `${tool} ${JSON.stringify(args)}`);
    assert.equal(page.hint, RELAX, `${tool} ${JSON.stringify(args)}`);
  }
});

test("a search that matches carries no hint", async () => {
  for (const [tool, args] of MATCHING_SEARCHES) {
    const page = await conn.call(tool, args);
    assert.ok(page.total_matches > 0, `${tool} ${JSON.stringify(args)}`);
    assert.ok(!("hint" in page), `${tool} ${JSON.stringify(args)}`);
  }
});

test("search_research_items keeps its relaxation counts and place spellings beside the hint", async () => {
  const zero = await conn.call("search_research_items", { subject: "Islam", resource_type: "Audio" });
  assert.ok(zero.suggestions.some((s) => s.remove_filter === "resource_type" && s.would_match === 2));
  const miss = await conn.call("search_research_items", { location: "Lagoss" });
  assert.deepEqual([miss.did_you_mean, miss.hint], [[{ filter: "location", values: ["Lagos"] }], RELAX]);
});

test("AMIRA_GUIDANCE=off: empty searches stay bare, matching ones are unchanged", async () => {
  // Results read the variable per call, so take the guided bodies first.
  const guided = [];
  for (const [tool, args] of MATCHING_SEARCHES) guided.push(await conn.call(tool, args));
  process.env.AMIRA_GUIDANCE = "off";
  try {
    const off = await connectInMemory(lib, {}, { name: "empty-results-off" });
    try {
      for (const [tool, args] of EMPTY_SEARCHES) {
        const page = await off.call(tool, args);
        for (const key of ["hint", "suggestions", "did_you_mean"]) {
          assert.ok(!(key in page), `${tool} ${JSON.stringify(args)}: ${key}`);
        }
      }
      assert.ok(!("did_you_mean" in (await off.call("search_research_items", { location: "Lagoss" }))));
      for (const [i, [tool, args]] of MATCHING_SEARCHES.entries()) {
        assert.deepEqual(await off.call(tool, args), guided[i], `${tool} ${JSON.stringify(args)}`);
      }
    } finally {
      await off.close();
    }
  } finally {
    delete process.env.AMIRA_GUIDANCE;
  }
});
