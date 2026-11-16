// Token-budget instrumentation for the tool layer (D10 — token discipline is
// part of the tool layer, not a later pass): the budgets, the surface
// measurement and the checks, shared by the `npm run weigh` CLI
// (scripts/weigh.mjs, which also discovers and runs the response probes) and by
// test/unit/budget.test.mjs.
//
// TWO budgets, measured separately because they behave differently:
//
//   SURFACE    the `tools/list` payload, re-sent on EVERY turn whether or not a
//              tool is called. No tool description or schema is derived from the
//              snapshot, so this number is fully deterministic — which is why
//              test/unit/budget.test.mjs gates it hard, against the fixture,
//              with no network and no real data.
//   RESPONSES  what a call actually returns at each tool's DOCUMENTED MAXIMUM
//              limit. The defaults were never the risk (a keyword search costs
//              ~165 tokens); the ceiling is — `search_research_items` at
//              limit=100 is ~15k. These vary with the snapshot, so the absolute
//              caps (tokens, and characters for Claude Code's file spill) are
//              hard failures while drift against the baseline is only a
//              warning: otherwise a routine `npm run fetch-data` reds the build.
//
// Tokens are estimated as bytes/4 rather than run through a real tokenizer. A
// regression gate needs determinism and zero dependencies more than it needs
// ±10% accuracy, and bytes/4 is the same scale GitHub uses for its own CI
// schema-budget guardrail. Compare these numbers to other numbers from this
// module — never to a billing statement.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.join(HERE, "..", "token-baseline.json");

// --- budgets -----------------------------------------------------------------

/** Hard ceiling for a single transport's `tools/list`, per turn. */
// Full profile now includes six research tools and their output schemas.
// Smaller profiles retain separate ceilings in budget.test.mjs.
export const SURFACE_TOKEN_BUDGET = 14_000;

/**
 * Surface growth that trips the gate. One new tool averages ~317 tokens (~3.6%),
 * so adding a tool DOES fail the build — deliberately. The fix is one command
 * (`npm run weigh -- --update`) and the resulting baseline diff is the point:
 * the cost of a new tool becomes a reviewable line in the pull request.
 */
export const SURFACE_DRIFT_TOLERANCE = 0.03;

/**
 * Hard ceiling for any single tool response. Claude Code truncates tool results
 * at 25,000 tokens; 20,000 keeps headroom for the bytes/4 estimate being wrong
 * in the pessimistic direction.
 */
export const RESPONSE_TOKEN_BUDGET = 20_000;

/**
 * Hard ceiling on any single response's text, in characters. Claude Code
 * persists a tool result over 50,000 characters to a file and hands the model
 * a preview instead, so a response at the limit silently stops being read in
 * full; 45,000 keeps headroom below that. Independent of the token cap above:
 * ASCII-heavy JSON can pass bytes/4 and still cross 50k characters.
 */
export const RESPONSE_CHAR_LIMIT = 45_000;

/** Response growth that earns a printed warning (never a failure — see above). */
export const RESPONSE_DRIFT_TOLERANCE = 0.1;

// --- measurement -------------------------------------------------------------

export const estimateTokens = (text) => Math.ceil(Buffer.byteLength(text, "utf8") / 4);

/** Weigh a connected server's `tools/list` payload, per tool and in total. */
export async function measureSurface(client) {
  const { tools } = await client.listTools();
  const perTool = {};
  let chars = 0;
  for (const tool of tools) {
    const json = JSON.stringify(tool);
    chars += json.length;
    perTool[tool.name] = estimateTokens(json);
  }
  return {
    tool_count: tools.length,
    total_chars: chars,
    total_tokens: Object.values(perTool).reduce((n, t) => n + t, 0),
    tools: Object.fromEntries(Object.entries(perTool).sort(([, a], [, b]) => b - a)),
  };
}

// --- budget checks -----------------------------------------------------------

const pct = (now, was) => (was > 0 ? (now - was) / was : 0);
const sign = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
/** A count with thousands separators, as the reports print it. */
export const num = (n) => n.toLocaleString("en-US");

/**
 * Gate one surface variant. Both the absolute cap and the drift are hard
 * failures: this payload is deterministic, so a change here is always a code
 * change someone made on purpose.
 */
export function checkSurface(label, current, baseline) {
  const failures = [];
  const notes = [];
  if (current.total_tokens > SURFACE_TOKEN_BUDGET) {
    failures.push(
      `surface ${label}: ${current.total_tokens} tokens exceeds the ${SURFACE_TOKEN_BUDGET} budget ` +
        `(${current.tool_count} tools). Trim descriptions or drop a tool.`,
    );
  }
  const was = baseline?.total_tokens;
  if (was) {
    const drift = pct(current.total_tokens, was);
    if (drift > SURFACE_DRIFT_TOLERANCE) {
      failures.push(
        `surface ${label}: ${was} → ${current.total_tokens} tokens (${sign(drift)}), over the ` +
          `${(SURFACE_DRIFT_TOLERANCE * 100).toFixed(0)}% drift tolerance. If the growth is intended, ` +
          `run \`npm run weigh -- --update\` and commit the baseline.`,
      );
    } else if (current.total_tokens !== was) {
      notes.push(`surface ${label}: ${was} → ${current.total_tokens} tokens (${sign(drift)})`);
    }
    for (const [name, tokens] of Object.entries(current.tools)) {
      const before = baseline.tools?.[name];
      if (before === undefined) notes.push(`  new tool ${name}: ${tokens} tokens`);
      else if (before !== tokens) notes.push(`  ${name}: ${before} → ${tokens} (${sign(pct(tokens, before))})`);
    }
    for (const name of Object.keys(baseline.tools ?? {})) {
      if (!(name in current.tools)) notes.push(`  removed tool ${name} (was ${baseline.tools[name]} tokens)`);
    }
  }
  return { failures, notes };
}

