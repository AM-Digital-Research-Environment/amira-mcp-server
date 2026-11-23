// The view as an image (#31): the bridge registers a `get-screenshot` app tool
// that a host can call on the map or entity graph on screen. Here the real
// bridge runs in happy-dom and is driven over postMessage as a host would; the
// SVG serialisation and sizing are tested directly. happy-dom cannot rasterise,
// so the PNG itself was validated in Chromium through scripts/preview-apps.mjs
// (docs/apps.md records it); here a capture reaches the canvas step and fails
// there with a clear message, as it would in a host without canvas support.
import test from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { lib, payload, mount } from "../helpers/apps-harness.mjs";

/** The real bridge in an iframe with `body` markup, under a host page that answers the handshake.
 * `onResult` is the views' callback, as script source. */
async function hostedBridge(t, body, onResult = "function () {}") {
  const host = new Window({ url: "https://host.test/", settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true } });
  t.after(() => host.happyDOM.close());
  host.document.write("<!doctype html><html><body></body></html>");
  const frame = host.document.createElement("iframe");
  frame.srcdoc = `<!doctype html><html><body><p id="app-status"></p>${body}<script>${lib.BRIDGE_JS}</script>` +
    `<script>window.amiraApp.onResult(${onResult});</script></body></html>`;
  const replies = new Map();
  let initialized = false;
  host.addEventListener("message", (event) => {
    const m = event.data;
    if (m?.jsonrpc !== "2.0") return;
    if (m.method === "ui/initialize") {
      frame.contentWindow.postMessage({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26",
        hostInfo: { name: "test", version: "1" }, hostCapabilities: {}, hostContext: {} } }, "*");
    } else if (m.method === "ui/notifications/initialized") initialized = true;
    else if (m.id !== undefined && String(m.id).startsWith("host-")) replies.set(m.id, m);
  });
  host.document.body.appendChild(frame);
  await host.happyDOM.waitUntilComplete();
  for (let i = 0; i < 200 && !initialized; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(initialized, "the bridge completes the handshake");
  let n = 0;
  const request = async (method, params) => {
    const id = `host-${++n}`;
    frame.contentWindow.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    for (let i = 0; i < 400 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(replies.has(id), `${method} answered`);
    return replies.get(id);
  };
  /** A host notification, such as a tool result. */
  const notify = (method, params) => frame.contentWindow.postMessage({ jsonrpc: "2.0", method, params }, "*");
  return { request, notify, frame };
}

test("the bridge lists get-screenshot as an app tool with a bounded maxDimension", async (t) => {
  const { request } = await hostedBridge(t, '<main id="root"></main>');
  const listed = (await request("tools/list", {})).result.tools;
  const tool = listed.find((x) => x.name === "get-screenshot");
  assert.ok(tool, JSON.stringify(listed));
  assert.equal(tool.annotations?.readOnlyHint, true);
  const max = tool.inputSchema.properties.maxDimension;
  assert.deepEqual([max.minimum, max.maximum], [lib.CAPTURE_MIN_DIMENSION, lib.CAPTURE_MAX_DIMENSION]);
});

test("get-screenshot: a view with no map or graph says so; an oversized request is refused", async (t) => {
  const { request } = await hostedBridge(t, '<main id="root" data-view="timeline"><svg viewBox="0 0 10 10"></svg></main>');
  const none = (await request("tools/call", { name: "get-screenshot", arguments: {} })).result;
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /No research-places map or entity graph is on screen/);
  const big = await request("tools/call", { name: "get-screenshot", arguments: { maxDimension: 5000 } });
  assert.ok(big.error || big.result?.isError, "beyond 2048 px is refused");
});

test("get-screenshot: a map on screen reaches the drawing step and reports a failure there as an error", async (t) => {
  const { request } = await hostedBridge(t,
    '<main id="root" data-view="map"><div class="map"><svg viewBox="0 0 720 360"><circle cx="1" cy="1" r="2"></circle></svg></div></main>');
  const result = (await request("tools/call", { name: "get-screenshot", arguments: { maxDimension: 256 } })).result;
  // happy-dom draws nothing: the capture must fail cleanly, never hang or return an empty image.
  assert.equal(result.isError, true);
  assert.ok(result.content[0].text.length > 0);
  assert.ok(!result.content.some((c) => c.type === "image"));
});

