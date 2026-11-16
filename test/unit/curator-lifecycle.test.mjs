// Curator mode (#26), lifecycle, in-process against the Omeka stub:
//   - the fetch base is normalised once, so an odd spelling of AMIRA_API_BASE
//     (here a `/x/../api` path) still gets the key and crawls private data;
//   - a request arriving while a crawl is in flight waits for it: one crawl;
//   - Omeka's confirmation is persisted beside the cached snapshot;
//   - a curator refresh keeps the full-text map when GitHub is unreachable,
//     and enrichment requests never carry the key.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { IDS, KEY, startOmekaStub } from "../helpers/omeka-stub.mjs";

hermeticEnv();
const secrets = tempDir("curator-lifecycle-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}   # inline comment, as in the tokens file\nkey_credential=${KEY.credential}\n`);
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `ops ${createHash("sha256").update("amira_cur_lifecycle-token-0123456789abcdef").digest("hex")}\n`);

const stub = await startOmekaStub({ enrichment: "ok", delayMs: 20 });
test.after(() => stub.close());
const port = new URL(stub.base).port;
Object.assign(process.env, {
  AMIRA_ACCESS: "curator",
  AMIRA_SITE_BASE: "https://amira.example",
  // Not the canonical spelling: the request URLs and the key prefix must still agree.
  AMIRA_API_BASE: `http://127.0.0.1:${port}/x/../api/`,
  AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile,
  AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
  AMIRA_SEMANTIC_RELEASE: "off",
});
const lib = await import("../../server/lib.js");
const crawls = () => stub.requests.filter((r) => r.includes("resource_template_id=10&")).length;

test("the fetch base is normalised once; an odd AMIRA_API_BASE spelling still sends the key", () => {
  assert.equal(lib.config.fetchBase, stub.api);
  assert.equal(lib.resolveFetchBase("http://WEB:80/api/", "https://x/api"), "http://web/api");
  assert.equal(lib.resolveFetchBase("http://web/api", "https://x/api"), "http://web/api");
  assert.equal(lib.resolveFetchBase(null, "https://Data.Example/api"), "https://data.example/api");
  assert.equal(lib.resolveFetchBase("web/api", "https://x/api"), "web/api", "an invalid value is kept, for the startup refusal");
  assert.equal(lib.omekaKeyFor(`${stub.api}/items`)?.identity, KEY.identity, "the key file's inline comment is not part of the value");
});

test("a request arriving while the retry timer crawls waits for that crawl: one crawl, then served", async () => {
  // As the retry timer does: a background refresh with no store crawls afresh.
  const timer = lib.refreshNow();
  const request = lib.ensureStore();
  const [, store] = await Promise.all([timer, request]);
  assert.equal(crawls(), 1, "Omeka was crawled once, not twice");
  assert.ok(store.getItem(String(IDS.privateItem)), "the keyed crawl saw the private item");
  assert.equal(lib.refreshStatus().blocked, false);
  assert.ok(store.fulltextMaps, "the full-text map was fetched");
});

test("Omeka's confirmation is persisted beside the curator snapshot", () => {
  const file = path.join(lib.cacheSnapshotDir(), "verified.json");
  assert.ok(existsSync(file));
  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(stored.fetchedAt, lib.currentStore().manifest.fetchedAt);
  assert.ok(Date.now() - Date.parse(stored.verifiedAt) < 60_000);
});

test("a curator refresh with GitHub unreachable keeps the full-text map; enrichment requests carry no key", async () => {
  const github = stub.requests.filter((r) => r.startsWith("/github/raw/"));
  assert.ok(github.length >= 2, "the map files were fetched");
  assert.ok(stub.requests.filter((r) => r.startsWith("/github/")).every((r) => !r.includes("key_")), "never the Omeka key");
  await lib.refreshNow(); // let the confirming refresh the first load started settle
  const before = lib.currentStore();
  stub.state.enrichment = "down";
  stub.state.modified = "2026-11-02T00:00:00+00:00"; // newer upstream: the refresh re-crawls
  await new Promise((r) => setTimeout(r, 5)); // a distinct fetchedAt
  await lib.refreshNow();
  const after = lib.currentStore();
  assert.notEqual(after, before, "the refresh re-crawled and swapped the store");
  assert.equal(crawls(), 2);
  assert.ok(after.fulltextMaps, "the full-text map survives a refresh that could not reach GitHub");
  assert.equal(after.manifest.fulltextMaps?.tag, lib.FULLTEXT_SOURCE.tag);
});
