// Token-budget instrumentation for the tool layer (D10 — token discipline is
// part of the tool layer, not a later pass).
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
//              cap is a hard failure while drift against the baseline is only a
//              warning: otherwise a routine `npm run fetch-data` reds the build.
//
// Tokens are estimated as bytes/4 rather than run through a real tokenizer. A
// regression gate needs determinism and zero dependencies more than it needs
// ±10% accuracy, and bytes/4 is the same scale GitHub uses for its own CI
// schema-budget guardrail. Compare these numbers to other numbers from this
// script — never to a billing statement.
//
// Usage:
//   node scripts/weigh.mjs              report only
//   node scripts/weigh.mjs --check      report + exit 1 on any hard breach (CI)
//   node scripts/weigh.mjs --update     rewrite test/token-baseline.json
//   node scripts/weigh.mjs --json       machine-readable report on stdout
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.join(HERE, "..", "test", "token-baseline.json");

// --- budgets -----------------------------------------------------------------

/** Hard ceiling for a single transport's `tools/list`, per turn. */
export const SURFACE_TOKEN_BUDGET = 10_000;

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

/** Response growth that earns a printed warning (never a failure — see above). */
export const RESPONSE_DRIFT_TOLERANCE = 0.1;

/** Ask for far more than any tool allows; `capLimit` clamps to the real maximum
 * and echoes `effective_limit`. Beats parsing "max 100" out of descriptions. */
const OVER_LIMIT = 100_000;

/**
 * Required arguments that cannot be synthesised from the schema alone, as one or
 * more variants per tool. `list_categories` gets one probe per enum value
 * because the facets differ by an order of magnitude in size and averaging them
 * would hide the expensive one.
 */
const REQUIRED_ARGS = {
  search: [{ suffix: "max", args: { query: "Africa" } }],
  list_categories: [
    { suffix: "formats", args: { category: "formats" } },
    { suffix: "languages", args: { category: "languages" } },
    { suffix: "resource_types", args: { category: "resource_types" } },
  ],
};

/**
 * Tools whose probe needs a live id/name/value, supplied by the discovery pass
 * below. The automatic pass skips them silently rather than reporting them as
 * unmeasured — they ARE measured, just not from the schema alone.
 */
const DISCOVERED = new Set([
  "get_research_item",
  "get_person",
  "get_project",
  "get_research_section",
  "get_institution",
  "get_publication",
  "get_podcast",
  "get_video",
  "find_related",
  "fetch",
]);

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

/** Call a tool and return its raw text body (concatenated, as a client sees it). */
async function callText(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return (res.content ?? []).map((c) => c.text ?? "").join("");
}

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
};

/**
 * Build the response probe list.
 *
 * Tools that take arguments the schema fully describes are probed automatically
 * — at their clamped maximum where they paginate — so a NEW search/list tool
 * enters the budget the day it is registered rather than whenever someone
 * remembers to add it here. Detail tools need a real id/name, so those are
 * discovered from the loaded snapshot instead of hard-coded: ids churn, and a
 * probe list that rots is a probe list that gets deleted.
 *
 * Returns `{ probes, skipped }`; anything undiscoverable is reported, never
 * silently dropped.
 */
