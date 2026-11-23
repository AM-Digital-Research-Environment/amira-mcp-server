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

// --- stale selections, uncommitted filters, request order (#51) -----------------

/** Hold the host's answers to calls that `match`, until the returned `release` runs. */
function holdCalls(app, match) {
  const host = app.win.__amiraHost, original = host.callTool;
  const held = [];
  host.callTool = (name, args) => {
    if (!match(name, args)) return original.call(host, name, args);
    return new Promise((resolve, reject) => held.push({ run: () => original.call(host, name, args).then(resolve, reject) }));
  };
  return { held, release: (i) => held[i].run(), restore: () => { host.callTool = original; } };
}

test("graph: picking a neighbour never shares the previous neighbour's records", async (t) => {
  const app = await mount(t, "get_entity_graph", { canShare: true });
  app.show(await payload("get_entity_graph", { seed: "person:100" }));
  const spokes = [...app.root.querySelectorAll("g.node-link")];
  assert.ok(spokes.length >= 2, "two neighbours to pick");
  app.click(spokes[0].querySelector("text.label"));
  await app.waitFor(() => app.lastShared().records?.length > 0, "first evidence shared");

  const gate = holdCalls(app, (name, args) => name === "get_entity_graph" && args.edge_id);
  t.after(gate.restore);
  app.click(spokes[1].querySelector("text.label"));
  const shared = app.lastShared();
  assert.equal(shared.focus[1].id, spokes[1].getAttribute("data-pick"));
  assert.deepEqual(shared.records, [], "nothing listed while the new records load");
  assert.equal(app.root.querySelector("#evidence").textContent, "", "the old records are cleared");
  assertHealthy(app);
});

test("graph: a failed type filter is not committed; a filter that hides the selected neighbour unselects it", async (t) => {
  const app = await mount(t, "get_entity_graph", { canShare: true });
  const d = await payload("get_entity_graph", { seed: "person:100" });
  app.show(d);
  const host = app.win.__amiraHost, original = host.callTool;
  let refused = 0;
  host.callTool = async (name, args) => {
    if (args.types) { refused++; throw new Error("The request failed. Try again."); }
    return original.call(host, name, args);
  };
  app.click(app.root.querySelector('.chips button[data-types="person"]'));
  await app.waitFor(() => refused === 1, "filter requested");
  host.callTool = original;
  // Re-centring on a neighbour afterwards loads it unfiltered: the failed filter never took effect.
  app.click(app.root.querySelector("tbody button[data-node]"));
  await app.waitFor(() => app.calls.some((c) => c.name === "get_entity_graph"), "re-centred");
  assert.equal(app.calls.at(-1).args.types, undefined);

  // Select a non-person neighbour, then filter to people: it is unselected and the selection re-shared.
  const fresh = await mount(t, "get_entity_graph", { canShare: true });
  fresh.show(d);
  const other = d.nodes.find((n) => n.id !== d.seed && n.type !== "person");
  const spoke = fresh.root.querySelector(`g.node-link[data-pick="${other.id}"]`);
  fresh.click(spoke.querySelector("text.label"));
  await fresh.waitFor(() => fresh.lastShared().focus?.[1]?.id === other.id, "neighbour selected");
  fresh.show(await payload("get_entity_graph", { seed: "person:100", types: ["person"] }));
  assert.equal(fresh.lastShared().focus.length, 1, "only the centre remains");
  assert.deepEqual(fresh.lastShared().records, []);
});

