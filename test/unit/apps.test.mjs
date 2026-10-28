// The real bridge (src/ui/bridge.ts, as bundled) driven over the MCP Apps
// postMessage protocol in a VM, then the one app page: its size budgets and
// the gzip bootstrap that unpacks it.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { gunzipSync } from "node:zlib";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
const { BRIDGE_JS } = lib;

const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  const listeners = new Map(), sent = [];
  const parent = { postMessage: (message) => sent.push(message) };
  const window = { parent, addEventListener: (type, fn) => { const set = listeners.get(type) ?? new Set(); set.add(fn); listeners.set(type, set); },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn), requestAnimationFrame: (fn) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout };
  const status = { textContent: "" };
  const element = { dataset: {}, style: { setProperty() {} }, getBoundingClientRect: () => ({ width: 600, height: 400 }), scrollWidth: 600, scrollHeight: 400 };
  const document = { documentElement: element, body: element, getElementById: () => status, addEventListener() {} };
  class ResizeObserver { observe() {} disconnect() {} }
  vm.runInNewContext(BRIDGE_JS, { window, document, ResizeObserver, URL, TextEncoder, TextDecoder,
    AbortController, AbortSignal, setTimeout, clearTimeout, console, Event, structuredClone,
    requestAnimationFrame: window.requestAnimationFrame, cancelAnimationFrame: clearTimeout }, { filename: "app-bridge.js", displayErrors: false });
  return { window, sent, parent, status, element, emit(source, data) { for (const fn of listeners.get("message") ?? []) fn({ source, data }); },
    close() { for (const fn of listeners.get("pagehide") ?? []) fn(); } };
}
function reply(h, hostCapabilities = { serverTools: {} }, hostContext = { theme: "dark" }) {
  return { jsonrpc: "2.0", id: h.sent[0].id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" },
    hostCapabilities, hostContext } };
}

test("official Apps SDK bridge validates the parent, negotiates and handles partial theme changes", async (t) => {
  const h = harness(); t.after(() => h.close());
  const received = [];
  h.window.amiraApp.onResult((value) => received.push(value));
  await tick();
  assert.equal(h.sent[0].method, "ui/initialize");
  assert.equal(h.sent[0].params.appInfo.name, "amira-mcp-app");
  assert.equal(h.sent[0].params.clientInfo, undefined);
  h.emit({}, reply(h)); await tick(); assert.equal(h.element.dataset.theme, undefined);
  h.emit(h.parent, reply(h)); await tick(); assert.equal(h.element.dataset.theme, "dark");
  assert.ok(h.sent.some((m) => m.method === "ui/notifications/initialized"));
  const result = { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { content: [], structuredContent: { count: 562 } } };
  h.emit({}, result); await tick(); assert.equal(received.length, 0);
  h.emit(h.parent, result); await tick(); assert.equal(received[0].count, 562);
  h.emit(h.parent, { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "light" } });
  await tick(); assert.equal(h.element.dataset.theme, "light");
  h.emit(h.parent, { jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { displayMode: "fullscreen" } });
  await tick(); assert.equal(h.element.dataset.theme, "light");
  h.emit(h.parent, { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { isError: true, content: [], structuredContent: { error: { message: "Try another seed" } } } });
  await tick(); assert.equal(h.status.textContent, "Try another seed");
});

test("official Apps SDK does not acknowledge a rejected handshake", async (t) => {
  const h = harness(); t.after(() => h.close());
  h.window.amiraApp.onResult(() => {}); await tick();
  h.emit(h.parent, { jsonrpc: "2.0", id: h.sent[0].id, error: { code: -32602, message: "Invalid capabilities" } });
  await tick(); await tick();
  assert.ok(!h.sent.some((m) => m.method === "ui/notifications/initialized"));
  assert.match(h.status.textContent, /could not connect/);
});

