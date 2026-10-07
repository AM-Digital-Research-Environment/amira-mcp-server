// CI packaging/container fixture, never used by release workflows. Writes the
// tiny test fixture into the repo's data/ (resolved from this file, not the
// cwd), hermetically: no AMIRA_* from the shell reaches the bundle.
import { fileURLToPath } from "node:url";
import { buildFixture } from "../test/fixtures/fixture-data.mjs";
import { hermeticEnv } from "../test/helpers/env.mjs";

hermeticEnv();
const { writeSnapshotAtomic, SNAPSHOT_SCHEMA_VERSION } = await import("../server/lib.js");
await writeSnapshotAtomic(fileURLToPath(new URL("../data", import.meta.url)), buildFixture(SNAPSHOT_SCHEMA_VERSION));
