// The token-budget CLI (`npm run weigh`) for the tool layer (D10). The two
// budgets (SURFACE and RESPONSES), the surface measurement and the checks live
// in test/helpers/budget.mjs, shared with test/unit/budget.test.mjs; this file
// discovers and runs the response probes and prints the report.
//
// What is measured is ALWAYS the data/ snapshot (the one the .mcpb ships, or
// CI's fresh crawl): the run clears every AMIRA_* variable, forces
// AMIRA_LIVE_REFRESH=0 and points AMIRA_CACHE_DIR at a throwaway dir, so a
// newer snapshot in ~/.amira-mcp/cache can never outrank it. The baseline
// records which snapshot it was measured against (`snapshot`), and --check
// says so when the current one differs: response drift notes are then
// comparisons across two datasets, not a code change.
//
// Tokens are estimated as bytes/4 (test/helpers/budget.mjs says why). Compare
// these numbers to other numbers from this script — never to a billing statement.
//
// Usage:
//   node scripts/weigh.mjs              report only
//   node scripts/weigh.mjs --check      report + exit 1 on any hard breach (CI)
//   node scripts/weigh.mjs --update     rewrite test/token-baseline.json
//   node scripts/weigh.mjs --json       machine-readable report on stdout
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASELINE_PATH,
  RESPONSE_CHAR_LIMIT,
  RESPONSE_TOKEN_BUDGET,
  SURFACE_TOKEN_BUDGET,
  baselinePayload,
  checkResponses,
  checkSurface,
  estimateTokens,
  measureSurface,
  num,
  readBaseline,
  sameSnapshot,
  snapshotIdentity,
} from "../test/helpers/budget.mjs";
import { hermeticEnv } from "../test/helpers/env.mjs";
import { connectInMemory } from "../test/helpers/mcp.mjs";

// --- probes --------------------------------------------------------------------

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
  search_publications: [
    { suffix: "max", args: {} },
    ...["bibtex", "ris", "csl-json"].map((citation_format) => ({ suffix: citation_format, args: { citation_format } })),
  ],
  list_publication_facets: ["type", "year", "language", "subject", "author", "venue"].map((facet) => ({ suffix: facet, args: { facet } })),
  // List mode at its maximum, and one group's records at theirs.
  get_semantic_map: [
    { suffix: "max", args: {} },
    { suffix: "group", args: { group: 1 } },
  ],
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
  "get_chronicle",
  "find_related",
  "fetch",
  "resolve_entity", "get_entity_graph", "get_text_passages", "compare_collections",
  "get_similar_items",
]);