/**
 * Gate the response probes. The absolute caps fail; drift only warns, because
 * these numbers move with the snapshot and a data refresh must not red the build.
 */
export function checkResponses(current, baseline) {
  const failures = [];
  const notes = [];
  const oversized = [];
  for (const [id, { tokens, chars, error }] of Object.entries(current)) {
    if (error) {
      failures.push(`probe ${id} did not measure anything — the call failed: ${error}`);
      continue;
    }
    if (tokens > RESPONSE_TOKEN_BUDGET) {
      failures.push(
        `response ${id}: ${tokens} tokens exceeds the ${RESPONSE_TOKEN_BUDGET} cap. Lower the tool's ` +
          `max limit, or slim its per-result summary.`,
      );
    }
    if (chars >= RESPONSE_CHAR_LIMIT) oversized.push(`${id} (${num(chars)} chars)`);
    const was = baseline?.[id]?.tokens;
    if (!was) {
      notes.push(`  new probe ${id}: ${tokens} tokens`);
      continue;
    }
    const drift = pct(tokens, was);
    if (Math.abs(drift) > RESPONSE_DRIFT_TOLERANCE) {
      notes.push(`  WARN ${id}: ${was} → ${tokens} tokens (${sign(drift)})`);
    } else if (tokens !== was) {
      notes.push(`  ${id}: ${was} → ${tokens} (${sign(drift)})`);
    }
  }
  // A probe that silently drops out (its discovery found nothing in a new
  // snapshot) would take that tool out of the D10 gate without anything going
  // red. Removing one on purpose means re-recording the baseline.
  for (const id of Object.keys(baseline ?? {})) {
    if (!(id in current)) {
      failures.push(`probe ${id} is no longer measured (was ${baseline[id].tokens} tokens). If that is intended, ` +
        "run `npm run weigh -- --update` and commit the baseline.");
    }
  }
  if (oversized.length) {
    failures.push(
      `responses at or over ${num(RESPONSE_CHAR_LIMIT)} characters (Claude Code spills results over 50,000 ` +
        `characters to a file): ${oversized.join(", ")}. Lower the tool's max limit or slim its summaries.`,
    );
  }
  return { failures, notes };
}

/**
 * Identity of the snapshot a measurement ran against. `snapshot_id` is the
 * server's own hash (the one get_entity_graph pins) over api base, fetchedAt,
 * maxModified and counts; fetchedAt is kept beside it for humans.
 */
export function snapshotIdentity(lib, store) {
  const m = store.manifest;
  return {
    snapshot_id: typeof lib.snapshotId === "function" ? lib.snapshotId(m) : null,
    fetchedAt: m.fetchedAt,
    maxModified: m.maxModified ?? null,
    schemaVersion: m.schemaVersion,
  };
}

/**
 * The baseline file for `--update`. Refuses a run with a failed or unmeasured
 * probe: a failed call weighs 0 tokens, and a 0-token baseline entry reads as
 * "new" on every later run, so that probe's drift would never be compared again.
 * `args` are deliberately dropped: the discovered ids change with every data
 * refresh and would churn the committed file without telling anyone anything.
 */
export function baselinePayload(current, skipped = []) {
  const failed = Object.entries(current.responses).filter(([, r]) => r.error).map(([id, r]) => `${id}: ${r.error}`);
  if (failed.length || skipped.length) {
    throw new Error(`refusing to write a baseline with unmeasured probes:\n  ${[...failed, ...skipped].join("\n  ")}`);
  }
  return {
    _comment:
      "Token baseline for the AMIRA tool layer, in bytes/4 estimated tokens. Regenerate with " +
      "`npm run weigh -- --update` and commit the diff: the cost of a schema or summary change " +
      "belongs in code review. See scripts/weigh.mjs for the two budgets and why drift is fatal " +
      "for the surface but only a warning for responses. `snapshot` names the data/ snapshot the " +
      "responses were measured against.",
    snapshot: current.snapshot,
    surface: current.surface,
    responses: Object.fromEntries(
      Object.entries(current.responses).map(([id, r]) => [id, { tokens: r.tokens, chars: r.chars, text_bytes: r.text_bytes, wire_bytes: r.wire_bytes }]),
    ),
  };
}

/** Whether two snapshot identities name the same data (id if both have one). */
export function sameSnapshot(a, b) {
  if (!a || !b) return false;
  if (a.snapshot_id && b.snapshot_id) return a.snapshot_id === b.snapshot_id;
  return a.fetchedAt === b.fetchedAt;
}

export async function readBaseline() {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}
