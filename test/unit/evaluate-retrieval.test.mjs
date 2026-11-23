// scripts/evaluate-retrieval.mjs scores every query at the depth k it asked for:
// a run where a tool cannot return k rows is refused, never scored with the
// missing rows counted as misses. Run as a child process over a fixture
// snapshot (--data), as a contributor would run it.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { childEnv, hermeticEnv, REPO_ROOT, tempDir } from "../helpers/env.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

/** Run the evaluator on `judgments` at depth `k`; returns its exit status, stderr and report (or null). */
function evaluate(judgments, k) {
  const dir = tempDir("evaluate");
  const input = path.join(dir, "judgments.json"), output = path.join(dir, "report.json");
  writeFileSync(input, JSON.stringify(judgments));
  const run = spawnSync(process.execPath,
    [path.join(REPO_ROOT, "scripts", "evaluate-retrieval.mjs"), "--judgments", input, "--output", output, "--k", String(k), "--data", dataDir],
    { env: childEnv(), encoding: "utf8", timeout: 60_000 });
  return { status: run.status, stderr: run.stderr, report: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null };
}

test("evaluate-retrieval: a depth within every tool's limit is scored and reported at that k", () => {
  const run = evaluate([{ query: "archive", relevant_ids: ["1"] }, { query: "archive", tool: "search_publications", relevant_ids: [] }], 10);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.report.k, 10);
  assert.equal(run.report.queries, 2);
  assert.deepEqual(run.report.results.map((r) => r.args.limit), [10, 10], "each tool is asked for k rows");
});

test("evaluate-retrieval: a depth beyond a tool's limit is refused, not scored as misses", () => {
  // Cross-corpus `search` returns at most 50: at k=80 its 30 missing rows would read as ranking failures.
  const run = evaluate([{ query: "archive", relevant_ids: ["1"] }], 80);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Cannot score at k=80/);
  assert.match(run.stderr, /"archive": search returns at most 50 results/);
  assert.equal(run.report, null, "no report is written");

  // search_publications goes to 100, so the same depth is fine there.
  assert.equal(evaluate([{ query: "archive", tool: "search_publications", relevant_ids: [] }], 80).status, 0);
});

test("evaluate-retrieval: a judgment whose own limit is below k is refused before anything runs", () => {
  const run = evaluate([{ query: "archive", args: { limit: 5 }, relevant_ids: [] }], 10);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /own limit is below k=10.*"archive" \(limit 5\)/);
  assert.equal(run.report, null);
  assert.equal(evaluate([{ query: "archive", args: { limit: 20 }, relevant_ids: [] }], 10).status, 0, "a larger limit is fine");
});
