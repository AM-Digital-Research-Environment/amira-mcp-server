// CI packaging/container fixture, never used by release workflows.
import { buildFixture } from "../test/fixtures/fixture-data.mjs";
import { writeSnapshotAtomic, SNAPSHOT_SCHEMA_VERSION } from "../server/lib.js";
await writeSnapshotAtomic("data", buildFixture(SNAPSHOT_SCHEMA_VERSION));