test("standaloneSvg bakes the view's computed styles, theme and selection into a self-contained SVG", async (t) => {
  const app = await mount(t, "list_locations");
  app.show(await payload("list_locations"));
  const { win } = app;
  const svg = app.root.querySelector(".map svg");
  const circle = svg.querySelector("circle.place");
  circle.classList.add("picked");
  const saved = { getComputedStyle: globalThis.getComputedStyle, XMLSerializer: globalThis.XMLSerializer };
  Object.assign(globalThis, { getComputedStyle: win.getComputedStyle.bind(win), XMLSerializer: win.XMLSerializer });
  try {
    const out = lib.standaloneSvg(svg, "#123456");
    assert.equal(out.width, 720);
    assert.equal(out.height, 360);
    const doc = new win.DOMParser().parseFromString(out.text, "image/svg+xml");
    const root = doc.documentElement;
    assert.equal(root.getAttribute("xmlns"), "http://www.w3.org/2000/svg");
    assert.equal(root.querySelector("rect").getAttribute("fill"), "#123456", "a background in the surface colour");
    // No classes or handlers survive: every mark carries its own style.
    assert.equal(root.querySelector("[class]"), null);
    assert.equal(root.querySelector("[tabindex], [role], [data-place]"), null);
    const marks = [...root.querySelectorAll("circle")];
    assert.equal(marks.length, svg.querySelectorAll("circle").length);
    assert.ok(marks.every((m) => /stroke-width:/.test(m.getAttribute("style") ?? "")), "styles inlined");
    assert.ok(root.querySelector("title"), "each mark keeps its name");
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("captureSize keeps the aspect ratio and the bounds", () => {
  assert.deepEqual(lib.captureSize(720, 360, 1024), { width: 1024, height: 512 });
  assert.deepEqual(lib.captureSize(720, 720, 512), { width: 512, height: 512 });
  assert.deepEqual(lib.captureSize(720, 360, 10), { width: lib.CAPTURE_MIN_DIMENSION, height: 32 }, "never below the minimum");
  assert.deepEqual(lib.captureSize(720, 360, 99999), { width: 1440, height: 720 }, "never upscaled past 2x");
  assert.deepEqual(lib.CAPTURE_TARGETS, { map: ".map svg", graph: ".graph svg" });
});

test("a failed host result keeps the instance on screen, so the view's next save stays its own (#32)", async (t) => {
  const { notify, frame } = await hostedBridge(t, '<main id="root"></main>',
    'function (d) { window.amiraApp.saveState("map", { n: d.n }); }');
  const win = frame.contentWindow;
  const wait = async (predicate, what) => {
    for (let i = 0; i < 200 && !predicate(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate(), what);
  };
  const saved = (key) => {
    const entries = JSON.parse(win.localStorage.getItem("amira-views") ?? "null")?.entries ?? [];
    return entries.find(([k]) => k === key)?.[1].state ?? null;
  };
  notify("ui/notifications/tool-result", { structuredContent: { n: 1 }, content: [], _meta: { viewUUID: "first" } });
  await wait(() => saved("uuid:first")?.n === 1, "the first result is saved under its viewUUID");

  notify("ui/notifications/tool-result", { isError: true, content: [{ type: "text", text: "{\"error\":{\"message\":\"Bad seed\"}}" }],
    _meta: { viewUUID: "failed" } });
  await wait(() => win.document.getElementById("app-status").textContent === "Bad seed", "the failure is reported");
  win.amiraApp.saveState("map", { n: 2 });
  assert.equal(saved("uuid:first").n, 2, "a later save still belongs to the view on screen");
  assert.equal(saved("uuid:failed"), null, "nothing is saved for the failed result");
});
