// Store lifecycle (src/data.ts): the singleton must not latch a startup
// failure, and currentStore() must reflect what is actually being served.
//
// node --test runs each file in its own process, so this file can point the
// config at a directory that does not exist yet — config reads the environment
// at module load, hence the env setup before the dynamic import.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";

// The data dir is deliberately absent at first; the cache is a fresh empty
// temp dir, so it cannot mask the failure.
const { dataDir } = hermeticEnv({ dataDir: "absent" });

const lib = await import("../../server/lib.js");

test("a failed initial load is retried, not latched forever", async () => {
  assert.equal(lib.currentStore(), null, "nothing served before the first load");

  await assert.rejects(lib.ensureStore(), /snapshot/i, "missing snapshot fails loudly");
  // The rejection must not be cached: before this fix every later caller
  // awaited the same rejected promise, and the HTTP surface pinned /healthz at
  // 503 with no way back even once the data became readable.
  await assert.rejects(lib.ensureStore(), /snapshot/i, "second attempt still fails, cleanly");
  assert.equal(lib.currentStore(), null);

  // Make the snapshot readable — the next call must recover.
  await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));
  const store = await lib.ensureStore();
  assert.equal(store.source, "bundled");
  assert.equal(store.items.length, 4);
  assert.equal(lib.currentStore(), store, "currentStore() serves what ensureStore() resolved");

  // And it is memoised from then on.
  assert.equal(await lib.ensureStore(), store);
});
