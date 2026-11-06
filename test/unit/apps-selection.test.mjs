// What the interactive views share with the model (ui/update-model-context) and ask the host. The page, the bridge stub and `mount` come
// from test/helpers/apps-harness.mjs, which explains how the views are run.
import test from "node:test";
import assert from "node:assert/strict";
import {
  lib, payload, AMIRA_URL, mount, assertHealthy,
} from "../helpers/apps-harness.mjs";

// --- the selection the interactive views share with the model -----------------
// The views hand the bridge their raw selection; src/ui/selectionContext.ts
// bounds it and the bridge sends it (test/unit/apps.test.mjs drives that half
// over the real protocol). Here: that each view reports what the reader sees,
// with every record's amira_url, and that the controls follow the host's
// capabilities.

/** The shared selection as the model would receive it. */
const contextOf = (selection) => lib.buildSelectionContext(selection).structuredContent;

test("bibliography: shares its filters and the page in view, then the selected publications", async (t) => {
  const app = await mount(t, "search_publications", { canShare: true, canAsk: true });
  const d = await payload("search_publications");
  app.show(d);
  assertHealthy(app);
  let shared = app.lastShared();
  assert.equal(shared.view, "bibliography");
  assert.equal(shared.records_label, "publications on the current page");
  assert.deepEqual(shared.records.map((r) => r.amira_url), d.results.map((p) => p.amira_url));
  assert.deepEqual(shared.counts, { total_matches: d.total_matches, selected: 0, page_offset: 0 });

  const first = d.results[0];
  const box = app.root.querySelector(`input[data-id="${first.omeka_id}"]`);
  box.checked = true;
  box.dispatchEvent(new app.win.Event("change", { bubbles: true }));
  shared = app.lastShared();
  assert.equal(shared.records_label, "selected publications");
  assert.deepEqual(shared.records, [{ id: String(first.omeka_id), title: first.title, year: first.year, type: first.type, amira_url: first.amira_url }]);
  assert.equal(shared.counts.selected, 1);
  const context = contextOf(shared);
  assert.equal(context.records[0].amira_url, first.amira_url);
  assert.equal(context.truncated, false);

  // A keyword search shares the new filters; the selection persists.
  app.root.querySelector('input[name="keyword"]').value = "Migration";
  app.submit(app.root.querySelector("#publication-search"));
  await app.waitFor(() => app.lastShared().filters?.keyword === "Migration", "filters shared");
  assert.deepEqual(app.lastShared().records.map((r) => r.amira_url), [first.amira_url]);

  // "Ask about this selection" goes through the bridge, which sends its own snapshot.
  app.click(app.root.querySelector("#ask-selection"));
  await app.waitFor(() => app.status() === "Question sent to the conversation.", "question sent");
  assert.equal(app.asked, 1);
  assert.ok(app.root.querySelector("#selection-status"), "a status line for the automatic updates");
  assertHealthy(app);
});

test("selection controls follow the host: no Ask button or status line on a host without either capability", async (t) => {
  for (const [canAsk, canShare] of [[false, false], [true, false], [false, true]]) {
    const app = await mount(t, "search_publications", { canAsk, canShare });
    app.show(await payload("search_publications"));
    assert.equal(!!app.root.querySelector("#ask-selection"), canAsk, `ask ${canAsk}`);
    assert.equal(!!app.root.querySelector("#selection-status"), canShare, `status ${canShare}`);
    // The view still reports its selection; the bridge decides whether to send it.
    assert.equal(app.lastShared().view, "bibliography");
  }
});

test("map: shares its filters, then the opened place and its cited research items", async (t) => {
  const app = await mount(t, "list_locations", { canShare: true, canAsk: true });
  const d = await payload("list_locations");
  app.show(d);
  assertHealthy(app);
  assert.equal(app.lastShared().view, "map");
  assert.deepEqual(app.lastShared().focus, []);
  assert.match(app.lastShared().summary, /^No place selected\. Places matching the map filters: \d+\.$/);

  const nigeria = d.results.find((r) => r.name === "Nigeria");
  app.click(app.root.querySelector(`button[data-place-id="${nigeria.omeka_id}"]`));
  await app.waitFor(() => app.lastShared().focus?.length === 1, "place shared");
  const evidence = await payload("search_research_items", { limit: 20, offset: 0, location_id: nigeria.omeka_id });
  const shared = app.lastShared();
  assert.deepEqual(shared.focus, [{ title: "Nigeria", id: nigeria.omeka_id, type: nigeria.coordinate_scope === "hierarchy_root" ? "hierarchy root" : "place",
    count: nigeria.item_count, amira_url: nigeria.amira_url }]);
  assert.deepEqual(shared.records.map((r) => r.amira_url), evidence.results.map((r) => r.amira_url));
  assert.equal(shared.counts.matching_items, evidence.total_matches);
  for (const record of contextOf(shared).records) assert.match(record.amira_url, AMIRA_URL);
  assert.ok(app.root.querySelector("#ask-selection"));

  // A new filter clears the place.
  await app.waitFor(() => app.root.querySelector('select[name="country"]'), "country dropdown");
  app.root.querySelector('select[name="country"]').value = "Nigeria";
  app.submit(app.root.querySelector("#map-filter"));
  await app.waitFor(() => app.lastShared().filters?.country === "Nigeria", "country shared");
  assert.deepEqual(app.lastShared().focus, []);
  assertHealthy(app);
});

test("graph: shares its centre, type chips, selected spoke and the records behind the link", async (t) => {
  const app = await mount(t, "get_entity_graph", { canShare: true });
  const d = await payload("get_entity_graph", { seed: "person:100" });
  app.show(d);
  assertHealthy(app);
  const seed = d.nodes.find((n) => n.id === "person:100");
  assert.deepEqual(app.lastShared().focus, [{ title: seed.label, id: seed.id, type: seed.type, relation: "graph centre", amira_url: seed.amira_url }]);
  assert.deepEqual(app.lastShared().filters, {});

  app.click(app.root.querySelector('.chips button[data-types="person"]'));
  await app.waitFor(() => app.lastShared().filters?.types?.[0] === "person", "type filter shared");
  const filtered = await payload("get_entity_graph", { seed: "person:100", types: ["person"] });

  const spoke = app.root.querySelector("g.node-link");
  const neighbour = filtered.nodes.find((n) => n.id === spoke.getAttribute("data-pick"));
  app.click(spoke.querySelector("text.label"));
  await app.waitFor(() => app.lastShared().records?.length > 0, "evidence shared");
  const shared = app.lastShared();
  assert.deepEqual(shared.focus.slice(0, 2).map((f) => [f.id, f.relation]), [["person:100", "graph centre"], [neighbour.id, "selected neighbour"]]);
  assert.equal(shared.focus[1].amira_url, neighbour.amira_url);
  assert.equal(shared.focus[2].type, "link");
  const edge = filtered.edges.find((e) => e.id === shared.focus[2].id);
  assert.ok(edge, "the link is one of the returned edges");
  const evidence = await payload("get_entity_graph", { seed: "person:100", edge_id: edge.id, snapshot_id: filtered.snapshot_id, offset: 0 });
  assert.deepEqual(shared.records.map((r) => r.amira_url), evidence.results.map((r) => r.amira_url));
  assert.equal(app.root.querySelector("#ask-selection"), null, "no Ask button without the message capability");
  assertHealthy(app);
});