// --- measurement -------------------------------------------------------------

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
        args: { ...variant.args, ...(paginated ? { limit: props.limit.maximum ?? OVER_LIMIT } : {}) },
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
  // The heaviest answer: a full page of neighbours (low-signal seeds return none).
  const seeds = await results("search_research_items", { keyword: "music", limit: 20 });
  let similarSeed = null;
  for (const seed of seeds) {
    if (parseJson(await callText(client, "get_similar_items", { id: seed.id, limit: 10 })).count) { similarSeed = seed; break; }
  }
  if (similarSeed) {
    add("get_similar_items@max", "get_similar_items", { id: similarSeed.id, limit: 10 });
    // The semantic pivot: twenty neighbours' links, every related_* list at its cap.
    add("find_related@record", "find_related", { entity_type: "record", value: String(similarSeed.id), limit: OVER_LIMIT });
  } else {
    miss("get_similar_items");
    if (names.has("find_related")) miss("find_related@record");
  }

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
  if (pub?.id) {
    add("get_publication@fulltext", "get_publication", { id: pub.id, include_fulltext: true });
    // The heaviest detail answer: a full-text window plus five explained neighbours.
    add("get_publication@fulltext+similar", "get_publication", { id: pub.id, include_fulltext: true, include_similar: true });
  } else miss("get_publication@fulltext");
  if (pub?.id) {
    for (const citation_format of ["ris", "csl-json"]) {
      add(`get_publication@${citation_format}`, "get_publication", { id: pub.id, citation_format });
    }
  }

  const pod = (await results("search_podcasts", { limit: OVER_LIMIT })).find((p) => p.has_transcript);
  if (pod?.id) add("get_podcast@transcript", "get_podcast", { id: pod.id, include_transcript: true });
  else miss("get_podcast@transcript");

  const vid = (await results("search_videos", { limit: OVER_LIMIT })).find((v) => v.has_transcript);
  if (vid?.id) add("get_video@transcript", "get_video", { id: vid.id, include_transcript: true });
  else miss("get_video@transcript");

  const chron = (await results("search_chronicles", { limit: OVER_LIMIT })).find((c) => c.has_text);
  if (chron?.id) add("get_chronicle@text", "get_chronicle", { id: chron.id, include_text: true });
  else miss("get_chronicle@text");

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

  if (names.has("resolve_entity")) {
    add("resolve_entity@max", "resolve_entity", { query: "Afri", limit: 50 });
    // A densely linked person when the snapshot has him; otherwise the person
    // discovered above, so the probe survives a data change.
    const graphSeed = (await first("resolve_entity", { query: "Ulli Beier", type: "person" }))
      ?? (person?.name ? await first("resolve_entity", { query: person.name, type: "person" }) : undefined);
    if (graphSeed) add("get_entity_graph@max", "get_entity_graph", { seed: graphSeed.id, max_nodes: 100, max_edges: 200 });
    else miss("get_entity_graph");
    if (pub) add("get_text_passages@max", "get_text_passages", { ids: [`publication:${pub.omeka_id ?? pub.id}`], keyword: "the", radius: 500, limit: 20 });
    else miss("get_text_passages");
    const projects = await results("search_projects", { limit: 4 });
    if (projects.length >= 2) add("compare_collections@max", "compare_collections", { cohorts: projects.map((p) => ({ type: "project", id: String(p.omeka_id ?? p.id) })) });
    else miss("compare_collections");
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
    let result;
    let failure = null;
    try {
      result = await client.callTool({ name: probe.tool, arguments: probe.args });
      text = (result.content ?? []).map((c) => c.text ?? "").join("");
      if (parseJson(text).error) failure = parseJson(text).error.message ?? "tool returned an error";
    } catch (e) {
      text = "";
      failure = String(e?.message ?? e).slice(0, 200);
    }
    out[probe.id] = {
      tokens: estimateTokens(text),
      chars: text.length,
      text_bytes: Buffer.byteLength(text),
      wire_bytes: result ? Buffer.byteLength(JSON.stringify(result)) : 0,
      args: probe.args,
      ...(failure ? { error: failure } : {}),
    };
  }
  return out;
}

// --- CLI ---------------------------------------------------------------------

const describeSnapshot = (s) =>
  s ? `${s.fetchedAt}${s.snapshot_id ? ` (snapshot_id ${s.snapshot_id})` : ""}` : "not recorded";

