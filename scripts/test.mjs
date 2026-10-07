// Node 20 does not expand test globs. Enumerate files instead of depending on
// the invoking shell (npm uses cmd.exe on Windows and sh on Unix).
//
//   node scripts/test.mjs unit   test/unit/*.test.mjs (offline, fixture data)
//   node scripts/test.mjs live   test/live/*.test.mjs (network: public Omeka API)
//
// The smoke tests (test/smoke/) are plain scripts, run by `npm run smoke` and
// `npm run smoke:http`, never by this runner.
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Per-test ceiling, so one hung request cannot hold a CI job for hours.
 * Tests that need longer set their own `{ timeout }`, which takes precedence. */
const TEST_TIMEOUT_MS = 60_000;

const suite = process.argv[2] ?? "unit";
if (!["unit", "live"].includes(suite)) throw new Error(`Unknown test suite: ${suite}`);
const dir = new URL(`../test/${suite}/`, import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort()
  .map((name) => fileURLToPath(new URL(name, dir)));
if (!files.length) throw new Error(`No tests found in ${suite}`);
const result = spawnSync(process.execPath, ["--test", `--test-timeout=${TEST_TIMEOUT_MS}`, ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
