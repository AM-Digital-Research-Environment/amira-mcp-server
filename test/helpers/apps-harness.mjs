// The harness the app-render tests share (test/unit/apps-*.test.mjs). It executes
// the seven MCP App views for real. They share one page,
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
import { hermeticEnv } from "./env.mjs";
import { connectInMemory } from "./mcp.mjs";

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

export {
  lib, fixture, conn, APP_MIME, APP_PAGES, PAGE, tools, APP_OF, BUNDLE, DECODED, VIEWS_JS, BRIDGE_TOOLS, STUB_JS, STUB_API, payloadOf, payload, sleep, text, rows, citations, options, lastCall, AMIRA_URL, mount, assertHealthy,
};
