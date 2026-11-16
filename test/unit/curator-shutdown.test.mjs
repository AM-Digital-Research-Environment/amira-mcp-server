// Curator mode (#26): shutdown aborts the first crawl, which used to run
// outside the background refresh with no abort signal, so SIGTERM waited for
// it and could leave the cache's writer.lock behind.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { KEY, startOmekaStub } from "../helpers/omeka-stub.mjs";

const { cacheDir } = hermeticEnv();
const secrets = tempDir("curator-shutdown-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `ops ${createHash("sha256").update("amira_cur_shutdown-token-0123456789abcdef").digest("hex")}\n`);

// Slow answers: the crawl is still running when shutdown comes.
const stub = await startOmekaStub({ delayMs: 300 });
test.after(() => stub.close());
Object.assign(process.env, {
  AMIRA_ACCESS: "curator",
  AMIRA_SITE_BASE: stub.base,
  AMIRA_OMEKA_KEY_FILE: keyFile,
  AMIRA_MCP_TOKENS_FILE: tokensFile,
  AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
  AMIRA_SEMANTIC_RELEASE: "off",
  AMIRA_LIVE_REFRESH: "1",
  AMIRA_CURATOR_RETRY_SECONDS: "600",
});
const lib = await import("../../server/lib.js");

test("stopping aborts the initial curator crawl promptly and leaves no writer lock", async () => {
  const load = lib.ensureStore();
  load.catch(() => {});
  // Wait until the crawl is under way (the authentication probe has been asked).
  for (let i = 0; i < 100 && !stub.requests.some((r) => r.startsWith("/api/items?is_public=0")); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(stub.requests.length > 0, "the crawl started");
  const started = Date.now();
  await lib.stopBackgroundRefresh();
  assert.ok(Date.now() - started < 3000, `stopping took ${Date.now() - started} ms`);
  await assert.rejects(load);
  assert.equal(lib.currentStore(), null);
  const lockLeft = existsSync(cacheDir) && readdirSync(cacheDir, { recursive: true }).some((f) => String(f).endsWith("writer.lock"));
  assert.equal(lockLeft, false);
});