test("bibliography: a slow earlier search cannot overwrite a newer one, and a failed one keeps the filters", async (t) => {
  const app = await mount(t, "search_publications", { canShare: true });
  app.show(await payload("search_publications"));
  const gate = holdCalls(app, (name, args) => name === "search_publications" && args.keyword === "Decolonial");
  t.after(gate.restore);
  const form = app.root.querySelector("#publication-search");
  form.querySelector('input[name="keyword"]').value = "Decolonial";
  app.submit(form);
  await app.waitFor(() => gate.held.length === 1, "first search held");
  form.querySelector('input[name="keyword"]').value = "Migration";
  app.submit(form);
  await app.waitFor(() => app.lastShared().filters?.keyword === "Migration", "second search shown");
  gate.release(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.lastShared().filters.keyword, "Migration", "the late answer is dropped");
  assert.equal(app.root.querySelector('input[name="keyword"]').value, "Migration");

  const host = app.win.__amiraHost, original = host.callTool;
  host.callTool = async () => { throw new Error("The request failed. Try again."); };
  app.root.querySelector('input[name="keyword"]').value = "Nothing";
  app.submit(app.root.querySelector("#publication-search"));
  await new Promise((resolve) => setTimeout(resolve, 30));
  host.callTool = original;
  app.click(app.root.querySelector("#next") ?? app.root.querySelector("#clear-selection"));
  assert.equal(app.lastShared().filters.keyword, "Migration", "the failed filter was never committed");
});

test("a search still loading when the host switches the frame to another view neither renders nor saves", async (t) => {
  // Shape routing, so one frame takes both a bibliography and a map result.
  const app = await mount(t, "search_publications", { toolInfo: false, canShare: true });
  app.show(await payload("search_publications"), { instance: "bibliography" });
  const gate = holdCalls(app, (name, args) => name === "search_publications" && args.keyword === "Decolonial");
  t.after(gate.restore);
  const form = app.root.querySelector("#publication-search");
  form.querySelector('input[name="keyword"]').value = "Decolonial";
  app.submit(form);
  await app.waitFor(() => gate.held.length === 1, "search held");

  app.show(await payload("list_locations"), { instance: "map" });
  assert.equal(app.root.dataset.view, "map");
  const heading = app.root.querySelector("h1").textContent, saves = app.saves, shared = app.shared.length;
  const mapState = app.storage.get("map");
  gate.release(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.root.dataset.view, "map", "the map stays on screen");
  assert.equal(app.root.querySelector("h1").textContent, heading);
  assert.equal(app.saves, saves, "nothing saved by the late answer");
  assert.equal(app.storage.get("map"), mapState, "the map's saved state is untouched");
  assert.equal(app.shared.length, shared, "no bibliography selection shared over the map");
  assertHealthy(app);
});

test("graph: candidates for a name still resolving when a new graph arrives are dropped", async (t) => {
  const app = await mount(t, "get_entity_graph");
  app.show(await payload("get_entity_graph", { seed: "person:100" }));
  const gate = holdCalls(app, (name) => name === "resolve_entity");
  t.after(gate.restore);
  const form = app.root.querySelector("#resolve");
  form.querySelector('input[name="query"]').value = "Okafor";
  app.submit(form);
  await app.waitFor(() => gate.held.length === 1, "lookup held");
  app.show(await payload("get_entity_graph", { seed: "person:100", types: ["person"] }));
  gate.release(0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.root.querySelector("#candidates").innerHTML, "", "the new graph shows no stale candidates");
  assertHealthy(app);
});

test("timeline: a bar outside the filtered years explains itself instead of sending an inverted range", async (t) => {
  const app = await mount(t, "list_years");
  const d = await payload("list_years", { bucket: "decade", filters: { year_from: 2000 } });
  // An item dated 1995–2005 counts in the 1990s bar too, although the filter starts in 2000.
  d.results.unshift({ decade: "1990s", from: 1990, to: 1999, item_count: 1 });
  app.show(d);
  const early = [...app.root.querySelectorAll("rect[data-year]")].find((r) => Number(r.getAttribute("data-year")) < 2000);
  assert.ok(early, "a ranged item draws a bar before the filter's first year");
  const before = app.calls.length;
  app.click(early);
  assert.equal(app.calls.slice(before).filter((c) => c.name === "search_research_items").length, 0);
  assert.match(app.root.querySelector("#timeline-evidence").textContent, /widen the year filter/);
  const late = [...app.root.querySelectorAll("rect[data-year]")].find((r) => Number(r.getAttribute("data-year")) >= 2000);
  app.click(late);
  await app.waitFor(() => app.calls.some((c) => c.name === "search_research_items"), "records requested");
  const args = app.calls.findLast((c) => c.name === "search_research_items").args;
  assert.ok(args.year_from <= args.year_to && args.year_from >= 2000);
  assertHealthy(app);
});
