import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { BRIDGE_JS } from "../../server/lib.js";

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
function reply(h) {
  return { jsonrpc: "2.0", id: h.sent[0].id, result: { protocolVersion: "2026-01-26", hostInfo: { name: "test-host", version: "1" },
    hostCapabilities: { serverTools: {} }, hostContext: { theme: "dark" } } };
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
