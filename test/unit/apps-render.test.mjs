// Execute the seven MCP App views for real. They share one page,
// ui://amira/app.html, whose script (the bridge, then the views and their
// router) ships gzip-compressed inside it, so no coverage tool and no other
// test ever ran the views. Here the page is read over MCP (resources/read),
// its script decoded, the bridge swapped for a stub with the same API, and the
// page loaded into happy-dom with script execution on. The router's onResult
// callback is then fed REAL tool payloads from the in-process server over the
// fixture snapshot, and the stub's callTool answers from the same server, so
// the interactive paths (evidence lists, filters, exports, the selection the
// views share with the model) run end to end too.
//
// The fixture gets two extra publications, each the only record carrying its
// subject: find_related on such a subject matches publications and no
// research item — the state the related hub once misreported as "Nothing
// co-occurs".
import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { Window } from "happy-dom";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

// --- fixture: the shared one plus two publication-only subjects ---------------

const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const pubTemplate = fixture.data.publications.find((p) => p.o_id === 511);
fixture.data.publications.push(
  {
    ...structuredClone(pubTemplate),
    o_id: 512,
    pub_id: "eref-512",
    title: "Oral Literature Archives in Practice",
    date: "2019",
    year: 2019,
    authors: [{ label: "Okafor, Ngozi", o_id: null }],
    subjects: [{ label: "Oral Literature", o_id: 603 }],
    places_of_publication: [],
    urls: ["https://eref.uni-bayreuth.de/id/eprint/512/"],
  },
  {
    ...structuredClone(pubTemplate),
    o_id: 513,
    pub_id: "eref-513",
    title: "Ritual Archives Without Authors",
    date: "2018",
    year: 2018,
    authors: [],
    subjects: [{ label: "Ritual Archives", o_id: 604 }],
    places_of_publication: [],
    urls: ["https://eref.uni-bayreuth.de/id/eprint/513/"],
  },
);
fixture.data.subjects.push(
  { o_id: 603, name: "Oral Literature", vocabulary: "Tag", uri: null },
  { o_id: 604, name: "Ritual Archives", vocabulary: "Tag", uri: null },
);
fixture.manifest.counts = Object.fromEntries(Object.entries(fixture.data).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "apps-render" });
test.after(() => conn.close());

// --- the page, read the way a host reads it ----------------------------------

const APP_MIME = "text/html;profile=mcp-app";
const { resources } = await conn.client.listResources();
const APP_PAGES = new Map();
for (const r of resources.filter((r) => r.mimeType === APP_MIME)) {
  const read = await conn.client.readResource({ uri: r.uri });
  assert.equal(read.contents.length, 1, r.uri);
  APP_PAGES.set(r.uri, read.contents[0].text);
}
const PAGE = APP_PAGES.get(lib.APP_URI);
assert.ok(PAGE, `${lib.APP_URI} is served`);

/** tool name -> ui:// URI, from the tool's own `_meta.ui.resourceUri`. */
const { tools } = await conn.client.listTools();
const APP_OF = new Map(tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => [t.name, t._meta.ui.resourceUri]));

/** The page's two scripts: the gzip data element and the bootstrap that expands it. */
const BUNDLE = /<script id="amira-app-bundle" type="application\/gzip">([A-Za-z0-9+/=]+)<\/script>\n<script>([\s\S]*?)<\/script>/.exec(PAGE);
assert.ok(BUNDLE, "the page carries a gzip bundle and its bootstrap");
const DECODED = gunzipSync(Buffer.from(BUNDLE[1], "base64")).toString("utf8");
assert.ok(DECODED.startsWith(`${lib.BRIDGE_JS}\n`), "the decoded script starts with the bridge");
/** Everything after the bridge: shared helpers, the seven views, the router. */
const VIEWS_JS = DECODED.slice(lib.BRIDGE_JS.length + 1);

/** The bridge's callTool allowlist, read from the shipped bundle so the stub
 * refuses exactly what the real bridge refuses. */
const allowlist = lib.BRIDGE_JS.match(/new Set\(\[([^\]]*"get_entity_graph"[^\]]*)\]\)/);
assert.ok(allowlist, "BRIDGE_JS carries a callTool allowlist");
const BRIDGE_TOOLS = new Set(JSON.parse(`[${allowlist[1]}]`));

// --- the bridge stub ----------------------------------------------------------

/** Same surface as src/ui/bridge.ts; every host-facing call goes to the test. */
const STUB_JS = String.raw`(function () {
  var host = window.__amiraHost;
  var map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  window.amiraApp = {
    esc: function (value) { return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) { return map[c]; }); },
    onResult: function (callback) { host.onResult(callback); },
    input: function () { return {}; },
    toolName: function () { return host.toolName; },
    shareSelection: function (selection) { host.share(JSON.stringify(selection)); },
    canShare: function () { return !!host.canShare; },
    canAsk: function () { return !!host.canAsk; },
    ask: function () { return host.ask(); },
    callTool: function (name, args) { return host.callTool(name, args); },
    openLink: function (url) { return host.openLink(url); },
    download: function (text, extension) { return host.download(text, extension); },
    status: function (message) { var el = document.getElementById("app-status"); if (el) el.textContent = message; },
  };
})();`;
const STUB_API = ["ask", "callTool", "canAsk", "canShare", "download", "esc", "input", "onResult", "openLink", "shareSelection", "status", "toolName"];