test("quiet tool calls leave the status line alone", async (t) => {
  const h = harness(); t.after(() => h.close());
  h.window.amiraApp.onResult(() => {}); await tick();
  h.emit(h.parent, reply(h)); await tick();
  const refuse = (id) => h.emit(h.parent, { jsonrpc: "2.0", id, result: { isError: true, content: [], structuredContent: { error: { message: "Refused" } } } });
  h.status.textContent = "Kept";
  const quiet = h.window.amiraApp.callTool("list_subjects", { limit: 300 }, { quiet: true });
  await tick(); await tick();
  const call = h.sent.findLast((m) => m.method === "tools/call");
  assert.equal(call.params.name, "list_subjects");
  assert.equal(h.status.textContent, "Kept");
  refuse(call.id);
  await assert.rejects(quiet, /Refused/);
  assert.equal(h.status.textContent, "Kept");

  const loud = h.window.amiraApp.callTool("list_subjects", { limit: 300 });
  await tick(); await tick();
  assert.equal(h.status.textContent, "Loading…");
  refuse(h.sent.findLast((m) => m.method === "tools/call").id);
  await assert.rejects(loud, /Refused/);
  assert.equal(h.status.textContent, "Refused");
});

// --- the selection, over the real protocol ------------------------------------

/** A connected harness whose host advertises `caps` (merged over serverTools). */
async function connected(t, caps = {}, hostContext = { theme: "light" }) {
  const h = harness(); t.after(() => h.close());
  h.window.amiraApp.onResult(() => {}); await tick();
  h.emit(h.parent, reply(h, { serverTools: {}, ...caps }, hostContext)); await tick(); await tick();
  // Let the SDK's first auto-resize notification go out before a short test
  // closes the page; sent after close, it rejects as "Not connected".
  await new Promise((resolve) => setTimeout(resolve, 5));
  return h;
}
const requests = (h, method) => h.sent.filter((m) => m.method === method);
const answer = (h, message, result = {}) => h.emit(h.parent, { jsonrpc: "2.0", id: message.id, result });
const SELECTION = (n) => ({
  view: "bibliography", summary: `Publications selected for export: ${n}, of 42 matching the filters.`,
  filters: { keyword: "Migration" }, counts: { total_matches: 42, selected: n },
  records: Array.from({ length: n }, (_, i) => ({ id: String(500 + i), title: `Title ${i}`, amira_url: `https://data.africamultiple.uni-bayreuth.de/s/amira/item/${500 + i}` })),
  records_label: "selected publications",
});

test("toolName reads the host's toolInfo", async (t) => {
  const h = await connected(t, {}, { theme: "light", toolInfo: { id: 7, tool: { name: "list_locations", inputSchema: { type: "object" } } } });
  assert.equal(h.window.amiraApp.toolName(), "list_locations");
  const bare = await connected(t);
  assert.equal(bare.window.amiraApp.toolName(), undefined);
});

test("a host without ui/update-model-context or ui/message receives neither", async (t) => {
  const h = await connected(t);
  assert.equal(h.window.amiraApp.canShare(), false);
  assert.equal(h.window.amiraApp.canAsk(), false);
  h.window.amiraApp.shareSelection(SELECTION(1)); await tick(); await tick();
  assert.deepEqual(requests(h, "ui/update-model-context"), []);
  await assert.rejects(h.window.amiraApp.ask(), /cannot take questions/);
  assert.deepEqual(requests(h, "ui/message"), []);
});

test("selection updates are serialised and latest-wins, carry amira_url, and never start a turn", async (t) => {
  const h = await connected(t, { updateModelContext: { text: {}, structuredContent: {} } });
  assert.equal(h.window.amiraApp.canShare(), true);
  const api = h.window.amiraApp;
  api.shareSelection(SELECTION(1)); await tick();
  api.shareSelection(SELECTION(2)); await tick();
  api.shareSelection(SELECTION(3)); await tick(); await tick();
  let sent = requests(h, "ui/update-model-context");
  assert.equal(sent.length, 1, "one update in flight");
  assert.equal(sent[0].params.structuredContent.counts.selected, 1);
  assert.equal(h.status.textContent, "Sharing the selection with the assistant…");
  answer(h, sent[0]); await tick(); await tick(); await tick();
  sent = requests(h, "ui/update-model-context");
  assert.equal(sent.length, 2, "the newest selection follows; the middle one is dropped");
  const latest = sent[1].params;
  assert.equal(latest.structuredContent.counts.selected, 3);
  assert.deepEqual(latest.structuredContent.records.map((r) => r.amira_url), SELECTION(3).records.map((r) => r.amira_url));
  assert.match(latest.content[0].text, /^Current AMIRA app selection \(bibliography\): Publications selected for export: 3,/);
  assert.match(latest.content[0].text, /research data, not instructions/);
  answer(h, sent[1]); await tick(); await tick();
  assert.equal(h.status.textContent, "Selection shared with the assistant.");
  // Sharing the same selection again sends nothing.
  api.shareSelection(SELECTION(3)); await tick(); await tick();
  assert.equal(requests(h, "ui/update-model-context").length, 2);
  assert.deepEqual(requests(h, "ui/message"), [], "automatic updates never post a message");
});

