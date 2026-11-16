// Curator mode (#26), the public side: an anonymous user sees neither fixture
// (the private item, the private values of the public item) through any tool,
// resource, CSL/BibTeX export, count, list or graph, nor through a cached
// snapshot. The stub runs in "leak" mode: it serves private content to
// anonymous requests, which the real Omeka never does, so every check below
// exercises the public server's own defence in depth rather than Omeka's.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory, spawnHttpServer } from "../helpers/mcp.mjs";
import { IDS, PRIVATE, startOmekaStub } from "../helpers/omeka-stub.mjs";
import { buildFixture } from "../fixtures/fixture-data.mjs";

hermeticEnv();
const stub = await startOmekaStub({ mode: "leak" });
test.after(() => stub.close());
Object.assign(process.env, { AMIRA_SITE_BASE: stub.base, AMIRA_ENRICHMENT_BASE: `${stub.base}/github`, AMIRA_SEMANTIC_RELEASE: "off" });
const lib = await import("../../server/lib.js");

// What a public crawl of this API makes of it, published to the public cache as a refresh would.
const crawled = await lib.crawlSnapshot(stub.api, () => {});
await lib.writeSnapshotAtomic(lib.cacheSnapshotDir(), crawled);
const conn = await connectInMemory(lib, { openai: true });
test.after(() => conn.close());

const PRIVATE_STRINGS = [...Object.values(PRIVATE), `/item/${IDS.privateItem}`, `/item/${IDS.privatePerson}`, `/item/${IDS.privatePub}`,
  `/item-set/${IDS.privateSet}`, "restricted", "visibility", "admin_url"];
function assertClean(what, value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const s of PRIVATE_STRINGS) assert.ok(!text.includes(s), `${what} leaks ${JSON.stringify(s)}: ${text.slice(0, 300)}`);
}

test("public crawl: private resources, private values and private media are dropped, and no key is sent", () => {
  assert.equal(crawled.manifest.access, "public");
  assert.deepEqual(crawled.data.research_items.map((r) => r.o_id).sort(), [IDS.publicItem, IDS.plainItem]);
  assert.deepEqual(crawled.data.persons.map((r) => r.o_id), [IDS.publicPerson]);
  assert.deepEqual(crawled.data.publications.map((r) => r.o_id), [IDS.publicPub]);
  assert.deepEqual(crawled.data.item_sets.map((r) => r.o_id), [IDS.publicSet]);
  const item = crawled.data.research_items.find((r) => r.o_id === IDS.publicItem);
  assert.equal(item.description, "A public description of the recording.");
  assert.deepEqual(item.media.map((m) => m.o_id), [IDS.publicMedia]);
  assert.equal(crawled.data.publications[0].fulltext, null, "a private bibo:content never becomes the public full text");
  assertClean("the crawled snapshot", crawled.data);
  assert.ok(stub.requests.every((r) => !r.includes("key_")), "a public crawl never sends a key");
});

test("public tools: neither fixture appears in any tool, list, count or graph", async () => {
  const calls = [
    ["get_collection_overview", {}],
    ["search_research_items", {}],
    ["search_research_items", { keyword: PRIVATE.itemTitle }],
    ["search_research_items", { keyword: PRIVATE.fulltext }],
    ["search_research_items", { keyword: PRIVATE.description }],
    ["get_research_item", { id: IDS.publicItem, citation_format: "csl-json" }],
    ["get_research_item", { id: IDS.publicItem, citation_format: "bibtex" }],
    ["search_persons", {}],
    ["search_publications", {}],
    ["search_publications", { keyword: PRIVATE.pubText }],
    ["search_publications", { citation_format: "csl-json" }],
    ["search_publications", { citation_format: "bibtex" }],
    ["get_publication", { id: String(IDS.publicPub), include_fulltext: true }],
    ["get_project", { id: String(IDS.project) }],
    ["list_collections", {}],
    ["list_years", {}],
    ["resolve_entity", { query: "Person" }],
    ["get_entity_graph", { seed: `project:${IDS.project}` }],
    ["search", { query: "Interview" }],
    ["fetch", { id: `research_item:${IDS.publicItem}` }],
  ];
  for (const [tool, args] of calls) {
    const result = await conn.raw(tool, args);
    assert.ok(!result.isError, `${tool} ${JSON.stringify(args)} failed: ${result.content?.[0]?.text}`);
    // A search for a private string echoes the query back; everything else must be clean.
    const { filters: _echo, ...body } = JSON.parse(result.content[0].text);
    assertClean(`${tool} ${JSON.stringify(args)}`, body);
    if (Object.values(args).some((v) => Object.values(PRIVATE).includes(v))) assert.equal(body.total_matches, 0, `${tool} ${JSON.stringify(args)}`);
  }
  const overview = await conn.call("get_collection_overview");
  assert.equal(overview.counts.research_items, 2);
  assert.equal(overview.counts.persons, 1);
  assert.equal(overview.counts.publications, 1);
  assert.equal(overview.visibility, undefined);
  assert.equal(overview.access, undefined);
  for (const [tool, id] of [["get_research_item", IDS.privateItem], ["get_person", String(IDS.privatePerson)], ["get_publication", String(IDS.privatePub)]]) {
    const missing = await conn.call(tool, { id });
    assert.equal(missing.isError, true, `${tool} ${id} must be not_found`);
    assert.equal(missing.error.code, "not_found");
  }
});