/** The bridge's own result unwrapping (src/ui/bridge.ts `payload`). */
function payloadOf(result) {
  let value = result.structuredContent;
  if (!value) {
    const text = result.content?.find((c) => c.type === "text");
    if (text) try { value = JSON.parse(text.text); } catch { /* reported below */ }
  }
  if (result.isError || value?.error) throw new Error(String(value?.error?.message ?? "The request failed. Try again."));
  if (!value || typeof value !== "object") throw new Error("The host returned no usable data. Run the tool again.");
  return value;
}
const payload = async (name, args = {}) => payloadOf(await conn.raw(name, args));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (el) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const rows = (scope, selector = "tbody tr") =>
  [...scope.querySelectorAll(selector)].map((tr) => [...tr.querySelectorAll("th, td")].map(text));
const citations = (scope) =>
  [...scope.querySelectorAll("a[data-citation]")].map((a) => ({ href: a.getAttribute("href"), title: text(a) }));
/** A select's options as [value, text] pairs. */
const options = (select) => [...select.options].map((o) => [o.value, text(o)]);
/** The most recent call the page made to one tool, ignoring background option loads to others. */
const lastCall = (app, name) => app.calls.findLast((c) => c.name === name);
const AMIRA_URL = /^https:\/\/data\.africamultiple\.uni-bayreuth\.de\/s\/amira\/item\/\d+$/;

/**
 * Load the app page with the stub in place of the bridge, as `tool`'s result
 * would open it (`host.toolName` stands in for the host's toolInfo; pass
 * `toolInfo: false` for a host that sends none). Returns the window, the
 * router's render callback (as `show`), and logs of everything the page asked
 * of its host, the selections it shared included. `show` hands the app a
 * structured clone, as postMessage would.
 */
async function mount(t, tool, { toolInfo = true, canAsk = false, canShare = false } = {}) {
  const uri = APP_OF.get(tool);
  assert.equal(uri, lib.APP_URI, `${tool} declares the app`);
  const html = PAGE.slice(0, BUNDLE.index) + `<script>${STUB_JS}</script>\n<script>${VIEWS_JS}</script>\n</body>\n</html>\n`;

  const requests = [];
  const win = new Window({
    url: "https://amira-app.test/",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
      fetch: {
        interceptor: {
          beforeAsyncRequest: async ({ request }) => {
            requests.push(request.url);
            return new win.Response("", { status: 451 });
          },
        },
      },
    },
  });
  const app = { win, uri, requests, errors: [], calls: [], downloads: [], shared: [], asked: 0, render: null };
  win.__amiraHost = {
    toolName: toolInfo ? tool : undefined,
    canAsk,
    canShare,
    // Parsed on the test's side, so its arrays compare with deepStrictEqual.
    share: (json) => { app.shared.push(JSON.parse(json)); },
    onResult: (callback) => { app.render = callback; },
    async callTool(name, args) {
      const plain = JSON.parse(JSON.stringify(args ?? {})); // postMessage drops undefined
      app.calls.push({ name, args: plain });
      if (!BRIDGE_TOOLS.has(name)) throw new Error("This tool is not available in the app.");
      return structuredClone(await payload(name, plain));
    },
    async ask() { app.asked++; },
    openLink: async () => {},
    download: async (contents, extension) => { app.downloads.push({ text: contents, extension }); },
  };
  win.addEventListener("error", (event) => app.errors.push(event.error ?? event.message));
  t.after(() => win.happyDOM.close());

  win.document.write(html);
  await win.happyDOM.waitUntilComplete();
  assert.deepEqual(app.errors, [], `${tool}: the page loads without errors`);
  assert.equal(typeof app.render, "function", `${tool}: the router registers onResult`);

  app.doc = win.document;
  app.root = win.document.getElementById("root");
  app.status = () => text(win.document.getElementById("app-status"));
  app.show = (value) => app.render(structuredClone(value));
  app.lastShared = () => app.shared.at(-1);
  app.waitFor = async (predicate, what, ms = 2_000) => {
    for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(5)) {
      if (predicate()) return;
    }
    assert.fail(`timed out waiting for ${what}; calls: ${JSON.stringify(app.calls)}`);
  };
  app.click = (el) => el.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true }));
  app.submit = (form) => form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
  return app;
}

/** Invariants every rendered state must hold. */
function assertHealthy(app) {
  assert.deepEqual(app.errors, [], "no window errors");
  assert.deepEqual(app.requests, [], "no network requests");
  for (const call of app.calls) assert.ok(BRIDGE_TOOLS.has(call.name), `${call.name} is on the bridge allowlist`);
  assert.ok(!text(app.root).includes("Waiting for research data"), "placeholder replaced");
  assert.doesNotMatch(app.root.innerHTML, /\bNaN\b|\bundefined\b|\bInfinity\b|\[object Object\]/);
  for (const link of citations(app.root)) assert.match(link.href, AMIRA_URL);
}

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

// --- overview -----------------------------------------------------------------

