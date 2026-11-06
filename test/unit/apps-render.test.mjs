// The MCP App page itself: one self-contained page, scoped CSS, the bridge API and the router. The page, the bridge stub and `mount` come
// from test/helpers/apps-harness.mjs, which explains how the views are run.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  lib, APP_PAGES, PAGE, APP_OF, VIEWS_JS, STUB_JS, STUB_API, payload, text, mount, assertHealthy,
} from "../helpers/apps-harness.mjs";

// --- the page -----------------------------------------------------------------

test("one MCP App page is served, and every app-rendering tool links to it", () => {
  assert.deepEqual([...APP_PAGES.keys()], [lib.APP_URI]);
  assert.deepEqual(Object.fromEntries([...APP_OF].sort()),
    Object.fromEntries(Object.keys(lib.VIEW_OF_TOOL).sort().map((tool) => [tool, lib.APP_URI])));
});

test("the app page is self-contained: no external script, stylesheet or other fetched resource", async (t) => {
  const win = new Window(); // JS evaluation stays off: static markup only
  t.after(() => win.happyDOM.close());
  win.document.write(PAGE);
  const doc = win.document;
  assert.deepEqual([...doc.querySelectorAll("script[src], link[href], img[src], iframe, object, embed, source[src]")]
    .map((el) => el.outerHTML.slice(0, 80)), []);
  const scripts = [...doc.querySelectorAll("script")];
  assert.deepEqual(scripts.map((s) => s.getAttribute("type")), ["application/gzip", null], "inert gzip data, then the bootstrap");
  assert.doesNotMatch(scripts[1].textContent, /\b(?:fetch|import|eval|Function|XMLHttpRequest)\s*\(|createObjectURL/,
    "the bootstrap fetches and evaluates nothing");
  for (const style of doc.querySelectorAll("style")) {
    assert.doesNotMatch(style.textContent, /@import|url\(/i, "CSS loads nothing");
  }
  assert.doesNotMatch(PAGE, /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
});

test("view CSS is scoped to its view, so one view's table widths cannot reach another's", () => {
  const css = /<style>([\s\S]*?)<\/style>/.exec(PAGE)[1];
  for (const scoped of ['[data-view="map"] table { table-layout: fixed; }', '[data-view="map"] th:nth-child(1) { width: 32%; }',
    '[data-view="bibliography"] th:first-child { width: 50px; }', '[data-view="graph"] th:last-child { width: 100px; }',
    '@media (max-width: 480px) { [data-view="graph"] .graph { overflow-x: auto; }']) {
    assert.ok(css.includes(scoped), scoped);
  }
  // Every rule after the shared theme belongs to one view.
  const views = css.slice(css.indexOf('[data-view="'));
  for (const prelude of views.split("}").map((r) => r.split("{")[0].trim()).filter((p) => p && !p.startsWith("@"))) {
    for (const selector of prelude.split(",")) assert.match(selector.trim(), /^\[data-view="[a-z]+"\] /, prelude);
  }
  assert.equal(lib.scopeCss('[data-view="x"]', "/* note */ a, b:hover { c: d; } @media (x) { e { f: g; } }"),
    '[data-view="x"] a, [data-view="x"] b:hover { c: d; }\n@media (x) { [data-view="x"] e { f: g; }\n }\n');
});

test("the stub exposes exactly the real bridge's API, with the same escaping", async (t) => {
  const win = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  t.after(() => win.happyDOM.close());
  const errors = [];
  win.addEventListener("error", (event) => errors.push(event.error ?? event.message));
  win.document.write(`<!doctype html><html><body><p id="app-status"></p><script>${lib.BRIDGE_JS}</script></body></html>`);
  await win.happyDOM.waitUntilComplete();
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(win.amiraApp).sort(), STUB_API);
  // The views' typecheck declares the bridge by hand (src/ui/views/globals.d.ts): same members.
  const { readFileSync } = await import("node:fs");
  const declared = /interface AmiraApp \{([\s\S]*?)\n\}/.exec(readFileSync(new URL("../../src/ui/views/globals.d.ts", import.meta.url), "utf8"))[1];
  assert.deepEqual([...declared.matchAll(/^ {2}(\w+)\(/gm)].map((m) => m[1]).sort(), STUB_API);

  const stubWin = new Window({ settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  t.after(() => stubWin.happyDOM.close());
  stubWin.__amiraHost = {};
  stubWin.document.write(`<!doctype html><html><body><script>${STUB_JS}</script></body></html>`);
  await stubWin.happyDOM.waitUntilComplete();
  assert.deepEqual(Object.keys(stubWin.amiraApp).sort(), STUB_API);
  for (const sample of [`<a href="x">'&'</a>`, null, undefined, 0, "Côte d’Ivoire & co"]) {
    assert.equal(stubWin.amiraApp.esc(sample), win.amiraApp.esc(sample));
  }

  // Every bridge member the views script touches exists on the stub.
  const used = new Set([...VIEWS_JS.matchAll(/\b(?:api|amiraApp)\.(\w+)/g)].map((m) => m[1]));
  for (const member of used) assert.ok(STUB_API.includes(member), `the views use amiraApp.${member}`);
  for (const member of ["shareSelection", "canAsk", "canShare", "toolName", "callTool"]) assert.ok(used.has(member), member);
});

test("the router picks each view from toolInfo, and from the result's shape when a host sends none", async (t) => {
  const samples = {
    get_collection_overview: {}, list_years: {}, list_research_sections: {}, find_related: { entity_type: "subject", value: "Architecture" },
    get_entity_graph: { seed: "person:100" }, list_locations: {}, search_publications: {},
  };
  for (const toolInfo of [true, false]) {
    for (const [tool, args] of Object.entries(samples)) {
      const app = await mount(t, tool, { toolInfo });
      app.show(await payload(tool, args));
      assertHealthy(app);
      assert.equal(app.root.dataset.view, lib.VIEW_OF_TOOL[tool], `${tool} (toolInfo ${toolInfo})`);
      assert.match(app.doc.title, /^AMIRA — /);
    }
  }
  // Empty results keep their shape too.
  for (const [tool, args, view] of [["search_publications", { keyword: "zzz-none" }, "bibliography"],
    ["list_locations", { country: "Atlantis" }, "map"], ["list_years", { from: 1800, to: 1801 }, "timeline"],
    ["list_research_sections", {}, "sections"]]) {
    const app = await mount(t, tool, { toolInfo: false });
    const d = await payload(tool, args);
    app.show(tool === "list_research_sections" ? { ...d, results: [], count: 0 } : d);
    assert.equal(app.root.dataset.view, view, `empty ${tool}`);
  }
  const app = await mount(t, "list_years", { toolInfo: false });
  app.show({ something: "else" });
  assert.equal(text(app.root.querySelector(".empty")),
    "This result has no AMIRA view. Update the AMIRA extension to see it here; the answer in the conversation is unaffected.");
  assert.equal(app.root.dataset.view, undefined);
});
