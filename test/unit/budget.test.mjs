// Tool-surface token budget — the payload every turn pays for whether or not a
// tool is called.
//
// This runs OFFLINE against no data at all, which is the whole point: not one
// tool description or schema is derived from the snapshot, so the surface is a
// pure function of the code. That invariant is asserted here too (the numbers
// measured with an empty store must equal the baseline `npm run weigh` recorded
// against the full snapshot) — if it ever breaks, someone made a description
// data-dependent and this test stopped being a valid gate.
//
// Response weight is NOT checked here: it needs the real snapshot, so it lives
// in the smoke job (`npm run weigh -- --check`).
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

// Hermetic BEFORE the bundle is imported — config reads the environment at
// module load, and the cache must be isolated or a real snapshot left in
// ~/.amira-mcp/cache by `npm run test:live` outranks the empty fixture dir.
hermeticEnv({ dataDir: true });

const lib = await import("../../server/lib.js");
const { measureSurface, checkSurface, readBaseline, SURFACE_TOKEN_BUDGET, SURFACE_DRIFT_TOLERANCE } = await import(
  "../../scripts/weigh.mjs"
);

const baseline = await readBaseline();

/** Measure one transport's surface through a real in-process client. */
async function surfaceOf(opts) {
  const conn = await connectInMemory(lib, opts, { name: "budget" });
  try {
    return await measureSurface(conn.client);
  } finally {
    await conn.close();
  }
}

// stdio ships in the .mcpb; http adds the ChatGPT search/fetch pair. They are
// billed to different clients, so each carries its own budget.
const VARIANTS = [
  ["stdio", {}],
  ["http", { openai: true }],
];

test("a token baseline is committed", () => {
  assert.ok(baseline, "test/token-baseline.json is missing — run `npm run weigh -- --update`");
});

for (const [label, opts] of VARIANTS) {
  test(`surface budget: ${label} fits in ${SURFACE_TOKEN_BUDGET} tokens per turn`, async () => {
    const surface = await surfaceOf(opts);
    assert.ok(
      surface.total_tokens <= SURFACE_TOKEN_BUDGET,
      `${label}: ${surface.total_tokens} tokens over the ${SURFACE_TOKEN_BUDGET} budget ` +
        `(${surface.tool_count} tools). Trim descriptions or drop a tool.`,
    );
  });

  test(`surface budget: ${label} has not drifted past ${(SURFACE_DRIFT_TOLERANCE * 100).toFixed(0)}%`, async () => {
    const surface = await surfaceOf(opts);
    const { failures, notes } = checkSurface(label, surface, baseline?.surface?.[label]);
    assert.deepEqual(failures, [], `${failures.join("; ")}\n${notes.join("\n")}`);
  });

  test(`surface budget: ${label} baseline covers every registered tool`, async () => {
    const surface = await surfaceOf(opts);
    const recorded = new Set(Object.keys(baseline?.surface?.[label]?.tools ?? {}));
    const missing = Object.keys(surface.tools).filter((n) => !recorded.has(n));
    // A cheap new tool can slip under the drift tolerance; the baseline must
    // still record what it costs, so its price lands in the review diff.
    assert.deepEqual(
      missing,
      [],
      `tools absent from the baseline: ${missing.join(", ")} — run \`npm run weigh -- --update\``,
    );
  });

  test(`surface budget: ${label} is data-independent`, async () => {
    const surface = await surfaceOf(opts);
    const recorded = baseline?.surface?.[label];
    // Measured here with an EMPTY store, in the baseline with the full snapshot.
    assert.equal(
      surface.total_chars,
      recorded?.total_chars,
      `${label}: the surface measured without data (${surface.total_chars} chars) differs from the ` +
        `baseline measured with it (${recorded?.total_chars}). Either the baseline is stale, or a tool ` +
        `description is now derived from the snapshot — which would make this whole test invalid.`,
    );
  });
}

for (const [profile, budget] of [["research", 10_000], ["discovery", 6_500], ["visualization", 9_500]]) {
  test(`${profile} profile stays within its deliberate discovery budget`, async () => {
    const surface = await surfaceOf({ openai: true, profile });
    assert.ok(surface.total_tokens <= budget, `${profile}: ${surface.total_tokens} > ${budget}`);
  });
}
