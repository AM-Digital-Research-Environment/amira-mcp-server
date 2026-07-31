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
const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "amira-config-cache-"));

// The placeholders that actually caused the reported bug — the ones that feed
// citations. AMIRA_CACHE_DIR and AMIRA_LIVE_REFRESH are deliberately REAL
// values here: leaving them as placeholders resolves them to their defaults,
// which is correct behaviour but means booting a server would crawl the live
// API and write a real snapshot into ~/.amira-mcp/cache — where it outranks
// every other test file's fixture (that is exactly how the v1.7.1 release run
// failed). Unit tests stay offline and write nothing outside their temp dirs;
// the fallback behaviour itself is asserted from the resolved config below.
process.env.AMIRA_SITE_BASE = "${user_config.site_base}";
process.env.AMIRA_SITE_SLUG = "${user_config.site_slug}";
process.env.AMIRA_DATA_DIR = fixtureDir; // a REAL value must still win
process.env.AMIRA_CACHE_DIR = cacheDir;
process.env.AMIRA_LIVE_REFRESH = "0";
process.env.AMIRA_ALLOWED_ORIGINS = "https://chatgpt.com, claude.ai:443, *, not a url";

const lib = await import("../../server/lib.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");
const { Client } = await import("@modelcontextprotocol/client");

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
  assert.equal(lib.config.cacheDir, path.resolve(cacheDir), "a genuine AMIRA_CACHE_DIR wins");
  assert.equal(lib.config.liveRefresh, false, "a genuine AMIRA_LIVE_REFRESH wins");
  assert.deepEqual(
    lib.config.allowedOriginHostnames,
    ["localhost", "127.0.0.1", "[::1]", "chatgpt.com", "claude.ai"],
    "origin URLs and hostnames normalize while unsafe entries fail closed",
  );
  assert.equal(lib.config.siteSlug, "amira", "a placeholder AMIRA_SITE_SLUG falls back to the default");
  assert.ok(!lib.config.cacheDir.includes("${"), "no placeholder became a directory name");
  assert.ok(!lib.config.siteBase.includes("${"), "no placeholder became the site base");

  // Only a whole-string ${...} is ignored; a URL that merely contains braces is
  // still a real setting.
  assert.equal(lib.isTemplatePlaceholder("${user_config.site_base}"), true);
  assert.equal(lib.isTemplatePlaceholder("${anything}"), true);
  assert.equal(lib.isTemplatePlaceholder("https://example.org/${x}"), false);
  assert.equal(lib.isTemplatePlaceholder("https://data.africamultiple.uni-bayreuth.de"), false);
  assert.equal(lib.isTemplatePlaceholder(""), true);
  assert.equal(lib.isTemplatePlaceholder(undefined), true);

  assert.deepEqual(lib.parseAllowedOriginHostnames(undefined), ["localhost", "127.0.0.1", "[::1]"]);
});