test("overview: stat tiles and every breakdown match get_collection_overview", async (t) => {
  const app = await mount(t, "get_collection_overview");
  const d = await payload("get_collection_overview");
  app.show(d);
  assertHealthy(app);

  assert.equal(text(app.root.querySelector("h1")), d.collection_name);
  const c = d.counts;
  const tiles = Object.fromEntries([...app.root.querySelectorAll(".tile")].map((tile) => [text(tile.querySelector(".k")), text(tile.querySelector(".n"))]));
  const n = (v) => v.toLocaleString("en");
  assert.deepEqual(tiles, {
    "research items": n(c.research_items), projects: n(c.projects), people: n(c.persons), institutions: n(c.institutions),
    publications: n(c.publications), videos: n(c.youtube_videos), "podcast episodes": n(c.podcasts), journals: n(c.journals),
  });
  const subs = [...app.root.querySelectorAll(".tile .sub2")].map(text);
  assert.deepEqual(subs, [
    `${c.publications_with_fulltext} of ${c.publications} with text`,
    `${c.videos_with_transcript} of ${c.youtube_videos} with text`,
    `${c.podcasts_with_transcript} of ${c.podcasts} with text`,
  ]);
  assert.match(text(app.root.querySelector(".sub")), new RegExp(`Content dates span ${d.content_date_range.earliest}–${d.content_date_range.latest}\\.`));

  const panels = Object.fromEntries([...app.root.querySelectorAll(".panel")].map((p) => [text(p.querySelector("h2")), p]));
  assert.deepEqual(Object.keys(panels), ["Items by university", "Items by research section", "Items by resource type", "Items by language"]);
  const sorted = (map) => Object.entries(map).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, String(v)]);
  assert.deepEqual(rows(panels["Items by research section"]), sorted(d.items_by_research_section));
  assert.deepEqual(rows(panels["Items by resource type"]), sorted(d.items_by_resource_type));
  assert.deepEqual(rows(panels["Items by language"]), sorted(d.items_by_language));
  // University labels are shortened for the axis; the values are not.
  assert.deepEqual(rows(panels["Items by university"]).map((r) => r[1]), sorted(d.items_by_university).map((r) => r[1]));
  for (const panel of Object.values(panels)) {
    const values = rows(panel).map((r) => r[1]);
    assert.equal(panel.querySelectorAll("rect.bar").length, values.length);
    assert.deepEqual([...panel.querySelectorAll("text.val")].map(text), values);
  }
  assert.equal(app.root.querySelectorAll("a[data-citation]").length, 0, "the overview carries no record links");
});

test("overview: restricted exposure keeps the tiles and explains the withheld breakdowns", async (t) => {
  const app = await mount(t, "get_collection_overview");
  process.env.AMIRA_EXPOSURE = "descriptive"; // read per call (src/exposure.ts)
  let d;
  try { d = await payload("get_collection_overview"); } finally { delete process.env.AMIRA_EXPOSURE; }
  assert.equal(d.metadata_exposure, "descriptive");
  app.show(d);
  assertHealthy(app);
  assert.match(text(app.root.querySelector(".sub")), /Metadata exposure is limited to 'descriptive', so some breakdowns are withheld\./);
  assert.equal(app.root.querySelectorAll(".tile").length, 8);
  assert.deepEqual([...app.root.querySelectorAll(".panel h2")].map(text), ["Items by resource type"]);

  // A snapshot with no breakdowns at all gets a sentence, not a blank grid.
  app.show({ ...d, items_by_resource_type: {} });
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "No breakdowns available at this metadata-exposure level.");
});

// --- timeline -----------------------------------------------------------------

test("timeline: bars, table and counts match list_years; a year opens cited evidence", async (t) => {
  const app = await mount(t, "list_years");
  const d = await payload("list_years");
  app.show(d);
  assertHealthy(app);

  assert.equal(text(app.root.querySelector("h1")), "AMIRA — research items per year");
  assert.equal(text(app.root.querySelector(".sub")),
    `${d.dated_items} dated items spanning ${d.year_range.min}–${d.year_range.max} · ${d.undated_items} undated`);
  const byYear = [...d.results].sort((a, b) => a.year - b.year);
  assert.deepEqual([...app.root.querySelectorAll("rect.bar title")].map(text),
    byYear.map((r) => `${r.year}: ${r.item_count} ${r.item_count === 1 ? "item" : "items"}`));
  assert.deepEqual(rows(app.root.querySelector("details")), byYear.map((r) => [String(r.year), String(r.item_count)]));
  assert.match(text(app.root), new RegExp(`Showing ${d.results.length} of ${d.total_matches} buckets\\.`));

  // Click a table row: the evidence list is a real search_research_items page.
  app.click(app.root.querySelector('button[data-year="2013"]'));
  await app.waitFor(() => app.root.querySelector("#timeline-evidence h2"), "2013 evidence");
  const evidence = await payload("search_research_items", { year_from: 2013, year_to: 2013, offset: 0, limit: 20 });
  assert.deepEqual(lastCall(app, "search_research_items"), { name: "search_research_items", args: { year_from: 2013, year_to: 2013, offset: 0, limit: 20 } });
  assert.equal(text(app.root.querySelector("#timeline-evidence h2")), `2013–2013 · ${evidence.total_matches} matching records`);
  assert.deepEqual(citations(app.root.querySelector("#timeline-evidence")), evidence.results.map((r) => ({ href: r.amira_url, title: r.title })));
  assert.ok(evidence.results.length > 0);

  // Keyboard path on a bar (Enter re-dispatches as a click).
  app.root.querySelector('rect[data-year="1960"]').dispatchEvent(new app.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  await app.waitFor(() => /^1960–1960/.test(text(app.root.querySelector("#timeline-evidence h2"))), "1960 evidence");
  const e1960 = await payload("search_research_items", { year_from: 1960, year_to: 1960, offset: 0, limit: 20 });
  assert.deepEqual(citations(app.root.querySelector("#timeline-evidence")), e1960.results.map((r) => ({ href: r.amira_url, title: r.title })));
  assertHealthy(app);
});

test("timeline: decade buckets, the subject filter form, and the empty range", async (t) => {
  const app = await mount(t, "list_years");
  const d = await payload("list_years", { bucket: "decade" });
  app.show(d);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector("h1")), "AMIRA — research items per decade");
  assert.deepEqual(rows(app.root.querySelector("details")), d.results.map((r) => [r.decade, String(r.item_count)]));

  // Filter by subject through the form; the re-render comes from list_years.
  const form = app.root.querySelector("#timeline-filter");
  form.querySelector('input[name="subject"]').value = "Islam";
  app.submit(form);
  await app.waitFor(() => app.calls.some((c) => c.name === "list_years"), "filtered list_years");
  const call = app.calls.find((c) => c.name === "list_years");
  assert.equal(call.args.filters.subject, "Islam");
  await app.waitFor(() => !/undated/.test(text(app.root.querySelector(".sub"))), "filtered render");
  const filtered = await payload("list_years", call.args);
  assert.equal(text(app.root.querySelector(".sub")), `${filtered.dated_items} dated items spanning ${filtered.year_range.min}–${filtered.year_range.max}`);
  assert.equal(app.root.querySelector('input[name="subject"]').value, "Islam");
  assertHealthy(app);

  // A range with no dated items says so and offers a way back.
  const empty = await payload("list_years", { from: 1800, to: 1801 });
  assert.equal(empty.results.length, 0);
  app.show(empty);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "No dated items in this range.");
  app.click(app.root.querySelector("#reset-range"));
  await app.waitFor(() => text(app.root.querySelector("h1")).endsWith("per decade") && app.root.querySelector("svg"), "reset to decades");
  assert.deepEqual(lastCall(app, "list_years"), { name: "list_years", args: { bucket: "decade", limit: 200 } });
  assertHealthy(app);
});