export async function buildProbes(client) {
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  const probes = [];
  const skipped = [];

  for (const tool of tools) {
    if (DISCOVERED.has(tool.name)) continue; // covered by the discovery pass below
    const props = tool.inputSchema?.properties ?? {};
    const paginated = "limit" in props;
    const required = tool.inputSchema?.required ?? [];
    const variants = REQUIRED_ARGS[tool.name] ?? [{ suffix: paginated ? "max" : null, args: {} }];
    for (const variant of variants) {
      const unmet = required.filter((k) => k !== "limit" && !(k in variant.args));
      if (unmet.length) {
        skipped.push(`${tool.name} (unsatisfied required args: ${unmet.join(", ")})`);
        continue;
      }
      probes.push({
        id: variant.suffix ? `${tool.name}@${variant.suffix}` : tool.name,
        tool: tool.name,
        args: { ...variant.args, ...(paginated ? { limit: OVER_LIMIT } : {}) },
      });
    }
  }

  // --- detail tools: discover one live id/name per family ---------------------
  const results = async (tool, args) => parseJson(await callText(client, tool, args)).results ?? [];
  const first = async (tool, args) => (await results(tool, args))[0];
  const add = (id, tool, args) => {
    if (names.has(tool)) probes.push({ id, tool, args });
  };
  const miss = (what) => skipped.push(`${what} (nothing in the snapshot to probe with)`);

  const item = await first("search_research_items", { limit: 1 });
  if (item?.id) add("get_research_item", "get_research_item", { id: item.id });
  else miss("get_research_item");

  const person = await first("search_persons", { limit: 1 });
  if (person?.name) add("get_person", "get_person", { name: person.name });
  else miss("get_person");

  const project = await first("search_projects", { limit: 1 });
  if (project?.id) add("get_project", "get_project", { id: project.id });
  else miss("get_project");

  // list_research_sections and get_institution key on `name`, not on an id.
  const section = await first("list_research_sections", {});
  if (section?.name) add("get_research_section", "get_research_section", { name: section.name });
  else miss("get_research_section");

  const institution = await first("list_institutions", { limit: 1 });
  if (institution?.name) add("get_institution", "get_institution", { name: institution.name });
  else miss("get_institution");

  // The opt-in text paths matter most: they are the only calls that can return
  // CHARACTER_LIMIT (25,000) chars of body in one go, so this asserts the cap
  // actually holds rather than trusting that it does.
  const pub = await first("search_publications", { has_fulltext: true, limit: 1 });
  if (pub?.id) add("get_publication@fulltext", "get_publication", { id: pub.id, include_fulltext: true });
  else miss("get_publication@fulltext");

  const pod = (await results("search_podcasts", { limit: OVER_LIMIT })).find((p) => p.has_transcript);
  if (pod?.id) add("get_podcast@transcript", "get_podcast", { id: pod.id, include_transcript: true });
  else miss("get_podcast@transcript");

  const vid = (await results("search_videos", { limit: OVER_LIMIT })).find((v) => v.has_transcript);
  if (vid?.id) add("get_video@transcript", "get_video", { id: vid.id, include_transcript: true });
  else miss("get_video@transcript");

  // `fetch` with every text switch on is the heaviest single call the server can
  // be asked to make. Its ids are typed `<kind>:<omeka_id>` (src/tools/openai.ts).
  if (pub?.id) add("fetch@fulltext", "fetch", { id: `pub:${pub.id}`, include_fulltext: true });
  else if (names.has("fetch")) miss("fetch@fulltext");

  if (names.has("find_related")) {
    const subject = await first("list_subjects", { limit: 1 });
    if (subject?.subject) {
      probes.push({
        id: "find_related@max",
        tool: "find_related",
        args: { entity_type: "subject", value: subject.subject, limit: OVER_LIMIT },
      });
    } else miss("find_related");
  }

  return { probes, skipped };
}

/**
 * Run every probe and weigh its response body.
 *
 * A probe that ERRORS is recorded as such rather than counted: a structured
 * refusal is ~60 tokens, so a probe with stale arguments would otherwise sail
 * under every cap and report the tool as cheap when it was never called at all.
 */
export async function measureResponses(client, probes) {
  const out = {};
  for (const probe of probes) {
    let text;
    let failure = null;
    try {
      text = await callText(client, probe.tool, probe.args);
      if (parseJson(text).error) failure = parseJson(text).error.message ?? "tool returned an error";
    } catch (e) {
      text = "";
      failure = String(e?.message ?? e).slice(0, 200);
    }
    out[probe.id] = {
      tokens: estimateTokens(text),
      chars: text.length,
      args: probe.args,
      ...(failure ? { error: failure } : {}),
    };
  }
  return out;
}

// --- budget checks -----------------------------------------------------------

const pct = (now, was) => (was > 0 ? (now - was) / was : 0);
const sign = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;

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
 * Gate the response probes. The absolute cap fails; drift only warns, because
 * these numbers move with the snapshot and a data refresh must not red the build.
 */
