// Curator mode (#26): a first crawl that fails transiently (Omeka down, or a
// 502 while php restarts) is retried on a timer, with no request arriving: the
// container healthcheck only reads /healthz, which never triggers a load. Seen
// in production: the server stayed unhealthy until restarted.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../helpers/env.mjs";
import { spawnHttpServer } from "../helpers/mcp.mjs";
import { KEY, startOmekaStub } from "../helpers/omeka-stub.mjs";

const secrets = tempDir("curator-retry-secrets");
const keyFile = path.join(secrets, "omeka.key");
writeFileSync(keyFile, `key_identity=${KEY.identity}\nkey_credential=${KEY.credential}\n`);
const TOKEN = "amira_cur_retry-test-token-0123456789abcdefghijklmn";
const tokensFile = path.join(secrets, "tokens");
writeFileSync(tokensFile, `ops ${createHash("sha256").update(TOKEN).digest("hex")}\n`);

const stub = await startOmekaStub({ mode: "down" });
test.after(() => stub.close());

const health = async (base) => {
  const res = await fetch(`${base}/healthz`);
  return { status: res.status, body: await res.json() };
};

test("a 502 on the first crawl is retried on a timer, without any request, until the server is healthy", { timeout: 90_000 }, async (t) => {
  const server = await spawnHttpServer({
    env: {
      AMIRA_ACCESS: "curator",
      AMIRA_LIVE_REFRESH: "1",
      AMIRA_SITE_BASE: "https://amira.example",
      AMIRA_API_BASE: stub.api,
      AMIRA_OMEKA_KEY_FILE: keyFile,
      AMIRA_MCP_TOKENS_FILE: tokensFile,
      AMIRA_ENRICHMENT_BASE: `${stub.base}/github`,
      AMIRA_SEMANTIC_RELEASE: "off",
      AMIRA_CURATOR_RETRY_SECONDS: "1",
    },
  });
  t.after(() => server.stop());

  await server.waitForLog(/initial data load failed: curator snapshot unavailable: .*502/, 30_000);
  await server.waitForLog(/curator: retrying in 1 s/, 5_000);
  const down = await health(server.base);
  assert.equal(down.status, 503);
  assert.equal(down.body.status, "unavailable");

  // Omeka is back. From here on only /healthz is polled: no MCP request is sent.
  stub.state.mode = "auth";
  await server.waitForLog(/refreshed snapshot \(fetchedAt=/, 45_000);
  const up = await health(server.base);
  assert.equal(up.status, 200);
  assert.equal(up.body.status, "ok");
  assert.ok(up.body.data_snapshot.fetched_at);
  assert.ok(!server.logs().includes(KEY.credential), "the key is never logged");
  assert.ok(!stub.requests.some((r) => r.startsWith("/mcp")));
});