test("timeline: projects are a dropdown and subjects are suggestions, both loaded by the app", async (t) => {
  const app = await mount(t, "list_years");
  const projects = (await payload("search_projects", { limit: 100, offset: 0 })).results.filter((p) => p.item_count);
  assert.ok(projects.length > 0, "the fixture has projects with research items");
  const [named] = projects;
  // The model may pass a project by name; the dropdown resolves it to its id.
  app.show(await payload("list_years", { bucket: "decade", filters: { project_id: named.name } }));
  await app.waitFor(() => app.root.querySelector('select[name="project_id"]') && app.root.querySelector("#subject-options option"), "project and subject lists");
  const select = app.root.querySelector('select[name="project_id"]');
  assert.deepEqual(options(select), [["", "All projects"],
    ...projects.sort((a, b) => a.name.localeCompare(b.name)).map((p) => [p.id, `${p.name} (${p.item_count})`])]);
  assert.equal(select.value, named.id);
  const subjects = await payload("list_subjects", { limit: 300, offset: 0 });
  assert.equal(app.root.querySelector('input[name="subject"]').getAttribute("list"), "subject-options");
  assert.deepEqual([...app.root.querySelectorAll("#subject-options option")].map((o) => o.value), subjects.results.map((r) => r.subject));

  // Submitting filters by the chosen project's id.
  app.submit(app.root.querySelector("#timeline-filter"));
  await app.waitFor(() => lastCall(app, "list_years")?.args.filters?.project_id === named.id, "project filter");
  await app.waitFor(() => app.root.querySelector('select[name="project_id"]')?.value === named.id, "re-rendered dropdown");
  assertHealthy(app);
});

// --- sections -----------------------------------------------------------------

test("sections: plotted spans, item counts and the value table match list_research_sections", async (t) => {
  const app = await mount(t, "list_research_sections");
  const d = await payload("list_research_sections");
  app.show(d);
  assertHealthy(app);

  const year = (s) => (s ? Number(String(s).slice(0, 4)) : null);
  const plotted = d.results.filter((r) => year(r.date?.start) && year(r.date?.end));
  const undated = d.results.filter((r) => !plotted.includes(r));
  assert.ok(plotted.length > 0 && undated.length > 0, "fixture exercises both");
  const sub = text(app.root.querySelector(".sub"));
  assert.ok(sub.startsWith(`${plotted.length} sections plotted`), sub);
  for (const r of undated) assert.ok(sub.includes(r.name), `${r.name} listed as unplotted`);

  assert.deepEqual([...app.root.querySelectorAll("rect.bar title")].map(text), plotted.map((r) =>
    `${r.name}: ${year(r.date.start)}–${year(r.date.end)} · ${r.project_count} projects · ${r.item_count} items`));
  assert.deepEqual([...app.root.querySelectorAll("text.val")].map(text), plotted.map((r) => String(r.item_count)));
  assert.deepEqual([...app.root.querySelectorAll("text.phase")].map(text), [...new Set(plotted.map((r) => r.funding_phase))]);
  assert.deepEqual(rows(app.root.querySelector("details")), d.results.map((r) =>
    [r.name, `${r.date.start ?? "Unknown"} – ${r.date.end ?? "Unknown"}`, String(r.project_count), String(r.item_count)]));

  app.show({ ...d, results: undated, count: undated.length });
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "No section carries a date range.");
  app.show({ ...d, results: [], count: 0 });
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "No sections returned.");
});

// --- related ------------------------------------------------------------------

/** Rows of every related_* list, in the app's sector order. */
const SECTORS = ["related_subjects", "related_people", "related_projects", "related_countries", "related_research_sections", "related_formats"];
const relatedRows = (d) => SECTORS.flatMap((k) => (d[k] ?? []).map((r) => [r.name, String(r.research_item_count), String(r.publication_count)]));

test("related: hub, counts, value table and publication citations match find_related", async (t) => {
  const app = await mount(t, "find_related");
  const d = await payload("find_related", { entity_type: "subject", value: "Architecture" });
  assert.ok(d.matched_items > 0 && d.matched_publications > 0);
  app.show(d);
  assertHealthy(app);

  assert.equal(text(app.root.querySelector("h1")), "What co-occurs with Architecture");
  assert.match(text(app.root.querySelector(".sub")),
    new RegExp(`^subject seed · ${d.matched_items} matching research items · ${d.matched_publications} publications\\.`));
  assert.equal(text(app.root.querySelector(".seedsub")), `${d.matched_items} items · ${d.matched_publications} pubs`);
  assert.deepEqual(rows(app.root.querySelector("details")), relatedRows(d));
  const spokes = SECTORS.flatMap((k) => (d[k] ?? []).slice(0, 4));
  assert.deepEqual([...app.root.querySelectorAll("line.spoke title")].map(text),
    spokes.map((r) => `${r.name}: ${r.count} shared record${r.count === 1 ? "" : "s"}`));
  assert.deepEqual(citations(app.root), d.related_publications.map((p) => ({ href: p.amira_url, title: p.title })));
  assert.ok(!app.root.querySelector(".empty"), "no empty message");
});