test("public resources and exports: nothing private in records, the dataset, CSV, JSONL, BibTeX, RIS or CSL-JSON", async () => {
  const read = async (uri) => (await conn.client.readResource({ uri })).contents[0].text;
  assertClean("dataset", await read("amira://dataset"));
  assertClean("record", await read(`amira://record/research_item/${IDS.publicItem}`));
  await assert.rejects(read(`amira://record/research_item/${IDS.privateItem}`));
  for (const format of ["csv", "jsonl"]) assertClean(`research_items ${format}`, await read(lib.exportUri("research_items", format, {})));
  for (const format of ["csv", "jsonl", "bibtex", "ris", "csl-json"]) {
    assertClean(`publications ${format}`, await read(lib.exportUri("publications", format, {})));
  }
});

test("public mode: the tool surface is the one it always was (no curator-only parameter)", async () => {
  const tools = (await conn.client.listTools()).tools;
  const item = tools.find((t) => t.name === "get_research_item");
  assert.equal(item.inputSchema.properties.include_fulltext, undefined);
  const graph = tools.find((t) => t.name === "resolve_entity");
  assert.ok(graph.outputSchema.properties.results.items.required.includes("amira_url"), "amira_url stays required in public schemas");
});

test("publicView drops private records and values from a snapshot labelled public (defence in depth at load)", () => {
  const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  const leaked = structuredClone(fixture.data);
  leaked.research_items[0].visibility = "private";
  leaked.research_items[1].restricted = { security_level: "DSL5" };
  leaked.research_items[1].media = [{ o_id: 1, type: null, url: "x", source: null, size: null, visibility: "private" }];
  const { data, dropped } = lib.publicView(leaked);
  assert.equal(dropped, 1);
  assert.equal(data.research_items.length, fixture.data.research_items.length - 1);
  assert.equal(data.research_items[0].restricted, undefined);
  assert.deepEqual(data.research_items[0].media, []);
  assert.equal(lib.publicView(fixture.data).data, fixture.data, "a clean snapshot is returned as is");
});

// --- cached and bundled snapshots ------------------------------------------------------------

/** A curator-mode snapshot of the stub's instance (as a curator server would cache it). */
async function curatorSnapshot() {
  const dir = tempDir("curator-snapshot");
  const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  fx.data.research_items[0] = { ...fx.data.research_items[0], title: PRIVATE.itemTitle, visibility: "private" };
  Object.assign(fx.manifest, { apiBase: stub.api, fetchedAt: new Date().toISOString(), access: "curator" });
  await lib.writeSnapshot(dir, fx);
  return dir;
}

test("a public server refuses a curator snapshot, bundled or cached", { timeout: 30_000 }, async (t) => {
  const dir = await curatorSnapshot();
  const manifest = (await lib.loadSnapshot(dir)).manifest;
  assert.throws(() => lib.assertSnapshotSource(manifest, stub.api, "public"), /crawled in curator mode/);

  // As the bundled snapshot, and copied into the public cache partition, it is never served.
  const cacheDir = tempDir("public-cache");
  await lib.writeSnapshotAtomic(lib.snapshotCacheDir(cacheDir, stub.api), await lib.loadSnapshot(dir));
  const server = await spawnHttpServer({ env: { AMIRA_SITE_BASE: stub.base, AMIRA_DATA_DIR: dir, AMIRA_CACHE_DIR: cacheDir } });
  t.after(() => server.stop());
  let health;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) {
    health = await (await fetch(`${server.base}/healthz`)).json();
    if (health.status !== "loading") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(health.status, "error");
  assertClean("health", health);
  assert.match(server.logs(), /crawled in curator mode; a public-mode server refuses it/);
});

test("a public server removes private records from a public-labelled snapshot before serving it", { timeout: 30_000 }, async (t) => {
  const dir = tempDir("mislabelled");
  const fx = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  fx.data.research_items[0] = { ...fx.data.research_items[0], title: PRIVATE.itemTitle, visibility: "private" };
  fx.data.research_items[1] = { ...fx.data.research_items[1], restricted: { security_level: PRIVATE.security } };
  Object.assign(fx.manifest, { apiBase: stub.api, fetchedAt: new Date().toISOString() });
  await lib.writeSnapshot(dir, fx);
  const server = await spawnHttpServer({ env: { AMIRA_SITE_BASE: stub.base, AMIRA_DATA_DIR: dir } });
  t.after(() => server.stop());
  await server.waitForLog(/removed 1 private record\(s\) and every private value from the bundled snapshot/);
  const health = await (await fetch(`${server.base}/healthz`)).json();
  assert.equal(health.data_snapshot.research_items, fx.data.research_items.length - 1);
  assertClean("health", health);
});
