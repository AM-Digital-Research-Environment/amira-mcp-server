// Contracts every tool keeps: ids, clamped limits. The extended fixture and the
// helpers come from test/helpers/coverage-harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {call, 
} from "../helpers/coverage-harness.mjs";

// --- cross-tool contracts ---------------------------------------------------------------------

test("every list row and detail carries a string id and its numeric omeka_id", async () => {
  const lists = [
    ["search_research_items", {}], ["search_projects", {}], ["list_research_sections", {}], ["search_persons", {}],
    ["list_institutions", {}], ["list_groups", {}], ["list_collections", {}], ["search_publications", {}],
    ["search_podcasts", {}], ["search_videos", {}], ["list_subjects", {}], ["list_journals", {}], ["resolve_entity", { query: "Fixture" }],
  ];
  for (const [name, args] of lists) {
    const page = await call(name, args);
    assert.ok(page.results.length > 0, name);
    for (const row of page.results) {
      assert.equal(typeof row.omeka_id, "number", `${name}: ${JSON.stringify(row)}`);
      if (name === "resolve_entity") assert.match(row.id, new RegExp(`:${row.omeka_id}$`), name);
      else assert.equal(row.id, String(row.omeka_id), `${name}: ${JSON.stringify(row)}`);
    }
  }
  // list_locations rows carry the pair whenever the place is an authority.
  for (const row of (await call("list_locations")).results) assert.equal(row.id, String(row.omeka_id));
  const details = [
    ["get_research_item", { id: 500 }], ["get_project", { id: 302 }], ["get_research_section", { id: 402 }],
    ["get_person", { id: 102 }], ["get_institution", { id: 201 }], ["get_publication", { id: 510 }],
    ["get_podcast", { id: 531 }], ["get_video", { id: 541 }],
  ];
  for (const [name, args] of details) {
    const detail = await call(name, args);
    assert.equal(detail.id, String(detail.omeka_id), name);
    assert.equal(detail.omeka_id, Number(args.id), name);
  }
});

test("limits above a research tool's maximum are clamped and echoed", async () => {
  const resolved = await call("resolve_entity", { query: "a", limit: 100 });
  assert.deepEqual([resolved.requested_limit, resolved.effective_limit], [100, 50]);
  const passages = await call("get_text_passages", { ids: ["pub:510"], keyword: "zanzibar-fulltext-token", limit: 100 });
  assert.deepEqual([passages.requested_limit, passages.effective_limit, passages.count], [100, 20, 20]);
  assert.equal(passages.total_matches, 30);
  assert.equal(passages.next_offset, 20);
  const graph = await call("get_entity_graph", { seed: "person:100" });
  const edge = graph.edges[0];
  const evidence = await call("get_entity_graph", { seed: graph.seed, edge_id: edge.id, snapshot_id: graph.snapshot_id, limit: 99 });
  assert.deepEqual([evidence.requested_limit, evidence.effective_limit], [99, 50]);
  assert.equal(evidence.total_matches, edge.evidence_total);
});

test("the OpenAI search tool echoes a clamped limit like every other tool",
  // Fixed in 1.19: the clamp is echoed, and the output schema allows the two fields.
  async () => {
    const page = await call("search", { query: "fixture", limit: 100 });
    assert.deepEqual([page.requested_limit, page.effective_limit], [100, 50]);
  });