test("related: a seed that matches nothing gets the friendly empty message", async (t) => {
  const app = await mount(t, "find_related");
  const d = await payload("find_related", { entity_type: "subject", value: "zzz-no-such-subject" });
  assert.equal(d.matched_items, 0);
  assert.equal(d.matched_publications, 0);
  app.show(d);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "Nothing co-occurs with this seed in the collection.");
  assert.ok(!app.root.querySelector("svg"), "no hub drawn");
});

test("related: a publication-only seed renders its publications, not the empty message", async (t) => {
  const app = await mount(t, "find_related");
  for (const value of ["Oral Literature", "Ritual Archives"]) {
    const d = await payload("find_related", { entity_type: "subject", value });
    assert.equal(d.matched_items, 0, value);
    assert.equal(d.matched_publications, 1, value);
    app.show(d);
    assertHealthy(app);
    assert.ok(!app.root.querySelector(".empty"), `${value}: no "Nothing co-occurs"`);
    assert.doesNotMatch(text(app.root), /Nothing co-occurs/);
    assert.equal(text(app.root.querySelector("h1")), `What co-occurs with ${value}`);
    assert.match(text(app.root.querySelector(".sub")), /0 matching research items · 1 publications/);
    assert.ok(app.root.querySelector("svg circle.seed"), `${value}: hub drawn`);
    assert.deepEqual(citations(app.root), d.related_publications.map((p) => ({ href: p.amira_url, title: p.title })));
    assert.deepEqual(rows(app.root.querySelector("details")), relatedRows(d));
  }
  // "Oral Literature" has an author, so the PEOPLE sector carries a spoke.
  const withAuthor = await payload("find_related", { entity_type: "subject", value: "Oral Literature" });
  app.show(withAuthor);
  assert.deepEqual([...app.root.querySelectorAll("text.sector")].map(text), ["PEOPLE"]);
  assert.deepEqual([...app.root.querySelectorAll("line.spoke title")].map(text), ["Okafor, Ngozi: 1 shared record"]);
});

test("related: a location seed (no publication join) renders without a publications section", async (t) => {
  const app = await mount(t, "find_related");
  const d = await payload("find_related", { entity_type: "location", value: "Nigeria" });
  assert.equal(d.matched_publications, undefined);
  app.show(d);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".seedsub")), `${d.matched_items} items`);
  assert.doesNotMatch(text(app.root), /Publication evidence/);
  assert.deepEqual(rows(app.root.querySelector("details")), relatedRows(d));
});

// --- graph --------------------------------------------------------------------

/** The graph's spoke weights: a neighbour's strongest link and its edges, strongest first. */
function graphWeights(d) {
  const far = (e) => (e.source === d.seed ? e.target : e.source);
  const weights = new Map();
  for (const e of d.edges) {
    const w = weights.get(far(e)) ?? { count: 0, edges: [] };
    w.count = Math.max(w.count, e.count); w.edges.push(e);
    weights.set(far(e), w);
  }
  return weights;
}
const clipLabel = (s) => (s.length <= 24 ? s : `${s.slice(0, 23).trimEnd()}…`);