export function checkResponses(current, baseline) {
  const failures = [];
  const notes = [];
  for (const [id, { tokens, error }] of Object.entries(current)) {
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
  for (const id of Object.keys(baseline ?? {})) {
    if (!(id in current)) notes.push(`  probe ${id} no longer measured (was ${baseline[id].tokens} tokens)`);
  }
  return { failures, notes };
}

export async function readBaseline() {
  try {
    return JSON.parse(await fs.readFile(BASELINE_PATH, "utf8"));
  } catch {
    return null;
  }
}

// --- CLI ---------------------------------------------------------------------

const num = (n) => n.toLocaleString("en-US");

async function main() {
  const argv = new Set(process.argv.slice(2));
  const check = argv.has("--check");
  const update = argv.has("--update");
  const asJson = argv.has("--json");

  process.env.AMIRA_LIVE_REFRESH ??= "0";
  const lib = await import("../server/lib.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const { Client } = await import("@modelcontextprotocol/client");

  /** Connect an in-process client to a freshly built server. */
  async function connect(opts) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = lib.createAmiraServer(opts);
    const client = new Client({ name: "weigh", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server, close: () => Promise.all([client.close(), server.close()]) };
  }

  // Both shipped surfaces: the .mcpb/stdio build and the HTTP build, which adds
  // the ChatGPT `search`/`fetch` pair. They are billed to different clients, so
  // each gets its own budget rather than being averaged into one number.
  const stdio = await connect({});
  const surfaceStdio = await measureSurface(stdio.client);
  await stdio.close();

  const http = await connect({ openai: true });
  const surfaceHttp = await measureSurface(http.client);
  const { probes, skipped } = await buildProbes(http.client);
  const responses = await measureResponses(http.client, probes);
  await http.close();

  const current = { surface: { stdio: surfaceStdio, http: surfaceHttp }, responses };
  const baseline = await readBaseline();

  const results = [
    checkSurface("stdio", surfaceStdio, baseline?.surface?.stdio),
    checkSurface("http", surfaceHttp, baseline?.surface?.http),
    checkResponses(responses, baseline?.responses),
  ];
  const failures = results.flatMap((r) => r.failures);

  if (asJson) {
    console.log(JSON.stringify({ ...current, failures }, null, 2));
  } else {
    console.log("AMIRA token budget — estimate is bytes/4, comparable only to itself.\n");
    for (const [label, s] of [
      ["stdio (.mcpb)", surfaceStdio],
      ["http (+ChatGPT)", surfaceHttp],
    ]) {
      const over = s.total_tokens > SURFACE_TOKEN_BUDGET ? "  OVER BUDGET" : "";
      console.log(
        `SURFACE  ${label.padEnd(16)} ${num(s.total_tokens).padStart(7)} tok  ` +
          `${String(s.tool_count).padStart(3)} tools  budget ${num(SURFACE_TOKEN_BUDGET)}${over}`,
      );
    }
    const heaviest = Object.entries(surfaceHttp.tools).slice(0, 5);
    console.log(`         heaviest: ${heaviest.map(([n, t]) => `${n} ${t}`).join(" · ")}\n`);

    console.log(`RESPONSES at each tool's maximum limit — cap ${num(RESPONSE_TOKEN_BUDGET)} tok`);
    for (const [id, r] of Object.entries(responses).sort(([, a], [, b]) => b.tokens - a.tokens)) {
      const flag = r.error ? `  CALL FAILED: ${r.error}` : r.tokens > RESPONSE_TOKEN_BUDGET ? "  OVER CAP" : "";
      console.log(`  ${num(r.tokens).padStart(7)} tok  ${num(r.chars).padStart(8)} ch  ${id}${flag}`);
    }
    if (skipped.length) {
      console.log(`\n  NOT MEASURED (${skipped.length}):`);
      for (const s of skipped) console.log(`    - ${s}`);
    }

    const notes = results.flatMap((r) => r.notes);
    if (notes.length) {
      console.log(`\nCHANGES vs baseline:`);
      for (const n of notes) console.log(n.startsWith(" ") ? n : `  ${n}`);
    } else if (!baseline) {
      console.log("\nNo baseline yet — run with --update to write one.");
    } else if (!failures.length) {
      // Only claim this once nothing failed: a breach is recorded as a failure,
      // not a note, so an unqualified "no change" here would contradict the
      // error block printed moments later.
      console.log("\nNo change vs baseline.");
    }
  }

  if (update) {
    // `args` are deliberately dropped: the discovered ids change with every data
    // refresh and would churn the committed file without telling anyone anything.
    const payload = {
      _comment:
        "Token baseline for the AMIRA tool layer, in bytes/4 estimated tokens. Regenerate with " +
        "`npm run weigh -- --update` and commit the diff: the cost of a schema or summary change " +
        "belongs in code review. See scripts/weigh.mjs for the two budgets and why drift is fatal " +
        "for the surface but only a warning for responses.",
      surface: current.surface,
      responses: Object.fromEntries(
        Object.entries(current.responses).map(([id, r]) => [id, { tokens: r.tokens, chars: r.chars }]),
      ),
    };
    await fs.writeFile(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`\nbaseline written: ${path.relative(process.cwd(), BASELINE_PATH)}`);
  }

  if (failures.length) {
    console.error(`\nTOKEN BUDGET FAILURES (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    if (check) process.exit(1);
  } else if (check) {
    console.log("\ntoken budget OK");
  }
}

// Only run the CLI when invoked directly — test/unit/budget.test.mjs imports the
// measurement helpers and must not trigger a real-snapshot run.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