async function main() {
  const argv = new Set(process.argv.slice(2));
  const check = argv.has("--check");
  const update = argv.has("--update");
  const asJson = argv.has("--json");

  // UNCONDITIONALLY hermetic, before the bundle loads: no AMIRA_* from the
  // shell (an exported AMIRA_LIVE_REFRESH=1 would start a crawl; an exposure
  // or profile setting would shrink the numbers), and a throwaway cache, so
  // the bundled data/ snapshot is what gets measured — never ~/.amira-mcp/cache.
  hermeticEnv();
  const lib = await import("../server/lib.js");
  const store = await lib.ensureStore();
  const snapshot = snapshotIdentity(lib, store);

  /** Connect an in-process client to a freshly built server. */
  const connect = (opts) => connectInMemory(lib, opts, { name: "weigh" });

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

  // The guidance ablation (AMIRA_GUIDANCE=off, src/guidance.ts): the same tools
  // without their titles and descriptions. Recording it puts the per-turn cost
  // of the guidance (the difference from the surfaces above) in the baseline.
  const surfaceOff = {};
  process.env.AMIRA_GUIDANCE = "off";
  try {
    for (const [label, opts] of [["stdio_guidance_off", {}], ["http_guidance_off", { openai: true }]]) {
      const conn = await connect(opts);
      surfaceOff[label] = await measureSurface(conn.client);
      await conn.close();
    }
  } finally {
    delete process.env.AMIRA_GUIDANCE;
  }

  const current = { snapshot, surface: { stdio: surfaceStdio, http: surfaceHttp, ...surfaceOff }, responses };
  const baseline = await readBaseline();
  const snapshotMatches = sameSnapshot(baseline?.snapshot, snapshot);

  const results = [
    ...Object.entries(current.surface).map(([label, s]) => checkSurface(label, s, baseline?.surface?.[label])),
    checkResponses(responses, baseline?.responses),
  ];
  const failures = results.flatMap((r) => r.failures);
  // An undiscoverable probe is a tool the gate does not cover.
  for (const s of skipped) failures.push(`not measured: ${s}`);

  if (asJson) {
    console.log(JSON.stringify({ ...current, baseline_snapshot: baseline?.snapshot ?? null, failures }, null, 2));
  } else {
    console.log("AMIRA token budget — estimate is bytes/4, comparable only to itself.\n");
    console.log(`SNAPSHOT current   ${describeSnapshot(snapshot)}  [${store.source}]`);
    console.log(`         baseline  ${describeSnapshot(baseline?.snapshot)}`);
    if (baseline && !baseline.snapshot) {
      console.log(
        "         The baseline predates snapshot recording (`--update` adds it): response drift below may " +
          "compare two datasets.",
      );
    } else if (baseline && !snapshotMatches) {
      console.log(
        "         DIFFERENT SNAPSHOT: response drift below compares two datasets, not a code change " +
          "(the surface is data-independent and still gated).",
      );
    }
    console.log("");
    for (const [label, s] of [
      ["stdio (.mcpb)", surfaceStdio],
      ["http (+ChatGPT)", surfaceHttp],
      ["stdio, guidance off", surfaceOff.stdio_guidance_off],
      ["http, guidance off", surfaceOff.http_guidance_off],
    ]) {
      const over = s.total_tokens > SURFACE_TOKEN_BUDGET ? "  OVER BUDGET" : "";
      console.log(
        `SURFACE  ${label.padEnd(19)} ${num(s.total_tokens).padStart(7)} tok  ` +
          `${String(s.tool_count).padStart(3)} tools  budget ${num(SURFACE_TOKEN_BUDGET)}${over}`,
      );
    }
    const heaviest = Object.entries(surfaceHttp.tools).slice(0, 5);
    console.log(`         heaviest: ${heaviest.map(([n, t]) => `${n} ${t}`).join(" · ")}\n`);

    console.log(
      `RESPONSES at each tool's maximum limit — caps ${num(RESPONSE_TOKEN_BUDGET)} tok, ` +
        `< ${num(RESPONSE_CHAR_LIMIT)} ch`,
    );
    for (const [id, r] of Object.entries(responses).sort(([, a], [, b]) => b.tokens - a.tokens)) {
      const flag = r.error
        ? `  CALL FAILED: ${r.error}`
        : r.tokens > RESPONSE_TOKEN_BUDGET
          ? "  OVER CAP"
          : r.chars >= RESPONSE_CHAR_LIMIT
            ? "  OVER CHAR LIMIT"
            : "";
      console.log(`  ${num(r.tokens).padStart(7)} tok  ${num(r.chars).padStart(8)} ch  ${id}${flag}`);
    }
    if (skipped.length) {
      console.log(`\n  NOT MEASURED (${skipped.length}):`);
      for (const s of skipped) console.log(`    - ${s}`);
    }

    const notes = results.flatMap((r) => r.notes);
    if (notes.length) {
      const caveat = baseline && !snapshotMatches
        ? baseline.snapshot ? " (response notes span two different snapshots)" : " (baseline snapshot unrecorded)"
        : "";
      console.log(`\nCHANGES vs baseline${caveat}:`);
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
    const payload = baselinePayload(current, skipped);
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

// Only run the CLI when invoked directly, so buildProbes and measureResponses
// can be imported without triggering a real-snapshot run.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
