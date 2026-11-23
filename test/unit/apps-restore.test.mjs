// Restoring a view when the host re-delivers its result (#32): the bibliography,
// map and graph save bounded state per instance (src/ui/viewState.ts) and come
// back as the reader left them; another instance, a changed snapshot, corrupt
// storage and a reset each give a coherent fresh view. The server side (the
// viewUUID and snapshot stamped in `_meta`) and the store itself are tested
// at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { payload, text, mount, assertHealthy, lastCall, conn, lib } from "../helpers/apps-harness.mjs";

const saved = (storage, instance = "default") => JSON.parse(storage.get(instance));
const checked = (app) => [...app.root.querySelectorAll("input[type=checkbox]")].filter((b) => b.checked).map((b) => b.dataset.id);

/** Select publications by id, as a reader ticking their boxes. */
function tick(app, ids) {
  for (const id of ids) {
    const box = app.root.querySelector(`input[data-id="${id}"]`);
    box.checked = true;
    box.dispatchEvent(new app.win.Event("change", { bubbles: true }));
  }
}

/** A first app: the reader filters, selects and picks a format; returns the storage and what was searched. */
async function workedBibliography(t) {
  const storage = new Map();
  const app = await mount(t, "search_publications", { storage });
  const d = await payload("search_publications");
  const result = { ...d };
  app.show(result, { instance: "A" });
  // A filtered search, answered by the app's own call (its result names the snapshot).
  const form = app.root.querySelector("#publication-search");
  form.querySelector('input[name="year_from"]').value = "2000";
  app.submit(form);
  await app.waitFor(() => saved(storage, "A").state.filters?.year_from === 2000, "filtered search saved");
  const rowsNow = [...app.root.querySelectorAll("input[type=checkbox]")].map((b) => b.dataset.id);
  const ids = rowsNow.slice(0, 2);
  assert.equal(ids.length, 2, "the filtered page lists two publications to select");
  tick(app, ids);
  const format = app.doc.getElementById("export-format");
  format.value = "ris";
  format.dispatchEvent(new app.win.Event("change", { bubbles: true }));
  return { storage, result, ids, snapshot: app.win.__amiraHost.snapshot };
}

test("bibliography: a replayed result in a new iframe restores its filters, selection and format", async (t) => {
  const { storage, result, ids, snapshot } = await workedBibliography(t);
  assert.ok(snapshot, "the app's own search named its snapshot");
  const state = saved(storage, "A");
  assert.equal(state.view, "bibliography");
  assert.deepEqual(state.state.selected.map((p) => p.id), ids);
  assert.equal(state.state.format, "ris");
  assert.ok(JSON.stringify(state).length < lib.VIEW_STATE_MAX_CHARS);

  // The iframe is recreated and the host replays the original result.
  const again = await mount(t, "search_publications", { storage });
  again.show(result, { instance: "A" });
  await again.waitFor(() => lastCall(again, "search_publications")?.args.year_from === 2000, "restoring search");
  await again.waitFor(() => text(again.doc.getElementById("selection-count")) === "2 selected (maximum 25)", "selection restored");
  assertHealthy(again);
  assert.equal(again.root.querySelector('input[name="year_from"]').value, "2000");
  assert.equal(again.doc.getElementById("export-format").value, "ris");
  assert.deepEqual(checked(again), ids);
  // The model is told about the restored records, with their current AMIRA links.
  const shared = again.lastShared();
  assert.deepEqual(shared.records.map((r) => r.id), ids);
  for (const r of shared.records) assert.match(r.amira_url, /\/s\/amira\/item\/\d+$/);
});

test("bibliography: another instance keeps its own state; a host result with nothing saved starts fresh", async (t) => {
  const { storage, result } = await workedBibliography(t);
  const before = storage.get("A");
  const other = await mount(t, "search_publications", { storage });
  other.show(result, { instance: "B" });
  assertHealthy(other);
  assert.equal(text(other.doc.getElementById("selection-count")), "0 selected (maximum 25)");
  assert.ok(!other.calls.some((c) => c.name === "search_publications"), "nothing to restore: no search");
  assert.equal(storage.get("A"), before, "instance A untouched");
  assert.equal(saved(storage, "B").state.selected.length, 0);
});