test("graph: sectors, edges and evidence citations match get_entity_graph", async (t) => {
  const app = await mount(t, "get_entity_graph");
  const resolved = await payload("resolve_entity", { query: "Beier" });
  const seed = resolved.results[0].id;
  const d = await payload("get_entity_graph", { seed });
  app.show(d);
  assertHealthy(app);

  const nodes = new Map(d.nodes.map((n) => [n.id, n]));
  assert.equal(text(app.root.querySelector("h1")), nodes.get(seed).label);
  assert.equal(text(app.root.querySelector(".sub")),
    `One-hop relationships · ${d.edges.length} of ${d.total_edges} edges${d.truncated ? " · bounded view" : ""}`);
  // Every spoke is a returned neighbour, labelled with its strongest link's count.
  const weights = graphWeights(d);
  const spokes = [...app.root.querySelectorAll("g.node-link")];
  assert.ok(spokes.length > 0 && spokes.length <= Math.min(16, weights.size));
  for (const g of spokes) {
    const node = nodes.get(g.getAttribute("data-pick"));
    assert.ok(node && node.id !== seed, "a spoke is a neighbour");
    assert.equal(text(g.querySelector("text.label")), `${clipLabel(node.label)} · ${weights.get(node.id).count}`);
  }
  assert.ok(app.root.querySelectorAll("text.sector").length >= 1, "sectors carry headings");
  assert.match(text(app.root.querySelector(".graph + .note")), new RegExp(`^Showing ${spokes.length} of ${weights.size} returned neighbours`));
  const trs = [...app.root.querySelectorAll("tbody tr")];
  assert.equal(trs.length, d.edges.length);
  d.edges.forEach((e, i) => {
    const other = nodes.get(e.source === seed ? e.target : e.source);
    const node = trs[i].querySelector("button[data-node]");
    assert.equal(node.getAttribute("data-node"), other.id);
    assert.equal(text(node), other.label);
    assert.equal(text(trs[i].querySelector(".note")), other.type);
    assert.equal(text(trs[i].querySelector(`button[data-edge="${e.id}"]`)), `${e.count} ${e.count === 1 ? "record" : "records"}`);
  });

  // Evidence for one edge is a real, cited page.
  const edge = d.edges.find((e) => e.count > 0);
  app.click(app.root.querySelector(`tbody button[data-edge="${edge.id}"]`));
  await app.waitFor(() => app.root.querySelector("#evidence h2"), "edge evidence");
  const evidence = await payload("get_entity_graph", { seed, edge_id: edge.id, snapshot_id: d.snapshot_id, offset: 0 });
  assert.equal(text(app.root.querySelector("#evidence h2")), `Evidence · ${evidence.total_matches} records`);
  assert.deepEqual(citations(app.root.querySelector("#evidence")), evidence.results.map((r) => ({ href: r.amira_url, title: r.title })));
  assert.ok(evidence.results.length > 0);

  // Selecting a spoke keeps the graph, lists the neighbour's links and opens
  // the records behind the strongest one.
  const shown = spokes.map((g) => nodes.get(g.getAttribute("data-pick")));
  const next = shown.find((n) => n.type === "person") ?? shown[0];
  const strongest = weights.get(next.id).edges[0];
  app.click(app.root.querySelector(`g.node-link[data-pick="${next.id}"] text.label`));
  await app.waitFor(() => lastCall(app, "get_entity_graph").args.edge_id === strongest.id && app.root.querySelector("#evidence li"), "picked evidence");
  assert.equal(text(app.root.querySelector("h1")), nodes.get(seed).label, "selecting does not re-seed");
  assert.ok(app.root.querySelector(`g.node-link[data-pick="${next.id}"]`).classList.contains("picked"));
  assert.equal(text(app.root.querySelector("#pick h2")), `${next.label} ${next.type}`);
  assert.equal(app.root.querySelectorAll("#pick li").length, weights.get(next.id).edges.length);
  const picked = await payload("get_entity_graph", { seed, edge_id: strongest.id, snapshot_id: d.snapshot_id, offset: 0 });
  await app.waitFor(() => text(app.root.querySelector("#evidence h2")) === `Evidence · ${picked.total_matches} records`, "picked evidence heading");
  assert.deepEqual(citations(app.root.querySelector("#evidence")), picked.results.map((r) => ({ href: r.amira_url, title: r.title })));
  assertHealthy(app);

  // Re-centring is its own action.
  app.click(app.root.querySelector(`#pick button[data-node="${next.id}"]`));
  await app.waitFor(() => text(app.root.querySelector("h1")) === next.label, "re-seeded graph");
  assert.deepEqual(app.calls.at(-1), { name: "get_entity_graph", args: { seed: next.id } });
  assert.equal(app.root.querySelector("#pick").innerHTML, "", "a new seed clears the selection");
  assertHealthy(app);

  // The resolve form lists candidates as re-seed buttons.
  const form = app.root.querySelector("#resolve");
  form.querySelector('input[name="query"]').value = "Fendler";
  app.submit(form);
  await app.waitFor(() => app.root.querySelector("#candidates li"), "candidates");
  const candidates = await payload("resolve_entity", { query: "Fendler", limit: 20 });
  assert.deepEqual([...app.root.querySelectorAll("#candidates button")].map((b) => b.getAttribute("data-node")), candidates.results.map((c) => c.id));
  assert.match(text(app.root.querySelector("#candidates p")), new RegExp(`^${candidates.total_matches} candidates`));
  assertHealthy(app);
});

test("graph: type chips filter on the server and the filter survives re-seeding", async (t) => {
  const app = await mount(t, "get_entity_graph");
  const d = await payload("get_entity_graph", { seed: "person:100" });
  app.show(d);
  assertHealthy(app);
  const total = Object.values(d.neighbour_types).reduce((a, b) => a + b, 0);
  const chips = [...app.root.querySelectorAll(".chips button")];
  assert.equal(text(chips[0]), `All · ${total}`);
  assert.equal(chips[0].getAttribute("aria-pressed"), "true");
  const people = app.root.querySelector('.chips button[data-types="person"]');
  assert.equal(text(people), `People · ${d.neighbour_types.person}`);

  app.click(people);
  await app.waitFor(() => / · People only$/.test(text(app.root.querySelector(".sub"))), "people only");
  assert.deepEqual(lastCall(app, "get_entity_graph").args, { seed: "person:100", types: ["person"] });
  assert.equal(app.root.querySelector('.chips button[data-types="person"]').getAttribute("aria-pressed"), "true");
  const filtered = await payload("get_entity_graph", { seed: "person:100", types: ["person"] });
  const types = new Map(filtered.nodes.map((n) => [n.id, n.type]));
  const spokes = [...app.root.querySelectorAll("g.node-link")];
  assert.ok(spokes.length > 0);
  assert.ok(spokes.every((g) => types.get(g.getAttribute("data-pick")) === "person"));
  assert.deepEqual([...app.root.querySelectorAll("text.sector")].map(text), ["PEOPLE"]);
  assertHealthy(app);

  // Following a person keeps the people-only view.
  const next = filtered.nodes.find((n) => n.id === spokes[0].getAttribute("data-pick"));
  app.click(app.root.querySelector(`tbody button[data-node="${next.id}"]`));
  await app.waitFor(() => text(app.root.querySelector("h1")) === next.label, "re-seeded");
  assert.deepEqual(lastCall(app, "get_entity_graph").args, { seed: next.id, types: ["person"] });

  // "All" drops the filter.
  app.click(app.root.querySelector('.chips button[data-types=""]'));
  await app.waitFor(() => !/ only$/.test(text(app.root.querySelector(".sub"))), "all types");
  assert.deepEqual(lastCall(app, "get_entity_graph").args, { seed: next.id });
  assertHealthy(app);
});

