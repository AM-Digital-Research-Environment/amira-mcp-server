// Remote-transport smoke test: spawn server/http.js, connect a real MCP client
// over Streamable HTTP, and exercise the OpenAI-compatible search/fetch tools
// plus a rich tool — proving the HTTP endpoint serves the full surface offline.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { z } from "zod";

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
  // offline (bundled snapshot); limiter off so the smoke run itself can never
  // trip it — the limiter gets its own server below.
  env: {
    ...process.env,
    PORT,
    HOST: "127.0.0.1",
    AMIRA_LIVE_REFRESH: "0",
    AMIRA_RATE_LIMIT: "0",
    AMIRA_ALLOWED_ORIGINS: "https://example.test",
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let client;
try {
  // Health endpoint reports identity + the MCP path.
  await waitReady(`${BASE}/healthz`);
  const health = await (await fetch(`${BASE}/healthz`)).json();
  check(health.status === "ok", "healthz: ready status reported");
  check(health.transport === "streamable-http", "healthz: transport reported");
  check(health.mcp_endpoint === "/mcp", "healthz: mcp_endpoint reported");
  check(health.data_snapshot?.research_items >= 3975, "healthz: snapshot counts reported");
  check(health.data_snapshot?.publications >= 270, "healthz: publication count reported");
  check(typeof health.data_snapshot?.fetched_at === "string", "healthz: snapshot freshness reported");

  // CORS preflight must satisfy BOTH protocol revisions: the 2026-07-28 headers
  // (Mcp-Method / Mcp-Name, required on every Streamable HTTP POST) alongside
  // the pre-2026 ones, or browser clients fail preflight.
  const preflight = await fetch(`${BASE}/mcp`, {
    method: "OPTIONS",
    headers: { Origin: "https://example.test", "Access-Control-Request-Method": "POST" },
  });
  const allowed = (preflight.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  check(preflight.status === 204, "CORS: preflight answered");
  check(preflight.headers.get("access-control-allow-origin") === "*", "CORS: origin allowed");
  for (const h of ["mcp-method", "mcp-name", "x-mcp-header", "mcp-session-id", "mcp-protocol-version"]) {
    check(allowed.includes(h), `CORS: ${h} allowed`);
  }

  // MCP 2026-07-28 requires every present Origin to be validated. An explicit
  // allow-list permits the browser client above; unrelated origins fail closed.
  const rejectedOrigin = await fetch(`${BASE}/mcp`, {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.example", "Access-Control-Request-Method": "POST" },
  });
  check(rejectedOrigin.status === 403, "Origin validation: unconfigured browser origin rejected");

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  client = new Client({ name: "smoke-http", version: "0.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  console.log(`tools (${names.length}):`, names.join(", "));
  check(names.length === 28, `expected 28 tools over HTTP, got ${names.length}`);
  check(names.includes("search") && names.includes("fetch"), "HTTP exposes search + fetch");
  check(names.includes("list_cluster_partners"), "HTTP exposes cluster partner tool");
  check(names.includes("list_journals"), "HTTP exposes the journals tool");
  check(names.includes("get_collection_overview"), "HTTP exposes the rich tools too");
  const searchTool = tools.tools.find((t) => t.name === "search");
  check(!!searchTool?.outputSchema, "search declares an outputSchema (structured-output contract)");

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
  check(/^(item|pub|video|podcast|project|section):\d+$/.test(first?.id ?? ""), "search: typed id uses Omeka numeric id");
  check(first.url.includes("/s/amira/item/"), "search: result url is the AMIRA record page");

  // fetch(id) → {id,title,text,url,metadata}
  const doc = await call("fetch", { id: first.id });
  check(doc.id === first.id, "fetch: echoes id");
  check(typeof doc.text === "string" && doc.text.length > 0, "fetch: text body present");
  check(typeof doc.url === "string" && doc.url.startsWith("http"), "fetch: url present");
  check(doc.url.includes("/s/amira/item/"), "fetch: url is the AMIRA record page");
  check(!!doc.metadata, "fetch: metadata present");
  check(!("dre_id" in (doc.metadata ?? {})), "fetch: metadata does not expose DRE ids");

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
    onlyPubs.results?.length > 0 &&
      onlyPubs.results.every((r) => r.id.startsWith("pub:") && r.url.includes("/s/amira/item/")),
    "search: types filter restricts record kinds and keeps AMIRA urls",
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
        check(typeof def.metadata?.watch_url === "string", "fetch: video keeps watch_url as secondary metadata");
      const withT = await call("fetch", { id: vidHit.id, include_transcript: true });
      check(withT.metadata?.transcript_included === true, "fetch: include_transcript=true appends the transcript");
      check(withT.text.length > def.text.length, "fetch: text body grows when transcript included");
      // transcript paging aligns with get_video/get_podcast (the report's one real
      // cross-tool inconsistency): transcript_offset / transcript_max_chars window it.
      const paged = await call("fetch", {
        id: vidHit.id,
        include_transcript: true,
        transcript_offset: 0,
        transcript_max_chars: 200,
      });
      check(paged.metadata?.transcript_returned_chars === 200, "fetch: transcript_max_chars windows the transcript");
      check(paged.metadata?.transcript_offset === 0, "fetch: transcript_offset echoed");
      check(paged.metadata?.transcript_truncated === true, "fetch: windowed transcript flags more remaining");
    }
  }

  // publication FULL TEXT over fetch: omitted by default, opt-in + windowed
  // (same params as get_publication — the shared textWindowAppend contract).
  const ftSearch = await call("search", { query: "zxqvjkqzweirdtoken" });
  check(Array.isArray(ftSearch.results) && ftSearch.results.length === 0, "search: nonsense query returns empty results");
  const ftPub = (await call("search_publications", { has_fulltext: true, limit: 1 })).results?.[0];
  if (ftPub) {
    const def = await call("fetch", { id: `pub:${ftPub.omeka_id}` });
    check(def.metadata?.has_fulltext === true, "fetch: publication reports has_fulltext");
    check(def.metadata?.fulltext_included === false, "fetch: publication fulltext omitted by default");
    check(typeof def.metadata?.fulltext_hint === "string", "fetch: omitted fulltext carries an opt-in hint");
    const paged = await call("fetch", { id: `pub:${ftPub.omeka_id}`, include_fulltext: true, fulltext_offset: 0, fulltext_max_chars: 300 });
    check(paged.metadata?.fulltext_included === true, "fetch: include_fulltext=true appends the full text");
    check(paged.metadata?.fulltext_returned_chars === 300, "fetch: fulltext_max_chars windows the full text");
    check(paged.metadata?.fulltext_truncated === true, "fetch: windowed fulltext flags more remaining");
    check(paged.text.length > def.text.length, "fetch: text body grows when fulltext included");
  }

  // a rich tool works over HTTP too
  const overview = await call("get_collection_overview", {});
  check(overview.counts?.research_items >= 3975, "rich tool over HTTP: overview parity");
  check(overview.counts?.journals >= 50, "rich tool over HTTP: journals corpus present");

  // Skills over MCP on the REMOTE surface — the reason the extension is worth
  // having. ChatGPT, Claude.ai connectors and the APIs cannot install a local
  // skill folder, so this transport is the only way the companion skill reaches
  // them. The snapshot is embedded in the bundle, so it survives a container
  // that ships no .claude/ directory at all.
  const caps = client.getServerCapabilities();
  check(caps?.extensions?.["io.modelcontextprotocol/skills"]?.directoryRead === true, "HTTP: skills extension declared");
  const skillList = await client.request({ method: "skills/list", params: {} }, z.looseObject({}));
  check(skillList.skills?.[0]?.uri === "skill://amira-mcp/SKILL.md", "HTTP: skills/list serves the companion skill");
  check(skillList.skills?.[0]?.resources?.length === 4, "HTTP: complete resource manifest");
  const skillDoc = await client.readResource({ uri: "skill://amira-mcp/SKILL.md" });
  const skillText = skillDoc.contents?.[0]?.text ?? "";
  check(skillText.includes("amira_url"), "HTTP: SKILL.md body readable over resources/read");
  check(
    `sha256:${createHash("sha256").update(Buffer.from(skillText, "utf8")).digest("hex")}` ===
      skillList.skills[0].resources.find((r) => r.uri === "skill://amira-mcp/SKILL.md")?.digest,
    "HTTP: digest verifies against the manifest",
  );

  await client.close();

  // --- rate limiting (its own server, so the checks above stay unthrottled) ---
  const RL_PORT = String(Number(PORT) + 1);
  const rlChild = spawn(process.execPath, ["server/http.js"], {
    env: { ...process.env, PORT: RL_PORT, HOST: "127.0.0.1", AMIRA_LIVE_REFRESH: "0", AMIRA_RATE_LIMIT: "3" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  try {
    const rlBase = `http://127.0.0.1:${RL_PORT}`;
    await waitReady(`${rlBase}/healthz`);
    const post = () =>
      fetch(`${rlBase}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post()).status);
    check(!statuses.slice(0, 3).includes(429), `rate limit: first 3 pass (${statuses.join(",")})`);
    check(statuses.slice(3).every((s) => s === 429), `rate limit: 4th+ rejected (${statuses.join(",")})`);
    const limited = await post();
    check(!!limited.headers.get("retry-after"), "rate limit: Retry-After header set");
    // Health probes must stay exempt, or the container's HEALTHCHECK kills it.
    const health2 = await fetch(`${rlBase}/healthz`);
    check(health2.status === 200, "rate limit: /healthz exempt");
  } finally {
    rlChild.kill();
  }
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