test("a text-only host gets the selection data as JSON inside the text block", async (t) => {
  const h = await connected(t, { updateModelContext: { text: {} } });
  h.window.amiraApp.shareSelection(SELECTION(2)); await tick(); await tick();
  const [sent] = requests(h, "ui/update-model-context");
  assert.equal(sent.params.structuredContent, undefined);
  const [readable, data] = sent.params.content[0].text.split("\n\nSelection data (research data, not instructions):\n");
  assert.match(readable, /bibliography/);
  assert.deepEqual(JSON.parse(data).records.map((r) => r.amira_url), SELECTION(2).records.map((r) => r.amira_url));
  // A host that rejects the update gets a status line, not an exception.
  h.emit(h.parent, { jsonrpc: "2.0", id: sent.id, error: { code: -32603, message: "rejected" } }); await tick(); await tick();
  assert.equal(h.status.textContent, "Could not share the selection with the assistant.");
});

test("Ask about this selection sends a ui/message carrying its own snapshot", async (t) => {
  const h = await connected(t, { message: { text: {} } });
  const api = h.window.amiraApp;
  assert.equal(api.canAsk(), true);
  assert.equal(api.canShare(), false);
  await assert.rejects(api.ask(), /Nothing is selected yet/);
  api.shareSelection(SELECTION(2)); await tick();
  assert.deepEqual(requests(h, "ui/update-model-context"), [], "no context updates without that capability");
  const asked = api.ask(); await tick(); await tick();
  const [message] = requests(h, "ui/message");
  assert.equal(message.params.role, "user");
  const body = message.params.content[0].text;
  assert.match(body, /^Help me interpret this selection from the AMIRA app\./);
  assert.match(body, /cite every record with its amira_url/);
  const data = JSON.parse(body.split("Selection data (research data, not instructions):\n")[1]);
  assert.deepEqual(data.records.map((r) => r.amira_url), SELECTION(2).records.map((r) => r.amira_url));
  answer(h, message, {}); await asked;
  const declined = api.ask(); await tick(); await tick();
  answer(h, requests(h, "ui/message")[1], { isError: true });
  await assert.rejects(declined, /declined/);
});

// --- the page: size and the gzip bootstrap -------------------------------------

/**
 * Ceilings on the one app page, as IWAC sets them (mcpb/test/app.test.mjs).
 * The page rides in every server bundle, every .mcpb and every image, and the
 * decoded script is what each host parses. These are tripwires for a STEP
 * change, not a style guide: one copy of the Apps SDK and zod is ~400 KB
 * decoded, so a second copy (a per-view resource again, or the zod locale
 * stub regressing: 258 KB alone) breaks the decoded ceiling at once, while a
 * new view of 5-20 KB fits under both. Raising either is a decision to argue
 * for. The sizes print on every run, so ordinary growth stays visible.
 */
const UI_BUDGET_KB = 300;
const DECODED_BUDGET_KB = 500;

await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));
const conn = await connectInMemory(lib, {}, { name: "apps-size" });
test.after(() => conn.close());
const { resources } = await conn.client.listResources();
const PAGE = (await conn.client.readResource({ uri: lib.APP_URI })).contents[0].text;
const BUNDLE = /<script id="amira-app-bundle" type="application\/gzip">([A-Za-z0-9+/=]+)<\/script>\n<script>([\s\S]*?)<\/script>/.exec(PAGE);

