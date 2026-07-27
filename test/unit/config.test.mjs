// Config resolution (src/config.ts) under MCPB template placeholders.
//
// manifest.json wires settings through `"AMIRA_SITE_BASE": "${user_config.site_base}"`.
// When an optional setting has no value the MCPB runtime passes that
// placeholder through VERBATIM rather than dropping the variable, so the
// process really receives the literal string. Taking it as a site base made
// every citation `${user_config.site_base}/s/amira/item/<id>` — reported in the
// wild against v1.7.0, which is why this is tested rather than assumed.
//
// node --test gives this file its own process, so the environment can be set
// before config reads it at module load.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildFixture } from "../fixtures/fixture-data.mjs";

const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "amira-config-"));

// Exactly what an MCPB install with every optional setting left blank passes.
// AMIRA_CACHE_DIR being a placeholder is part of the scenario AND does the
// isolation job for free: it resolves to the default ~/.amira-mcp/cache, so the
// counts assertion below points AMIRA_DATA_DIR at a fixture and asserts against
// it only after checking that no newer real cache is in play.
process.env.AMIRA_SITE_BASE = "${user_config.site_base}";
process.env.AMIRA_CACHE_DIR = "${user_config.cache_dir}";
process.env.AMIRA_LIVE_REFRESH = "${user_config.live_refresh}";
process.env.AMIRA_SITE_SLUG = "${user_config.site_slug}";
process.env.AMIRA_DATA_DIR = fixtureDir; // a REAL value must still win

const lib = await import("../../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

await lib.writeSnapshot(fixtureDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

const [ct, st] = InMemoryTransport.createLinkedPair();
const server = lib.createAmiraServer();
const client = new Client({ name: "config-unit", version: "0.0.0" });
await Promise.all([server.connect(st), client.connect(ct)]);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return JSON.parse(res.content?.[0]?.text ?? "{}");
}

test.after(async () => {
  await client.close();
  await server.close();
  await fs.rm(fixtureDir, { recursive: true, force: true });
});

test("unsubstituted MCPB placeholders never leak into citations", async () => {
  const overview = await call("get_collection_overview");
  assert.equal(overview.site_url, "https://data.africamultiple.uni-bayreuth.de");

  // The citation URL is the one that matters — it is the whole point of the
  // server, and it was broken on every record, not just in the overview.
  const items = await call("search_research_items", { limit: 1 });
  const url = items.results[0].amira_url;
  assert.ok(url.startsWith("https://data.africamultiple.uni-bayreuth.de/s/amira/item/"), url);

  // Nothing anywhere in a response may contain a template placeholder.
  for (const [tool, args] of [
    ["get_collection_overview", {}],
    ["search_research_items", { limit: 3 }],
    ["search_publications", { limit: 3 }],
    ["list_subjects", { limit: 3 }],
    ["list_locations", { limit: 3 }],
    ["get_research_item", { id: 500 }],
  ]) {
    const body = JSON.stringify(await call(tool, args));
    assert.ok(!body.includes("${"), `${tool} leaked a placeholder: ${body.slice(0, 200)}`);
  }
});

test("a real value still overrides, and the placeholder guard is narrow", () => {
  // Assert on the RESOLVED config rather than on record counts: the counts would
  // also depend on whether a real snapshot happens to sit in the default cache,
  // which is not what this test is about.
  assert.equal(lib.config.bundledDataDir, path.resolve(fixtureDir), "a genuine AMIRA_DATA_DIR wins");
  assert.ok(
    lib.config.cacheDir.includes(".amira-mcp"),
    `a placeholder AMIRA_CACHE_DIR falls back to the default, got ${lib.config.cacheDir}`,
  );
  assert.ok(!lib.config.cacheDir.includes("${"), "no placeholder became a directory name");
  assert.equal(lib.config.siteSlug, "amira", "a placeholder AMIRA_SITE_SLUG falls back");
  assert.equal(lib.config.liveRefresh, true, "a placeholder AMIRA_LIVE_REFRESH falls back to the default");

  // Only a whole-string ${...} is ignored; a URL that merely contains braces is
  // still a real setting.
  assert.equal(lib.isTemplatePlaceholder("${user_config.site_base}"), true);
  assert.equal(lib.isTemplatePlaceholder("${anything}"), true);
  assert.equal(lib.isTemplatePlaceholder("https://example.org/${x}"), false);
  assert.equal(lib.isTemplatePlaceholder("https://data.africamultiple.uni-bayreuth.de"), false);
  assert.equal(lib.isTemplatePlaceholder(""), true);
  assert.equal(lib.isTemplatePlaceholder(undefined), true);
});
