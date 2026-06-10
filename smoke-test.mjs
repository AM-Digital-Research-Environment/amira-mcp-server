// MCP round-trip smoke test: spawn the bundled server, list tools, exercise
// every tool family (including the get_* detail tools and transcript search),
// and assert the citation contract: amira_url everywhere, dashboard_url gone.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/index.js"],
  stderr: "inherit",
  env: { ...process.env, AMIRA_LIVE_REFRESH: "0" }, // offline: bundled snapshot only
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
function check(cond, label) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
check(tools.tools.length === 23, `expected 23 tools, got ${tools.tools.length}`);

async function call(name, args, { expect = [] } = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  console.log(`\n[${name}] ${body.slice(0, 260).replace(/\s+/g, " ")}${body.length > 260 ? "…" : ""}`);
  check(!body.includes("dashboard_url"), `${name}: no dashboard_url`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    check(false, `${name}: response is valid JSON`);
    return {};
  }
  check(!parsed.error || expect.includes("error"), `${name}: no unexpected error (got: ${parsed.error ?? ""})`);
  for (const e of expect) if (e !== "error") check(JSON.stringify(parsed).includes(e), `${name}: contains ${e}`);
  return parsed;
}

const AMIRA = "https://data.africamultiple.uni-bayreuth.de/s/amira/item/";

const overview = await call("get_collection_overview", {}, { expect: ["podcasts", "youtube_videos"] });
check(overview.counts?.research_items >= 3975, "overview: >= 3975 research items (v0.2.0 parity)");
check(overview.counts?.publications >= 240, "overview: >= 240 publications");

const search = await call("search_research_items", { subject: "Islam", limit: 3 }, { expect: [AMIRA] });
check(search.results?.[0]?.amira_url?.startsWith(AMIRA), "search: amira_url shape");

await call("search_research_items", { location: "Nigeria", resource_type: "Image", limit: 2 });
await call("search_research_items", { language: "fre", limit: 1 }, { expect: [AMIRA] }); // legacy code alias

const item = await call("get_research_item", { dre_id: "abg-99-0000" }, { expect: [AMIRA, "sponsors"] });
check(item.contributors?.some((c) => c.name === "Beier, Ulli"), "item: contributor with role");
check("dates" in item, "item: dates exposed");
check(Array.isArray(item.collections), "item: collections exposed");
check("thumbnail" in item, "item: thumbnail exposed");

await call("search_projects", { research_section: "Arts & Aesthetics", limit: 3 }, { expect: [AMIRA] });
const proj = await call("get_project", { id: "Ext_ILAM" }, { expect: ["External"] });
check(proj.item_count >= 1000, "Ext_ILAM has its ~1k items");

await call("list_research_sections", {}, { expect: ["funding_phase"] });
await call("get_research_section", { name: "Translating" }, { expect: ["AM 2.0"] });
await call("list_subjects", { limit: 5 }, { expect: [AMIRA] });
await call("list_locations", { level: "country", limit: 5 });
await call("list_categories", { category: "formats", limit: 5 });

const colls = await call("list_collections", { limit: 5 }, { expect: ["item-set"] });
check(colls.results?.[0]?.item_count > 0, "collections: ranked by item count");
if (colls.results?.[0]?.collection) {
  const byColl = await call("search_research_items", { collection: colls.results[0].collection, limit: 2 });
  check(byColl.total_matches === colls.results[0].item_count, "collection filter round-trips the count");
}
await call("search_persons", { keyword: "Beier", limit: 3 }, { expect: [AMIRA] });

const person = await call("get_person", { name: "Ulli Beier" });
check(person.name === "Beier, Ulli", "get_person: canonical name resolved from either order");
check(person.contributed_item_count > 0, "get_person: contributions found");

const insts = await call("list_institutions", { keyword: "Bayreuth", limit: 3 });
if (insts.results?.[0]?.name) {
  const inst = await call("get_institution", { name: insts.results[0].name }, { expect: [AMIRA] });
  check(typeof inst.contributed_item_count === "number", "get_institution: contributed_item_count");
}
const groups = await call("list_groups", { limit: 3 });
if (groups.results?.[0]?.name) {
  await call("get_institution", { name: groups.results[0].name }, { expect: ["group"] });
}

const pubs = await call("search_publications", { limit: 3 }, { expect: [AMIRA] });
if (pubs.results?.[0]?.id) {
  await call("get_publication", { id: pubs.results[0].id }, { expect: ["bibtex"] });
}

await call("find_related", { entity_type: "subject", value: "Architecture", limit: 8 });

const pods = await call("search_podcasts", { limit: 3 });
if (pods.results?.[0]?.id) await call("get_podcast", { id: pods.results[0].id });

const vids = await call("search_videos", { keyword: "Africa", limit: 3 });
check(vids.total_matches > 0, "videos: keyword search hits");
const transcriptHit = (await call("search_videos", { keyword: "decolonial", limit: 3 })).results?.find(
  (v) => v.matched_in === "transcript",
);
if (vids.results?.[0]?.id) {
  const vid = await call("get_video", { id: vids.results[0].id });
  check("transcript_length" in vid, "get_video: transcript_length present");
}
console.log(`\ntranscript-only hit found: ${transcriptHit ? "yes" : "no (keyword may appear in titles too)"}`);

await client.close();
await transport.close();

if (failures > 0) {
  console.error(`\nsmoke test FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nsmoke test complete — all checks passed");