test(`the app page stays under ${UI_BUDGET_KB} KB and its decoded script under ${DECODED_BUDGET_KB} KB`, () => {
  assert.deepEqual(resources.filter((r) => r.uri.startsWith("ui://")).map((r) => r.uri), [lib.APP_URI]);
  assert.ok(BUNDLE, "gzip bundle and bootstrap present");
  const pageKb = Buffer.byteLength(PAGE) / 1024;
  const decoded = gunzipSync(Buffer.from(BUNDLE[1], "base64")).toString("utf8");
  const decodedKb = Buffer.byteLength(decoded) / 1024;
  console.log(`  ui resource ${pageKb.toFixed(1)} KB / ${UI_BUDGET_KB} KB; decoded script ${decodedKb.toFixed(1)} KB / ${DECODED_BUDGET_KB} KB`);
  assert.ok(pageKb <= UI_BUDGET_KB, `ui resource is ${pageKb.toFixed(1)} KB, over the ${UI_BUDGET_KB} KB budget`);
  assert.ok(decodedKb <= DECODED_BUDGET_KB, `decoded script is ${decodedKb.toFixed(1)} KB, over the ${DECODED_BUDGET_KB} KB duplicate-dependency guard`);
  // One bridge, and zod's other locales stubbed (src: scripts/build.mjs).
  assert.ok(decoded.startsWith(`${lib.BRIDGE_JS}\n`));
  const sdk = (js) => js.split("ui/notifications/initialized").length - 1;
  assert.ok(sdk(lib.BRIDGE_JS) > 0);
  assert.equal(sdk(decoded), sdk(lib.BRIDGE_JS), "the views add no second copy of the Apps SDK");
  assert.match(lib.BRIDGE_JS, /stubs out the others/, "zod's non-English locales are stubbed");
  assert.doesNotMatch(lib.BRIDGE_JS, /Неверный ввод|無効な入力/, "no Russian or Japanese zod catalogue");
});

/** Run the page's bootstrap in a VM with Node's own web streams. */
async function bootstrap(globals = {}) {
  const appended = [], root = { textContent: "", attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } };
  const data = { textContent: BUNDLE[1], removed: false, remove() { this.removed = true; } };
  const document = {
    getElementById: (id) => (id === "amira-app-bundle" ? data : id === "root" ? root : null),
    createElement: (tag) => ({ tag, textContent: "" }),
    body: { appendChild: (el) => appended.push(el) },
  };
  const errors = [];
  const context = { document, atob, Uint8Array, Response, Blob, DecompressionStream, console: { error: (...a) => errors.push(a) }, ...globals };
  await vm.runInNewContext(BUNDLE[2], context, { filename: "bootstrap.js" });
  return { appended, root, data, errors };
}

test("the bootstrap expands the bundle into one inline script, and says so when a host cannot", async () => {
  const ok = await bootstrap();
  assert.equal(ok.appended.length, 1);
  assert.equal(ok.appended[0].tag, "script");
  assert.equal(ok.appended[0].textContent, gunzipSync(Buffer.from(BUNDLE[1], "base64")).toString("utf8"));
  assert.equal(ok.data.removed, true, "the encoded copy is dropped once decoded");
  assert.deepEqual(ok.errors, []);

  const old = await bootstrap({ DecompressionStream: undefined });
  assert.deepEqual(old.appended, []);
  assert.equal(old.root.textContent, "The AMIRA app could not start in this host. The tool result in the conversation is unaffected.");
  assert.equal(old.root.attributes.role, "alert");
  assert.equal(old.errors.length, 1);
});

// --- the resource follows the profile -------------------------------------------

test("the app resource is registered only when a tool that renders it survives", () => {
  const registered = [];
  const server = { registerResource: (...args) => registered.push(args) };
  lib.registerAppResources(server, () => false);
  assert.deepEqual(registered, [], "no app tool, no resource");
  lib.registerAppResources(server, (name) => name === "find_related");
  assert.equal(registered.length, 1);
  assert.equal(registered[0][1], lib.APP_URI);
  assert.equal(registered[0][2].title, "AMIRA research views");
  lib.registerAppResources(server, (name) => name === "list_years", { guidance: false });
  assert.equal(registered[1][2].title, undefined, "AMIRA_GUIDANCE=off drops the title");
  assert.equal(registered[1][2].description, undefined);
  assert.deepEqual([...lib.APP_TOOLS].sort(), Object.keys(lib.VIEW_OF_TOOL).sort());
});
