// Remote-transport smoke test: spawn server/http.js, connect a real MCP client
// over Streamable HTTP, and exercise the OpenAI-compatible search/fetch tools
// plus a rich tool — proving the HTTP endpoint serves the full surface offline.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn } from "node:child_process";

const PORT = process.env.SMOKE_HTTP_PORT || "8799";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(cond, label) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

async function waitReady(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server not ready at ${url} after ${timeoutMs}ms`);
}

const child = spawn(process.execPath, ["server/http.js"], {
  env: { ...process.env, PORT, HOST: "127.0.0.1", AMIRA_LIVE_REFRESH: "0" }, // offline: bundled snapshot
  stdio: ["ignore", "inherit", "inherit"],
});

let client;
try {
  // Health endpoint reports identity + the MCP path.
  await waitReady(`${BASE}/healthz`);
  const health = await (await fetch(`${BASE}/healthz`)).json();
  check(health.transport === "streamable-http", "healthz: transport reported");
  check(health.mcp_endpoint === "/mcp", "healthz: mcp_endpoint reported");

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  client = new Client({ name: "smoke-http", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`tools (${names.length}):`, names.join(", "));
  check(names.length === 26, `expected 26 tools over HTTP, got ${names.length}`);
  check(names.includes("search") && names.includes("fetch"), "HTTP exposes search + fetch");
  check(names.includes("get_collection_overview"), "HTTP exposes the rich tools too");

  async function call(name, args) {
    const res = await client.callTool({ name, arguments: args });
    const body = res.content?.[0]?.text ?? "";
    console.log(`\n[${name}] ${body.slice(0, 220).replace(/\s+/g, " ")}${body.length > 220 ? "…" : ""}`);
    return JSON.parse(body);
  }

  // search → {results:[{id,title,url}]}
  const search = await call("search", { query: "Yoruba" });
  check(Array.isArray(search.results) && search.results.length > 0, "search: results returned");
  const first = search.results?.[0];
  check(!!first?.id && !!first?.title && !!first?.url, "search: result has id/title/url");
  check(/^(item|pub|video|podcast|project|section):/.test(first?.id ?? ""), "search: typed id");

  // fetch(id) → {id,title,text,url,metadata}
  const doc = await call("fetch", { id: first.id });
  check(doc.id === first.id, "fetch: echoes id");
  check(typeof doc.text === "string" && doc.text.length > 0, "fetch: text body present");
  check(typeof doc.url === "string" && doc.url.startsWith("http"), "fetch: url present");
  check(!!doc.metadata, "fetch: metadata present");

  // transcript reach: a term likely only inside a video transcript
  const tv = await call("search", { query: "decolonial" });
  check(Array.isArray(tv.results), "search: transcript query returns results array");

  // token-aware matching: multi-word and natural-language queries must match
  // (the old whole-phrase substring search returned ~nothing for these)
  const multi = await call("search", { query: "Yoruba architecture wall painting" });
  check(multi.results?.length > 1, "search: multi-word query matches (tokenized)");
  const nl = await call("search", { query: "which projects study migration in West Africa" });
  check(nl.results?.length > 0, "search: natural-language query returns results");

  // response-size controls (report §1): limit + types
  const limited = await call("search", { query: "Africa", limit: 3 });
  check((limited.results?.length ?? 99) <= 3, "search: limit caps the result set");
  const onlyPubs = await call("search", { query: "Africa", types: ["publication"] });
  check(
    onlyPubs.results?.length > 0 && onlyPubs.results.every((r) => r.id.startsWith("pub:")),
    "search: types filter restricts record kinds",
  );

  // fetch transcript control on a video (report §fetch): OMITTED BY DEFAULT now
  // (a full transcript can be tens of thousands of chars and tripped ChatGPT's
  // safety layer); opt in with include_transcript=true.
  const vidHit = (await call("search", { query: "decolonial", types: ["video"] })).results?.[0];
  if (vidHit) {
    const def = await call("fetch", { id: vidHit.id });
    if (def.metadata?.has_transcript) {
      check(def.metadata?.transcript_included === false, "fetch: video transcript omitted by default");
      check(typeof def.metadata?.transcript_hint === "string", "fetch: omitted transcript carries an opt-in hint");
      const withT = await call("fetch", { id: vidHit.id, include_transcript: true });
      check(withT.metadata?.transcript_included === true, "fetch: include_transcript=true appends the transcript");
      check(withT.text.length > def.text.length, "fetch: text body grows when transcript included");
    }
  }

  // a rich tool works over HTTP too
  const overview = await call("get_collection_overview", {});
  check(overview.counts?.research_items >= 3975, "rich tool over HTTP: overview parity");

  await client.close();
} catch (err) {
  failures++;
  console.error(`  FAIL: unexpected error — ${err?.stack || err}`);
} finally {
  try {
    await client?.close();
  } catch {
    /* already closed */
  }
  child.kill();
}

if (failures > 0) {
  console.error(`\nHTTP smoke test FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nHTTP smoke test complete — all checks passed");
process.exit(0);