test("bibliography: a changed snapshot drops the selection and says so; corrupt state is ignored", async (t) => {
  const { storage, result } = await workedBibliography(t);
  const stale = saved(storage, "A");
  stale.snapshot = "an-older-snapshot";
  storage.set("A", JSON.stringify(stale));
  const again = await mount(t, "search_publications", { storage });
  again.show(result, { instance: "A" });
  await again.waitFor(() => /updated since this view was saved/.test(again.status()), "stale notice");
  assert.equal(text(again.doc.getElementById("selection-count")), "0 selected (maximum 25)");
  assert.equal(again.root.querySelector('input[name="year_from"]').value, "2000", "filters still apply");
  assertHealthy(again);

  storage.set("A", "{not json");
  const fresh = await mount(t, "search_publications", { storage });
  fresh.show(result, { instance: "A" });
  assertHealthy(fresh);
  assert.equal(text(fresh.doc.getElementById("selection-count")), "0 selected (maximum 25)");
});

test("bibliography: clearing the selection clears it from the saved state", async (t) => {
  const { storage, result } = await workedBibliography(t);
  const app = await mount(t, "search_publications", { storage });
  app.show(result, { instance: "A" });
  await app.waitFor(() => text(app.doc.getElementById("selection-count")) === "2 selected (maximum 25)", "restored");
  app.click(app.doc.getElementById("clear-selection"));
  assert.deepEqual(saved(storage, "A").state.selected, []);
  assert.deepEqual(checked(app), []);
});

test("map: a replayed result reopens the selected place with its records", async (t) => {
  const storage = new Map();
  const app = await mount(t, "list_locations", { storage });
  const d = await payload("list_locations");
  app.show(d, { instance: "M" });
  // The map's own load names the snapshot; then the reader opens a place.
  app.submit(app.root.querySelector("#map-filter"));
  await app.waitFor(() => app.win.__amiraHost.snapshot && lastCall(app, "list_locations"), "map load named the snapshot");
  await app.waitFor(() => app.root.querySelector("button[data-place]"), "map rendered");
  const name = app.root.querySelector("button[data-place]").dataset.place;
  app.click(app.root.querySelector(`button[data-place="${name}"]`));
  await app.waitFor(() => app.root.querySelector("#map-evidence li"), "place records");
  await app.waitFor(() => saved(storage, "M").state.place?.name === name, "place saved");

  const again = await mount(t, "list_locations", { storage });
  again.show(d, { instance: "M" });
  await again.waitFor(() => lastCall(again, "search_research_items"), "records reloaded");
  await again.waitFor(() => again.root.querySelector("#map-evidence li"), "records shown");
  assertHealthy(again);
  assert.ok(text(again.root.querySelector("#map-evidence")).startsWith(name));
  assert.equal(again.lastShared().focus[0].title, name);
});

test("graph: a replayed result reselects the neighbour and its link's records", async (t) => {
  const storage = new Map();
  const app = await mount(t, "get_entity_graph", { storage });
  const seed = (await payload("resolve_entity", { query: "Beier" })).results[0].id;
  const d = await payload("get_entity_graph", { seed });
  app.show(d, { instance: "G", snapshot: d.snapshot_id });
  const neighbour = app.root.querySelector("g[data-pick]").dataset.pick;
  app.click(app.root.querySelector("g[data-pick]"));
  await app.waitFor(() => app.root.querySelector("#evidence li"), "evidence");
  await app.waitFor(() => saved(storage, "G").state.edge, "edge saved");
  const state = saved(storage, "G").state;
  assert.equal(state.picked, neighbour);

  const again = await mount(t, "get_entity_graph", { storage });
  again.show(d, { instance: "G", snapshot: d.snapshot_id });
  await again.waitFor(() => again.root.querySelector("#pick h2") && again.root.querySelector("#evidence li"), "neighbour restored");
  assertHealthy(again);
  assert.ok(again.root.querySelector(`g.node-link.picked[data-pick="${neighbour}"]`));
  assert.equal(lastCall(again, "get_entity_graph").args.edge_id, state.edge);

  // A saved neighbour from another snapshot is not reselected.
  const stale = saved(storage, "G");
  stale.snapshot = "an-older-snapshot";
  storage.set("G", JSON.stringify(stale));
  const old = await mount(t, "get_entity_graph", { storage });
  old.show(d, { instance: "G", snapshot: d.snapshot_id });
  await old.waitFor(() => /updated since this view was saved/.test(old.status()), "stale notice");
  assert.equal(old.root.querySelector("g.node-link.picked"), null);
});

// --- the server's stamp and the store --------------------------------------------

