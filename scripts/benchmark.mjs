// Offline, sequential MCP round trips against the bundled snapshot. This is
// a local latency baseline, not an HTTP load test or a retrieval-quality eval.
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { hermeticEnv } from "../test/helpers/env.mjs";

const iterations = Number(process.env.AMIRA_BENCH_ITERATIONS ?? 30);
if (!Number.isInteger(iterations) || iterations < 5 || iterations > 1000) {
  throw new Error("AMIRA_BENCH_ITERATIONS must be an integer between 5 and 1000");
}
// Hermetic before the bundle loads: every AMIRA_* cleared (iterations were
// read above), live refresh off, a throwaway cache removed on exit, and the
// shipped data/ snapshot measured — never ~/.amira-mcp/cache.
hermeticEnv();
process.env.AMIRA_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));
process.env.AMIRA_EXPOSURE = "full";

const { createAmiraServer, ensureStore } = await import("../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");
const server = createAmiraServer({ openai: true });
const client = new Client({ name: "amira-benchmark", version: "1.0.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const round = (n) => Number(n.toFixed(2));
try {
  const loadStart = performance.now();
  const store = await ensureStore();
  const loadMs = performance.now() - loadStart;
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const cases = [
    ["overview", "get_collection_overview", {}],
    ["subjects", "list_subjects", { limit: 25 }],
    ["locations", "list_locations", { limit: 25 }],
    ["timeline", "list_years", { bucket: "decade" }],
    ["item_keyword", "search_research_items", { keyword: "architecture", limit: 20 }],
    ["empty_combination", "search_research_items", { subject: "architecture", location: "Nigeria", language: "French", resource_type: "Audio" }],
    ["related", "find_related", { entity_type: "subject", value: "Architecture", limit: 20 }],
    ["publications", "search_publications", { keyword: "migration", limit: 20 }],
    ["search_all", "search", { query: "African migration and identity", limit: 10 }],
    ["search_projects", "search", { query: "African migration and identity", types: ["project"], limit: 10 }],
  ];
  const results = [];
  for (const [label, name, args] of cases) {
    const samples = [];
    let response;
    for (let i = 0; i <= iterations; i++) {
      const start = performance.now();
      response = await client.callTool({ name, arguments: args });
      const elapsed = performance.now() - start;
      if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.content)}`);
      samples.push(elapsed);
    }
    const firstMs = samples.shift();
    samples.sort((a, b) => a - b);
    results.push({ label, tool: name, args, first_ms: round(firstMs),
      median_ms: round(samples[Math.floor(samples.length / 2)]),
      p95_ms: round(samples[Math.ceil(samples.length * 0.95) - 1]),
      text_bytes: Buffer.byteLength(response.content.filter((c) => c.type === "text").map((c) => c.text).join("")),
      result_bytes: Buffer.byteLength(JSON.stringify(response)),
    });
  }
  const factoryStart = performance.now();
  for (let i = 0; i < iterations; i++) await createAmiraServer({ openai: true }).close();
  const factoryMs = (performance.now() - factoryStart) / iterations;
  const tools = (await client.listTools()).tools;
  console.log(JSON.stringify({ node: process.version, snapshot: store.manifest,
    iterations, transport: "in-memory", exposure: "full", snapshot_load_ms: round(loadMs),
    server_factory_mean_ms: round(factoryMs), tool_count: tools.length,
    tools_with_output_schema: tools.filter((t) => t.outputSchema).length,
    heap_used_mib: round(process.memoryUsage().heapUsed / 1024 / 1024), results,
  }, null, 2));
} finally {
  await client.close();
  await server.close();
}
