// MCP App views and private records (curator mode, #26): a private record has
// no amira_url, so a view must render its title as plain text, marked private,
// never as an empty citation link (`<a data-citation href="">`).
import test from "node:test";
import assert from "node:assert/strict";
import { payload, mount, text } from "../helpers/apps-harness.mjs";

/** The payload with `pick`'s rows turned into private records, as the curator decoration leaves them. */
function privatise(rows) {
  for (const r of rows) {
    delete r.amira_url;
    r.visibility = "private";
    r.admin_url = "https://amira.example/admin/item/1";
  }
}

const noEmptyLinks = (app) => {
  assert.deepEqual([...app.root.querySelectorAll("a")].filter((a) => !a.getAttribute("href")).map((a) => a.outerHTML), []);
};

test("bibliography: a private publication is plain text marked private", async (t) => {
  const app = await mount(t, "search_publications");
  const d = await payload("search_publications", {});
  assert.ok(d.results.length > 1);
  privatise(d.results.slice(0, 1));
  app.show(d);
  noEmptyLinks(app);
  const cell = [...app.root.querySelectorAll("tbody tr")][0].querySelectorAll("td")[1];
  assert.ok(!cell.querySelector("a[data-citation]"), "no citation link");
  assert.match(text(cell), new RegExp(`^${d.results[0].title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(private\\)`));
  assert.equal(app.root.querySelectorAll("a[data-citation]").length, d.results.length - 1, "public rows keep their links");
});

test("related: a private publication of the evidence list is plain text marked private", async (t) => {
  const app = await mount(t, "find_related");
  const d = await payload("find_related", { entity_type: "subject", value: "Architecture" });
  assert.ok(d.related_publications.length > 0);
  privatise(d.related_publications);
  app.show(d);
  noEmptyLinks(app);
  const items = [...app.root.querySelectorAll("li")].filter((li) => text(li).includes("(private)"));
  assert.equal(items.length, d.related_publications.length);
});

test("graph: private evidence records are plain text, never an empty link", async (t) => {
  const app = await mount(t, "get_entity_graph");
  const resolved = await payload("resolve_entity", { query: "Beier" });
  const seed = resolved.results[0].id;
  const d = await payload("get_entity_graph", { seed });
  privatise(d.nodes);
  app.show(d);
  noEmptyLinks(app);
  // The evidence list renders through the shared citation helper.
  const edge = d.edges.find((e) => e.count > 0);
  const original = app.win.__amiraHost.callTool;
  app.win.__amiraHost.callTool = async (name, args) => {
    const out = await original(name, args);
    if (name === "get_entity_graph" && args.edge_id) privatise(out.results);
    return out;
  };
  app.click(app.root.querySelector(`tbody button[data-edge="${edge.id}"]`));
  await app.waitFor(() => app.root.querySelector("#evidence li"), "edge evidence");
  noEmptyLinks(app);
  assert.ok(!app.root.querySelector("#evidence a[data-citation]"));
  assert.match(text(app.root.querySelector("#evidence li")), / \(private\) /);
});
