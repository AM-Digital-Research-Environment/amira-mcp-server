// Snapshot-lifecycle invariants (the D9/D11 guarantees the 1.0 rewrite was
// built around): manifest-last validity, schema-version and count-mismatch
// rejection, atomic promotion, and the two-signal freshness comparison.
// All offline, against temp dirs, through the shipped server/lib.js.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  isStale,
  loadSnapshot,
  SNAPSHOT_SCHEMA_VERSION,
  writeSnapshot,
  writeSnapshotAtomic,
} from "../../server/lib.js";
import { buildFixture } from "../fixtures/fixture-data.mjs";

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "amira-snap-"));
}

test("write → load roundtrip preserves data and manifest", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  await writeSnapshot(dir, out);
  const loaded = await loadSnapshot(dir);
  assert.equal(loaded.manifest.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(loaded.data.research_items.length, out.data.research_items.length);
  assert.equal(loaded.data.journals.length, out.data.journals.length);
  assert.equal(loaded.data.publications[0].fulltext, out.data.publications[0].fulltext);
});

test("a snapshot with the wrong schema version is rejected", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSnapshot(dir, buildFixture(SNAPSHOT_SCHEMA_VERSION - 1));
  await assert.rejects(loadSnapshot(dir), /schema v/);
});

test("a corpus/manifest count mismatch is rejected (torn-write guard)", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const out = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  await writeSnapshot(dir, out);
  const tampered = [...out.data.persons, { o_id: 999, name: "Extra, Person", affiliations: [] }];
  await fs.writeFile(path.join(dir, "persons.json"), JSON.stringify(tampered));
  await assert.rejects(loadSnapshot(dir), /persons/);
});

test("a dir without manifest.json is not loadable (manifest written last)", async (t) => {
  const dir = await tempDir();
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeSnapshot(dir, buildFixture(SNAPSHOT_SCHEMA_VERSION));
  await fs.rm(path.join(dir, "manifest.json"));
  await assert.rejects(loadSnapshot(dir));
});

test("writeSnapshotAtomic promotes cleanly and leaves no staging dir", async (t) => {
  const parent = await tempDir();
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const dest = path.join(parent, "current");
  await writeSnapshotAtomic(dest, buildFixture(SNAPSHOT_SCHEMA_VERSION));
  const first = await loadSnapshot(dest);
  assert.equal(first.manifest.schemaVersion, SNAPSHOT_SCHEMA_VERSION);

  // A second promote replaces the first without leaving staging behind.
  const next = buildFixture(SNAPSHOT_SCHEMA_VERSION);
  next.manifest.fetchedAt = "2026-07-06T00:00:00.000Z";
  await writeSnapshotAtomic(dest, next);
  const second = await loadSnapshot(dest);
  assert.equal(second.manifest.fetchedAt, "2026-07-06T00:00:00.000Z");
  const leftovers = (await fs.readdir(parent)).filter((n) => n.startsWith(".staging-"));
  assert.deepEqual(leftovers, []);
});

test("isStale: only a newer remote signal (either of the D11 pair) triggers", () => {
  const local = buildFixture(SNAPSHOT_SCHEMA_VERSION).manifest;
  assert.equal(isStale(local, { maxModified: local.maxModified, totalItems: local.totalItemsOnInstance }), false);
  assert.equal(isStale(local, { maxModified: "2026-07-04T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), true, "newer o:modified");
  assert.equal(isStale(local, { maxModified: local.maxModified, totalItems: local.totalItemsOnInstance + 1 }), true, "changed totals (covers deletions)");
  assert.equal(isStale(local, { maxModified: "2026-06-01T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), false, "older remote never refreshes");
  assert.equal(isStale({ ...local, maxModified: null }, { maxModified: "2026-01-01T00:00:00+00:00", totalItems: local.totalItemsOnInstance }), true, "local without signal defers to remote");
});
