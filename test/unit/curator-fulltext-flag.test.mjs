// Curator mode: a publication whose only full text is private reads
// `has_restricted_fulltext: true` beside `has_fulltext: false` (public text),
// in search summaries and in get_publication, so a `restricted_fulltext` match
// never sits next to an unexplained "no full text". The stub's public
// publication carries a private extraction only (test/helpers/omeka-stub.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";
import { IDS, KEY, PRIVATE, startOmekaStub } from "../helpers/omeka-stub.mjs";

hermeticEnv();
const secrets = tempDir("curator-flag-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `ops ${createHash("sha256").update("amira_cur_flag-test-token-0123456789abcdefghijklmno").digest("hex")}\n`);

const stub = await startOmekaStub();
test.after(() => stub.close());
Object.assign(process.env, {
  AMIRA_ACCESS: "curator",
  AMIRA_SITE_BASE: "https://amira.example",
  AMIRA_API_BASE: stub.api,
  AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile,
  AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
  AMIRA_SEMANTIC_RELEASE: "off",
});
const lib = await import("../../server/lib.js");
await lib.refreshNow();
const conn = await connectInMemory(lib, { openai: true });
test.after(() => conn.close());

test("C17 curator: private-only full text is flagged, not hidden behind has_fulltext:false", async () => {
  const pubs = await conn.call("search_publications", { keyword: PRIVATE.pubText });
  const row = pubs.results.find((r) => r.omeka_id === IDS.publicPub);
  assert.equal(row.matched_in, "restricted_fulltext");
  assert.deepEqual([row.has_fulltext, row.has_restricted_fulltext], [false, true]);
  const detail = await conn.call("get_publication", { id: IDS.publicPub });
  assert.deepEqual([detail.has_fulltext, detail.has_restricted_fulltext], [false, true]);
});
