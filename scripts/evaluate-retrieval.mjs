// Score retrieval against researcher-authored relevance judgments: the first
// step of ROADMAP "Retrieval effectiveness", and the measurement any change to
// the ranker (src/searchRanking.ts) or to keyword semantics should come with.
// Ported from the IWAC server's scripts/evaluate-retrieval.mjs.
//
//   npm run evaluate-retrieval -- --judgments judgments.json --output report.json [--k 10] [--data dir]
//
// judgments.json is an array of
//   { "query": "migration control", "tool": "search_publications",
//     "args": { "language": "en" }, "relevant_ids": ["29919", "publication:29949"] }
// `tool` defaults to the cross-corpus `search` (args become its `types`/`limit`
// filters); ids are Omeka ids, typed or not. Judge on the snapshot you score:
// the report records its snapshot_id so two runs can be compared honestly.
//
// Every query is scored at the depth k it asked for, never at less: a tool that
// caps its `limit` below k (cross-corpus `search` returns at most 50), a
// judgment whose own `limit` is below k, or a page the response budget cut
// short would count rows never returned as misses, which reads as a ranking
// failure. Such a run is refused and no report is written.
//
// Offline and hermetic, like scripts/benchmark.mjs: the shipped data/ snapshot
// (or the snapshot directory --data names), never the live API or ~/.amira-mcp/cache.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hermeticEnv } from "../test/helpers/env.mjs";

const { values } = parseArgs({
  options: {
    judgments: { type: "string" }, output: { type: "string" }, k: { type: "string", default: "10" }, data: { type: "string" },
  },
});
if (!values.judgments || !values.output) {
  throw new Error("Usage: npm run evaluate-retrieval -- --judgments judgments.json --output report.json [--k 10] [--data dir]");
}
const k = Number(values.k);
if (!Number.isInteger(k) || k < 1 || k > 100) throw new Error("k must be an integer between 1 and 100");
const judgments = JSON.parse(await readFile(values.judgments, "utf8"));
if (!Array.isArray(judgments) || judgments.length === 0) throw new Error("Provide a non-empty array of judgments");
const lowLimits = judgments.filter((j) => j.args?.limit !== undefined && !(Number.isInteger(j.args.limit) && j.args.limit >= k));
if (lowLimits.length) {
  throw new Error(`A judgment's own limit is below k=${k}, so it cannot be scored at that depth: ` +
    lowLimits.map((j) => `"${j.query}" (limit ${JSON.stringify(j.args.limit)})`).join(", "));
}

hermeticEnv();
process.env.AMIRA_DATA_DIR = values.data ? path.resolve(values.data) : fileURLToPath(new URL("../data", import.meta.url));
const { createAmiraServer, ensureStore, snapshotId } = await import("../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");

/** "publication:29949" and "29949" name the same record. */
const bare = (id) => String(id).replace(/^[a-z_]+:/, "");

/** Result ids in rank order, from a search_* page or the cross-corpus search. */
function rankedIds(body) {
  const rows = Array.isArray(body.results) ? body.results : [];
  return rows.map((row) => bare(row.omeka_id ?? row.id ?? ""));
}

function score(ranked, relevant) {
  const top = ranked.slice(0, k);
  const hits = top.map((id) => relevant.has(id));
  const found = hits.filter(Boolean).length;
  const dcg = hits.reduce((sum, hit, i) => sum + (hit ? 1 / Math.log2(i + 2) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant.size, k) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0);
  const first = hits.indexOf(true);
  return {
    precision: found / k,
    recall: relevant.size ? found / relevant.size : 0,
    ndcg: ideal ? dcg / ideal : 0,
    reciprocal_rank: first >= 0 ? 1 / (first + 1) : 0,
  };
}

const server = createAmiraServer({ openai: true });
const client = new Client({ name: "amira-retrieval-evaluation", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const reports = [];
/** Queries a tool could not serve at depth k. */
const shallow = [];
try {
  const store = await ensureStore();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  for (const judgment of judgments) {
    const tool = judgment.tool ?? "search";
    const args =
      tool === "search"
        ? { query: judgment.query, limit: k, ...judgment.args }
        : { keyword: judgment.query, limit: k, ...judgment.args };
    const relevant = new Set((judgment.relevant_ids ?? []).map(bare));
    const started = performance.now();
    const result = await client.callTool({ name: tool, arguments: args });
    const latency = performance.now() - started;
    const body = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "{}");
    const ranked = result.isError ? [] : rankedIds(body);
    // The tool says it capped the limit, or that the response budget ended the page early.
    if (typeof body.effective_limit === "number" && body.effective_limit < k) {
      shallow.push(`"${judgment.query}": ${tool} returns at most ${body.effective_limit} results`);
    } else if (body.response_limited && ranked.length < k) {
      shallow.push(`"${judgment.query}": ${tool}'s response budget ended the page at ${ranked.length} results`);
    }
    reports.push({
      query: judgment.query,
      tool,
      args,
      relevant: relevant.size,
      returned: ranked.length,
      total_matches: body.total_matches ?? null,
      ...(result.isError ? { error: body.error ?? body } : {}),
      ...score(ranked, relevant),
      latency_ms: Number(latency.toFixed(1)),
    });
  }
  if (shallow.length) {
    throw new Error(`Cannot score at k=${k}: rows a tool never returned would count as misses. ` +
      `Lower --k, or narrow these queries; no report written.\n  ${shallow.join("\n  ")}`);
  }
  const mean = (field) => reports.reduce((sum, r) => sum + r[field], 0) / reports.length;
  const report = {
    k,
    snapshot: { snapshot_id: snapshotId(store.manifest), fetched_at: store.manifest.fetchedAt, max_modified: store.manifest.maxModified ?? null },
    queries: reports.length,
    mean: { precision: mean("precision"), recall: mean("recall"), ndcg: mean("ndcg"), mrr: mean("reciprocal_rank") },
    results: reports,
  };
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `${reports.length} queries at k=${k}: P ${report.mean.precision.toFixed(3)}, R ${report.mean.recall.toFixed(3)}, ` +
      `nDCG ${report.mean.ndcg.toFixed(3)}, MRR ${report.mean.mrr.toFixed(3)} → ${values.output}`,
  );
} finally {
  await client.close();
  await server.close();
}
