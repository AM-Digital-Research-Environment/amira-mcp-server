// Curator mode (#26), in-process: a curator server crawls the Omeka stub
// (test/helpers/omeka-stub.mjs) with its service key and serves private
// records and private values to personal-token holders, and only to them.
//
// Covers the validation plan of the issue for the curator side: both fixtures
// are visible through tools, resources, exports and counts; the HTTP layer
// refuses missing, unknown and revoked tokens and audits by name; the Omeka key
// never appears in logs, errors, /healthz, the manifest or returned URLs; a
// 401/403 from Omeka drops the data and wipes the cache; the curator refuses a
// public snapshot. The public side lives in curator-public.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";
import { IDS, KEY, PRIVATE, startOmekaStub } from "../helpers/omeka-stub.mjs";
import { buildFixture } from "../fixtures/fixture-data.mjs";

const { cacheDir } = hermeticEnv();
const secrets = tempDir("curator-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `# service account\nkey_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const ALICE = "amira_cur_alice-test-token-0123456789abcdefghijklmnop";
const BOB = "amira_cur_bob-test-token-0123456789abcdefghijklmnopqrs";

const stub = await startOmekaStub();
test.after(() => stub.close());

// Every line the server logs, for the secrets checks.
const logs = [];
const originalError = console.error;
console.error = (...args) => logs.push(args.map(String).join(" "));
test.after(() => { console.error = originalError; });

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
const tokensFile = path.join(secrets, "tokens");
const TOKENS = `# curators\nalice ${sha256(ALICE)}\nbob ${sha256(BOB)}  # second curator\n`;
writeFileSync(tokensFile, TOKENS);

Object.assign(process.env, {
  AMIRA_ACCESS: "curator",
  AMIRA_SITE_BASE: stub.base,
  AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile,
  AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
  AMIRA_SEMANTIC_RELEASE: "off",
});
const lib = await import("../../server/lib.js");
assert.equal(lib.hashToken(ALICE), sha256(ALICE));

/** Everything the server returned to a client, for the secrets checks. */
const returned = [];
const keep = (value) => {
  returned.push(typeof value === "string" ? value : JSON.stringify(value));
  return value;
};

// The first refresh crawls with the key (curator mode has no bundled snapshot).
await lib.refreshNow();
const conn = await connectInMemory(lib, { openai: true });
test.after(() => conn.close());
const call = async (tool, args = {}) => keep(await conn.call(tool, args));
const raw = async (tool, args = {}) => keep(await conn.raw(tool, args));
const read = async (uri) => keep((await conn.client.readResource({ uri })).contents[0].text);

const adminItem = (id) => `${stub.base}/admin/item/${id}`;
const publicItem = (id) => `${stub.base}/s/amira/item/${id}`;

test("the curator configuration is complete over HTTP and refused elsewhere", () => {
  assert.deepEqual(lib.accessConfigErrors("http"), []);
  assert.match(lib.accessConfigErrors("stdio").join("\n"), /HTTP only/);
  assert.match(lib.accessConfigErrors("fetch").join("\n"), /never runs in curator mode/);
});

test("curator instructions put the private-record rules first and stay within 2,048 characters", () => {
  const text = conn.client.getInstructions();
  assert.equal(text, lib.curatorInstructions());
  assert.ok(text.startsWith("CURATOR MODE"));
  assert.match(text, /admin_url/);
  assert.match(text, /CITATIONS — follow exactly/);
  assert.ok(text.length <= 2048, `${text.length} characters`);
  assert.ok(lib.curatorInstructions(false).length <= 2048);
});

test("the crawl sends the key to the Omeka API only, and the manifest records curator mode without it", () => {
  const keyed = stub.requests.filter((r) => r.includes("key_identity="));
  assert.ok(keyed.length > 10, "the corpus queries were authenticated");
  assert.ok(keyed.every((r) => r.startsWith("/api/")), "never to the GitHub stand-in");
  const github = stub.requests.filter((r) => r.startsWith("/github/"));
  assert.ok(github.length > 0 && github.every((r) => !r.includes("key_")), "enrichment requests carry no key");

  const store = lib.currentStore();
  assert.equal(store.manifest.access, "curator");
  assert.equal(store.manifest.apiBase, stub.api);
  assert.equal(lib.cacheSnapshotDir(), lib.snapshotCacheDir(cacheDir, stub.api, "curator"));
  assert.notEqual(lib.cacheSnapshotDir(), lib.snapshotCacheDir(cacheDir, stub.api), "the curator partition is not the public one");
});

test("curator: the private item is served as private, with an admin URL and no public link", async () => {
  const item = await call("get_research_item", { id: IDS.privateItem, citation_format: "csl-json" });
  assert.equal(item.title, PRIVATE.itemTitle);
  assert.equal(item.visibility, "private");
  assert.equal(item.admin_url, adminItem(IDS.privateItem));
  assert.equal(item.amira_url, undefined, "anonymous visitors cannot open a private item's public page");
  assert.match(item.citation_note, /not publicly accessible/);
  // The generated citation and the CSL export say so, and link nothing public.
  assert.match(item.generated_citation, /Private AMIRA record/);
  assert.equal(item.csl_json.URL, undefined);
  assert.match(item.csl_json.note, /Private AMIRA record/);
  assert.ok(!JSON.stringify(item).includes(publicItem(IDS.privateItem)));

  const bib = await call("get_research_item", { id: IDS.privateItem, citation_format: "bibtex" });
  assert.ok(!/url = /.test(bib.bibtex), "no url field in the BibTeX of a private record");
  assert.match(bib.bibtex, /Private AMIRA record/);
});

test("curator: private values on a public item sit in `restricted`, never in the public fields", async () => {
  const item = await call("get_research_item", { id: IDS.publicItem });
  assert.equal(item.visibility, "public");
  assert.equal(item.amira_url, publicItem(IDS.publicItem));
  assert.equal(item.description, "A public description of the recording.", "the private description stays out of `description`");
  const r = item.restricted;
  assert.match(r.note, /curators only/);
  assert.equal(r.security_level, PRIVATE.security);
  assert.equal(r.mongo_id, PRIVATE.mongoId);
  assert.deepEqual(r.bitstream, [PRIVATE.bitstream]);
  assert.deepEqual(r.values["dcterms:description"], [`Curator note: ${PRIVATE.description}.`]);
  assert.equal(r.has_fulltext, true);
  assert.ok(r.fulltext_length > 0);
  assert.equal(r.fulltext, undefined, "the full text is opt-in");
  assert.match(r.fulltext_hint, /include_fulltext/);
  assert.equal(r.fulltext_generated_by, PRIVATE.generatedBy);
  // A private person credited on a public item: marked, and linked to the admin page.
  const hidden = item.contributors.find((c) => c.name === PRIVATE.personName);
  assert.equal(hidden.visibility, "private");
  assert.equal(hidden.admin_url, adminItem(IDS.privatePerson));
  assert.equal(hidden.amira_url, undefined);
  assert.equal(item.contributors.find((c) => c.name === "Visible, Person").visibility, "public");
  // The private media file is listed and marked.
  assert.deepEqual(item.media.map((m) => m.visibility ?? "public"), ["public", "private"]);
});

test("curator: the private ILAM-style full text is searchable and retrievable, paged like every long text", async () => {
  const full = await call("get_research_item", { id: IDS.publicItem, include_fulltext: true });
  assert.match(full.restricted.fulltext, new RegExp(PRIVATE.fulltext));
  assert.equal(full.restricted.fulltext_offset, 0);
  const page = await call("get_research_item", { id: IDS.publicItem, include_fulltext: true, fulltext_offset: 5, fulltext_max_chars: 10 });
  assert.equal(page.restricted.fulltext.length, 10);
  assert.equal(page.restricted.fulltext_truncated, true);

  const hits = await call("search_research_items", { keyword: PRIVATE.fulltext });
  assert.deepEqual(hits.results.map((r) => r.omeka_id), [IDS.publicItem]);
  assert.equal(hits.results[0].matched_in, "restricted_fulltext");
  assert.match(hits.results[0].fulltext_snippet, new RegExp(PRIVATE.fulltext));

  const pubs = await call("search_publications", { keyword: PRIVATE.pubText });
  assert.deepEqual(pubs.results.map((r) => r.omeka_id), [IDS.publicPub]);
  assert.equal(pubs.results[0].matched_in, "restricted_fulltext");
  const pub = await call("get_publication", { id: String(IDS.publicPub), include_fulltext: true });
  assert.equal(pub.has_fulltext, false, "the public full-text field stays empty");
  assert.match(pub.restricted.fulltext, new RegExp(PRIVATE.pubText));
});

test("curator: lists, people, publications, collections and the ChatGPT adapter all show and mark private records", async () => {
  const items = await call("search_research_items", {});
  assert.deepEqual(items.results.map((r) => [r.omeka_id, r.visibility]).sort(),
    [[IDS.privateItem, "private"], [IDS.publicItem, "public"], [IDS.plainItem, "public"]]);
  assert.equal(items.results.find((r) => r.omeka_id === IDS.privateItem).admin_url, adminItem(IDS.privateItem));

  const people = await call("search_persons", { keyword: "Hidden" });
  assert.equal(people.results[0].visibility, "private");
  assert.equal(people.results[0].admin_url, adminItem(IDS.privatePerson));

  const pub = await call("get_publication", { id: String(IDS.privatePub), citation_format: "csl-json" });
  assert.equal(pub.visibility, "private");
  assert.equal(pub.admin_url, adminItem(IDS.privatePub));
  assert.equal(pub.amira_url, undefined);

  // The private item set files the project's private item, so the project's collection counts it.
  const sets = await call("list_collections", {});
  assert.ok(sets.results.length > 0 && sets.results.every((r) => r.visibility === "public"), JSON.stringify(sets.results));

  const doc = await call("fetch", { id: `research_item:${IDS.privateItem}` });
  assert.equal(doc.url, adminItem(IDS.privateItem));
  assert.match(doc.text, new RegExp(adminItem(IDS.privateItem)));
  assert.ok(!doc.text.includes(publicItem(IDS.privateItem)));
  assert.equal(doc.metadata.visibility, "private");

  const graph = await raw("resolve_entity", { query: PRIVATE.personName });
  assert.ok(!graph.isError, "output schemas accept a private record without amira_url");
});

test("curator: the overview splits every count into public and private", async () => {
  const o = await call("get_collection_overview");
  assert.equal(o.access, "curator");
  assert.equal(o.counts.research_items, 3);
  assert.equal(o.visibility.public.research_items, 2);
  assert.equal(o.visibility.private.research_items, 1);
  assert.equal(o.visibility.private.persons, 1);
  assert.equal(o.visibility.private.publications, 1);
  assert.equal(o.visibility.private.item_sets, 1);
  assert.equal(o.visibility.records_with_private_values, 2);
  assert.equal(o.visibility.records_with_private_fulltext, 2);
  assert.match(o.data_snapshot.note, /Curator mode/);
});

test("curator: resources and exports carry the same marks", async () => {
  const record = JSON.parse(await read(`amira://record/research_item/${IDS.privateItem}`));
  assert.equal(record.visibility, "private");
  assert.equal(record.admin_url, adminItem(IDS.privateItem));
  const withValues = JSON.parse(await read(`amira://record/research_item/${IDS.publicItem}`));
  assert.equal(withValues.restricted.security_level, PRIVATE.security);

  const dataset = JSON.parse(await read("amira://dataset"));
  assert.equal(dataset.isAccessibleForFree, false);
  assert.equal(dataset["amira:visibility"].private.research_items, 1);

  const csv = await read(lib.exportUri("research_items", "csv", {}));
  assert.match(csv.split("\r\n")[0], /admin_url/);
  assert.match(csv, new RegExp(adminItem(IDS.privateItem)));
  assert.ok(!csv.includes(publicItem(IDS.privateItem)));
  const jsonl = (await read(lib.exportUri("research_items", "jsonl", {}))).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(jsonl.find((r) => r.omeka_id === IDS.privateItem).visibility, "private");

  const bib = await read(lib.exportUri("publications", "bibtex", {}));
  assert.match(bib, /Private AMIRA record/);
  assert.ok(!bib.includes(publicItem(IDS.privatePub)));
  const csl = JSON.parse(await read(lib.exportUri("publications", "csl-json", {})));
  const privateCsl = csl.find((e) => e.id === `amira-${IDS.privatePub}`);
  assert.equal(privateCsl.URL, undefined);
  assert.match(privateCsl.note, /Private AMIRA record/);
  assert.match(csl.find((e) => e.id === `amira-${IDS.publicPub}`).note, new RegExp(publicItem(IDS.publicPub)));
});

test("curator: a public-mode snapshot is refused, in both directions", async () => {
  const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  assert.throws(() => lib.assertSnapshotSource({ ...fixture.manifest, apiBase: stub.api }, stub.api, "curator"), /crawled in public mode/);
  const manifest = JSON.parse(readFileSync(path.join(lib.cacheSnapshotDir(), "generations",
    JSON.parse(readFileSync(path.join(lib.cacheSnapshotDir(), "active.json"), "utf8")).current, "manifest.json"), "utf8"));
  assert.throws(() => lib.assertSnapshotSource(manifest, stub.api, "public"), /crawled in curator mode/);
  assert.notEqual(lib.snapshotId(manifest), lib.snapshotId({ ...manifest, access: undefined }), "the snapshot id names the mode");
});

// --- HTTP: personal tokens and audit ------------------------------------------------------------

const servers = new Set();
test.after(async () => { for (const s of servers) await s.close(); });

async function serve(opts = {}) {
  const audit = [];
  const app = lib.createHttpApp({ rateLimitPerMinute: 0, tokenReloadMs: 0, audit: (line) => audit.push(line), ...opts });
  const server = createServer(app.listener);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const handle = {
    app, audit, base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { servers.delete(handle); server.closeAllConnections(); await new Promise((r) => server.close(r)); await app.close(); },
  };
  servers.add(handle);
  return handle;
}

function send(base, { method = "GET", path: target = "/healthz", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(new URL(target, base), { method, headers, agent: false }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function clientFor(base, token) {
  const client = new Client({ name: "curator-test", version: "0.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}));
  return client;
}

const POST = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

test("http: no token and an unknown token are 401; a personal token works and is audited by name only", async (t) => {
  const { base, audit } = await serve();
  const none = await send(base, { method: "POST", path: "/mcp", headers: POST, body: LIST });
  assert.equal(none.status, 401);
  assert.equal(none.headers["www-authenticate"], 'Bearer realm="amira-curator"');
  const unknown = await send(base, { method: "POST", path: "/mcp", headers: { ...POST, Authorization: "Bearer amira_cur_not-a-real-token-at-all-0000" }, body: LIST });
  assert.equal(unknown.status, 401);
  assert.equal((await send(base, { path: "/metrics" })).status, 401);
  assert.equal((await send(base, { path: "/metrics", headers: { Authorization: `Bearer ${BOB}` } })).status, 200);
  assert.equal(audit.length, 0, "refused requests are not audited as a curator");

  const client = await clientFor(base, ALICE);
  t.after(() => client.close());
  const result = await client.callTool({ name: "get_research_item", arguments: { id: IDS.publicItem, include_fulltext: true } });
  keep(result);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(PRIVATE.fulltext));
  await client.readResource({ uri: lib.exportUri("research_items", "csv", { keyword: PRIVATE.fulltext }) });

  assert.ok(audit.includes("[amira] audit curator=alice method=tools/call tool=get_research_item"), audit.join("\n"));
  assert.ok(audit.includes("[amira] audit curator=alice method=resources/read resource=export/research_items/csv"), audit.join("\n"));
  const joined = audit.join("\n");
  assert.ok(audit.every((line) => line.startsWith("[amira] audit curator=alice ")));
  for (const secret of [ALICE, lib.hashToken(ALICE), PRIVATE.fulltext, String(IDS.publicItem), KEY.identity, KEY.credential]) {
    assert.ok(!joined.includes(secret), `audit lines must not contain ${secret}`);
  }
});

test("http: deleting a curator's line revokes the token without a restart; the others keep working", async () => {
  const { base } = await serve();
  const auth = (token) => ({ ...POST, Authorization: `Bearer ${token}` });
  assert.equal((await send(base, { method: "POST", path: "/mcp", headers: auth(ALICE), body: LIST })).status, 200);
  writeFileSync(tokensFile, `bob ${lib.hashToken(BOB)}\n`);
  try {
    assert.equal((await send(base, { method: "POST", path: "/mcp", headers: auth(ALICE), body: LIST })).status, 401);
    assert.equal((await send(base, { method: "POST", path: "/mcp", headers: auth(BOB), body: LIST })).status, 200);
    writeFileSync(tokensFile, "");
    assert.equal((await send(base, { method: "POST", path: "/mcp", headers: auth(BOB), body: LIST })).status, 401, "an empty file grants nothing");
  } finally {
    writeFileSync(tokensFile, TOKENS);
  }
});

test("http: /healthz stays open but shows no counts and no key", async () => {
  const { base } = await serve();
  const res = await send(base);
  keep(res.text);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.text);
  assert.equal(body.access, "curator");
  assert.equal(body.status, "ok");
  assert.equal(body.data_snapshot.research_items, undefined, "counts would reveal private records to anyone");
  assert.equal(body.site, undefined);
});

test("http: curator mode refuses to build without personal tokens or with a shared token", () => {
  assert.throws(() => lib.createHttpApp({ tokensFile: path.join(secrets, "missing") }), /no valid token/);
  assert.throws(() => lib.createHttpApp({ bearerToken: "shared-secret" }), /shared bearer token/);
});

// --- Omeka refuses the key ------------------------------------------------------------------------

test("a 401 from Omeka drops the store, wipes the curator cache and refuses requests until a refresh succeeds", async () => {
  const dir = lib.cacheSnapshotDir();
  assert.ok(existsSync(dir));
  stub.state.mode = "deny";
  stub.state.denyStatus = 401;
  try {
    await lib.refreshNow();
    assert.equal(lib.currentStore(), null);
    assert.equal(existsSync(dir), false, "the curator cache is wiped");
    assert.equal(lib.refreshStatus().blocked, true);
    assert.equal(lib.refreshStatus().error_class, "omeka_auth_refused");
    const refused = await raw("get_research_item", { id: IDS.publicItem });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /Omeka refused the service key/);
    await assert.rejects(conn.client.readResource({ uri: "amira://dataset" }));
    // A 403 on a later attempt keeps it refused.
    stub.state.denyStatus = 403;
    await lib.refreshNow();
    assert.equal(lib.currentStore(), null);
  } finally {
    stub.state.mode = "auth";
  }
  await lib.refreshNow();
  assert.ok(lib.currentStore(), "a successful refresh restores service");
  assert.equal(lib.refreshStatus().blocked, false);
  assert.equal((await call("get_research_item", { id: IDS.privateItem })).visibility, "private");
});

// --- secrets ---------------------------------------------------------------------------------------

test("the Omeka key never appears in logs, errors, health, the manifest, cache files or returned values", () => {
  assert.ok(logs.some((l) => /HTTP 401 to the curator key/.test(l)), "the refusal was logged");
  const files = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else files.push(readFileSync(p, "utf8"));
    }
  };
  walk(cacheDir);
  assert.ok(files.length > 5, "the cache was written");
  for (const [what, texts] of [["logs", logs], ["returned values", returned], ["cache files", files]]) {
    const joined = texts.join("\n");
    assert.ok(!joined.includes(KEY.identity), `key_identity in ${what}`);
    assert.ok(!joined.includes(KEY.credential), `key_credential in ${what}`);
    assert.ok(!/key_(identity|credential)=/.test(joined), `a key parameter in ${what}`);
  }
});

test("redactSecrets strips key parameters and any key value this process loaded", () => {
  assert.equal(lib.redactSecrets(`GET /api/items?key_identity=${KEY.identity}&key_credential=abc failed`),
    "GET /api/items?key_identity=[redacted]&key_credential=[redacted] failed");
  assert.equal(lib.redactSecrets(`cause: ${KEY.credential}`), "cause: [redacted]");
  assert.equal(lib.omekaKeyFor(`${stub.api}/items`)?.identity, KEY.identity);
  assert.equal(lib.omekaKeyFor("https://api.github.com/repos/x"), null, "only the configured Omeka API gets the key");
  assert.equal(lib.omekaKeyFor(`${stub.base}/apiary/items`), null, "a prefix match must end at a path boundary");
});