test("graph: an isolated entity, an empty filter and a bounded view render honestly", async (t) => {
  const app = await mount(t, "get_entity_graph");
  const lonely = await payload("get_entity_graph", { seed: "organisation:201" });
  assert.equal(lonely.edges.length, 0);
  app.show(lonely);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector("h1")), "Test Research Group");
  assert.equal(text(app.root.querySelector(".empty")), "No relationships are recorded for this entity.");
  assert.equal(app.root.querySelectorAll("tbody tr").length, 0);

  const full = await payload("get_entity_graph", { seed: "person:100" });
  const absent = ["playlist", "journal", "podcast", "video", "section", "collection"].find((type) => !(type in full.neighbour_types));
  const none = await payload("get_entity_graph", { seed: "person:100", types: [absent] });
  app.show(none);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".empty")), "No neighbours of this type are recorded for this entity.");
  assert.ok(app.root.querySelector(".chips"), "the chips stay, so the filter can be undone");

  const bounded = await payload("get_entity_graph", { seed: "person:100", max_nodes: 2 });
  assert.equal(bounded.truncated, true);
  app.show(bounded);
  assertHealthy(app);
  assert.match(text(app.root.querySelector(".sub")), / · bounded view$/);
  assert.equal(app.root.querySelectorAll("tbody tr").length, bounded.edges.length);
});

// --- map ----------------------------------------------------------------------

test("map: markers, table and evidence citations match list_locations", async (t) => {
  const app = await mount(t, "list_locations");
  const d = await payload("list_locations");
  app.show(d);
  assertHealthy(app);

  const mapped = d.results.filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
  assert.equal(text(app.root.querySelector(".sub")),
    `${mapped.length} of ${d.results.length} returned places have coordinates · ${d.items_without_place} matching items have no place`);
  assert.deepEqual([...app.root.querySelectorAll("circle.place title")].map(text), mapped.map((r) => `${r.name}: ${r.item_count} items`));
  assert.equal(app.root.querySelectorAll("circle.place.root").length, mapped.filter((r) => r.coordinate_scope === "hierarchy_root").length);
  assert.deepEqual(rows(app.root.querySelector("table")), d.results.map((r) =>
    [r.name, r.country ?? "Hierarchy root", String(r.item_count), `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`]));
  assert.match(text(app.root), new RegExp(`Places 1–${d.results.length} of ${d.total_matches}`));

  // A place opens its research items, by authority id.
  const nigeria = d.results.find((r) => r.name === "Nigeria");
  app.click(app.root.querySelector(`button[data-place-id="${nigeria.omeka_id}"]`));
  await app.waitFor(() => app.root.querySelector("#map-evidence h2"), "place evidence");
  const args = { limit: 20, offset: 0, location_id: nigeria.omeka_id };
  assert.deepEqual(lastCall(app, "search_research_items"), { name: "search_research_items", args });
  const evidence = await payload("search_research_items", args);
  assert.equal(text(app.root.querySelector("#map-evidence h2")), `Nigeria · ${evidence.total_matches} matching records`);
  assert.deepEqual(citations(app.root.querySelector("#map-evidence")), evidence.results.map((r) => ({ href: r.amira_url, title: r.title })));
  assert.equal(evidence.results.length, nigeria.item_count);

  // Country filter: a dropdown of the hierarchy roots, fetched by the app itself.
  await app.waitFor(() => app.root.querySelector('select[name="country"]'), "country dropdown");
  const all = await payload("list_locations", { limit: 300, offset: 0 });
  const roots = all.results.filter((r) => r.coordinate_scope === "hierarchy_root").sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(options(app.root.querySelector('select[name="country"]')),
    [["", "All countries"], ...roots.map((r) => [r.name, `${r.name} (${r.item_count})`])]);
  app.root.querySelector('select[name="country"]').value = "Nigeria";
  app.submit(app.root.querySelector("#map-filter"));
  await app.waitFor(() => app.root.querySelector('select[name="country"]')?.value === "Nigeria" && app.root.querySelectorAll("tbody tr").length !== d.results.length, "filtered places");
  const filtered = await payload("list_locations", lastCall(app, "list_locations").args);
  assert.equal(filtered.filters.country, "Nigeria");
  assert.deepEqual(rows(app.root.querySelector("table")).map((r) => r[0]), filtered.results.map((r) => r.name));
  assertHealthy(app);
});

test("map: a filter that matches no place renders a friendly empty message", {
  // Fixed in 1.19: the map shows an empty-state message and keeps its filter.
}, async (t) => {
  const app = await mount(t, "list_locations");
  const d = await payload("list_locations", { country: "Atlantis" });
  assert.equal(d.results.length, 0);
  app.show(d);
  assertHealthy(app);
  assert.ok(app.root.querySelector(".empty"), "an .empty message is shown");
  assert.doesNotMatch(text(app.root), /Places 1–0 of 0/);
});

// --- bibliography -------------------------------------------------------------