test("restorable tools stamp a fresh viewUUID and their snapshot in _meta; others and errors do not", async () => {
  const one = await conn.raw("search_publications", {});
  const two = await conn.raw("search_publications", {});
  assert.match(one._meta[lib.VIEW_UUID_META], /^[0-9a-f-]{36}$/);
  assert.notEqual(one._meta[lib.VIEW_UUID_META], two._meta[lib.VIEW_UUID_META], "a new call is a new instance");
  assert.equal(typeof one._meta[lib.SNAPSHOT_META], "string");
  for (const tool of lib.RESTORABLE_TOOLS) {
    const args = tool === "get_entity_graph" ? { seed: "person:100" } : {};
    assert.ok((await conn.raw(tool, args))._meta?.[lib.VIEW_UUID_META], tool);
  }
  assert.equal((await conn.raw("list_years", {}))._meta?.[lib.VIEW_UUID_META], undefined);
  const error = await conn.raw("get_entity_graph", { seed: "person:999999" });
  assert.ok(error.isError);
  assert.equal(error._meta?.[lib.VIEW_UUID_META], undefined);
});

/** A Storage over a Map, optionally failing. */
function memoryStorage({ fail = false } = {}) {
  const map = new Map();
  const guard = () => {
    if (fail) throw new Error("SecurityError");
  };
  return {
    map,
    getItem: (k) => {
      guard();
      return map.has(k) ? map.get(k) : null;
    },
    setItem: (k, v) => {
      guard();
      map.set(k, String(v));
    },
    removeItem: (k) => {
      guard();
      map.delete(k);
    },
  };
}

test("ViewStore: versioned, bounded, evicting, and silent when storage fails", () => {
  const storage = memoryStorage();
  const store = new lib.ViewStore(() => storage);
  assert.equal(store.load("x"), null);
  assert.equal(store.save("x", "map", "snap", { place: null }), true);
  assert.deepEqual({ ...store.load("x"), saved_at: 0 },
    { v: lib.VIEW_STATE_VERSION, view: "map", snapshot: "snap", saved_at: 0, state: { place: null } });

  // Another version, a non-object state, or corrupt JSON is nothing saved.
  storage.setItem("amira-view:y", JSON.stringify({ v: 99, view: "map", state: {} }));
  storage.setItem("amira-view:z", JSON.stringify({ v: 1, view: "map", state: [1] }));
  storage.setItem("amira-view:w", "{");
  for (const key of ["y", "z", "w"]) assert.equal(store.load(key), null, key);

  assert.equal(store.save("big", "bibliography", null, { text: "x".repeat(lib.VIEW_STATE_MAX_CHARS) }), false, "over the cap");
  assert.equal(store.load("big"), null);

  for (let i = 0; i < lib.VIEW_STATE_MAX_ENTRIES + 5; i++) store.save(`k${i}`, "graph", null, { i });
  assert.equal(store.load("x"), null, "the oldest are evicted");
  assert.equal(store.load("k4"), null);
  const last = `k${lib.VIEW_STATE_MAX_ENTRIES + 4}`;
  assert.deepEqual(store.load(last).state, { i: lib.VIEW_STATE_MAX_ENTRIES + 4 });
  store.forget(last);
  assert.equal(store.load(last), null);

  const broken = new lib.ViewStore(() => memoryStorage({ fail: true }));
  assert.equal(broken.save("x", "map", null, {}), false);
  assert.equal(broken.load("x"), null);
  broken.forget("x");
  const refused = new lib.ViewStore(() => {
    throw new Error("SecurityError");
  });
  assert.equal(refused.save("x", "map", null, {}), false);
  assert.equal(refused.load("x"), null);
});

test("instanceKey: the viewUUID, else the host's call id, else the content", () => {
  const content = [{ type: "text", text: "{}" }];
  assert.equal(lib.instanceKey({ _meta: { viewUUID: "u-1" }, content }, 7), "uuid:u-1");
  assert.equal(lib.instanceKey({ content }, 7), "call:7");
  assert.equal(lib.instanceKey({ content }, "abc"), "call:abc");
  const hashed = lib.instanceKey({ content });
  assert.match(hashed, /^hash:[0-9a-f]{8}$/);
  assert.equal(lib.instanceKey({ _meta: {}, content }), hashed, "a replay without _meta keeps its key");
  assert.notEqual(lib.instanceKey({ content: [{ type: "text", text: '{"a":1}' }] }), hashed);
  assert.equal(lib.snapshotOf({ _meta: { "amira/snapshot": "s1" } }), "s1");
  assert.equal(lib.snapshotOf({}), null);
});