test("bibliography: rows and citations match search_publications; selection exports real citations", async (t) => {
  const app = await mount(t, "search_publications");
  const d = await payload("search_publications");
  app.show(d);
  assertHealthy(app);

  assert.equal(text(app.root.querySelector(".sub")), `${d.total_matches} matching publications · showing 1–${d.results.length}`);
  assert.deepEqual(citations(app.root), d.results.map((p) => ({ href: p.amira_url, title: p.title })));
  assert.deepEqual([...app.root.querySelectorAll("tbody tr")].map((tr) => [text(tr.querySelector(".note")), text(tr.lastElementChild)]),
    d.results.map((p) => [`${p.authors.join("; ")}${p.has_fulltext ? " · Full text available" : ""}`.replace(/^ · /, "· "), String(p.year ?? "Undated")]));
  assert.deepEqual([...app.root.querySelectorAll("input[type=checkbox]")].map((b) => b.getAttribute("data-id")), d.results.map((p) => String(p.omeka_id)));

  // Select one publication and export it in each format.
  const first = d.results[0];
  const box = app.root.querySelector(`input[data-id="${first.omeka_id}"]`);
  box.checked = true;
  box.dispatchEvent(new app.win.Event("change", { bubbles: true }));
  assert.equal(text(app.doc.getElementById("selection-count")), "1 selected (maximum 25)");
  assert.equal(app.doc.getElementById("export-selected").disabled, false);
  for (const [format, extension] of [["bibtex", "bib"], ["ris", "ris"], ["csl-json", "json"]]) {
    app.doc.getElementById("export-format").value = format;
    const before = app.downloads.length;
    app.click(app.doc.getElementById("export-selected"));
    await app.waitFor(() => app.downloads.length > before, `${format} download`);
    const download = app.downloads.at(-1);
    const detail = await payload("get_publication", { id: String(first.omeka_id), citation_format: format });
    assert.equal(download.extension, extension);
    if (format === "csl-json") assert.deepEqual(JSON.parse(download.text), [detail.csl_json]);
    else assert.equal(download.text, detail[format]);
    await app.waitFor(() => app.status() === "Exported 1 selected publications.", "export status");
  }

  // Keyword search re-renders from search_publications; the selection persists.
  const form = app.root.querySelector("#publication-search");
  form.querySelector('input[name="keyword"]').value = "Migration";
  app.submit(form);
  await app.waitFor(() => app.calls.some((c) => c.name === "search_publications"), "keyword search");
  assert.deepEqual(lastCall(app, "search_publications"), { name: "search_publications", args: { keyword: "Migration", offset: 0, limit: 20 } });
  const found = await payload("search_publications", lastCall(app, "search_publications").args);
  await app.waitFor(() => text(app.root.querySelector(".sub")).startsWith(`${found.total_matches} matching`), "search render");
  assert.deepEqual(citations(app.root), found.results.map((p) => ({ href: p.amira_url, title: p.title })));
  assert.equal(text(app.doc.getElementById("selection-count")), "1 selected (maximum 25)");
  assertHealthy(app);
});

test("bibliography: no matches renders a friendly empty message", async (t) => {
  const app = await mount(t, "search_publications");
  const d = await payload("search_publications", { keyword: "zzz-no-such-publication" });
  assert.equal(d.total_matches, 0);
  app.show(d);
  assertHealthy(app);
  assert.equal(text(app.root.querySelector(".sub")), "0 matching publications · no results");
  assert.equal(text(app.root.querySelector(".empty")), "No publications match these filters. Try removing a filter.");
  assert.equal(app.doc.getElementById("export-selected").disabled, true);
});

test("bibliography: languages are a dropdown counted for the current search; authors are suggestions", async (t) => {
  const app = await mount(t, "search_publications");
  app.show(await payload("search_publications"));
  await app.waitFor(() => app.root.querySelector('select[name="language"]') && app.root.querySelector("#author-options option"), "language and author lists");
  const languageOptions = (facet, current) => [["", "Any language"],
    ...(current && !facet.results.some((r) => r.value === current) ? [[current, current]] : []),
    ...facet.results.map((r) => [r.value, `${r.value} (${r.publication_count})`])];
  const languages = await payload("list_publication_facets", { facet: "language", limit: 100, offset: 0 });
  assert.deepEqual(options(app.root.querySelector('select[name="language"]')), languageOptions(languages));
  const authors = await payload("list_publication_facets", { facet: "author", limit: 100, offset: 0 });
  assert.equal(app.root.querySelector('input[name="author"]').getAttribute("list"), "author-options");
  assert.deepEqual([...app.root.querySelectorAll("#author-options option")].map((o) => o.value), authors.results.map((r) => r.value));

  // Choosing a language searches with it, and the other languages stay selectable.
  const [{ value: language }] = languages.results;
  app.root.querySelector('select[name="language"]').value = language;
  app.submit(app.root.querySelector("#publication-search"));
  await app.waitFor(() => app.root.querySelector('select[name="language"]')?.value === language, "language search");
  assert.deepEqual(lastCall(app, "search_publications").args, { language, offset: 0, limit: 20 });
  assert.deepEqual(options(app.root.querySelector('select[name="language"]')), languageOptions(languages, language));
  assert.ok(!app.calls.some((c) => c.name === "list_publication_facets" && c.args.language), "the language list ignores its own filter");

  // A keyword re-counts the languages within the search.
  app.root.querySelector('input[name="keyword"]').value = "Migration";
  app.submit(app.root.querySelector("#publication-search"));
  const scoped = await payload("list_publication_facets", { facet: "language", keyword: "Migration", limit: 100, offset: 0 });
  await app.waitFor(() => JSON.stringify(options(app.root.querySelector('select[name="language"]'))) === JSON.stringify(languageOptions(scoped, language)), "scoped language counts");
  assertHealthy(app);
});

test("bibliography: pickers stay text fields when the host refuses their lists", async (t) => {
  const app = await mount(t, "search_publications");
  const callTool = app.win.__amiraHost.callTool;
  app.win.__amiraHost.callTool = (name, args) => name === "list_publication_facets" ? Promise.reject(new Error("refused")) : callTool(name, args);
  app.show(await payload("search_publications"));
  await sleep(20);
  assert.ok(app.root.querySelector('input[name="language"]'), "language stays a text field");
  assert.equal(app.root.querySelectorAll("#author-options option").length, 0);

  // Typing still filters.
  app.root.querySelector('input[name="language"]').value = "English";
  app.submit(app.root.querySelector("#publication-search"));
  await app.waitFor(() => lastCall(app, "search_publications")?.args.language === "English", "typed language search");
  assertHealthy(app);
});

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
