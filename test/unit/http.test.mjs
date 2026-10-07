import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, tempDir } from "../helpers/env.mjs";
import { exitedCleanly, spawnHttpServer } from "../helpers/mcp.mjs";

hermeticEnv();
const { writeSnapshot, SNAPSHOT_SCHEMA_VERSION } = await import("../../server/lib.js");

test("HTTP health recovers after an initially unavailable snapshot becomes readable", { timeout: 15000 }, async (t) => {
  const data = path.join(tempDir("http"), "data"); // deliberately absent at first
  // PORT=0 uses an OS-selected port, avoiding parallel-test collisions; the
  // child gets a sanitized env (no inherited AMIRA_*) and its own temp cache.
  const srv = await spawnHttpServer({ env: { AMIRA_DATA_DIR: data } });
  t.after(() => srv.stop());
  const { base } = srv;
  await srv.waitForLog(/initial data load failed/, 5000);
  const failed = await fetch(`${base}/healthz`);
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).status, "error");
  await writeSnapshot(data, buildFixture(SNAPSHOT_SCHEMA_VERSION));
  const client = new Client({ name: "http-recovery-test", version: "0.0.0" });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const result = await client.callTool({ name: "get_collection_overview", arguments: {} });
  assert.equal(result.isError, undefined);
  const recovered = await fetch(`${base}/healthz`);
  assert.equal(recovered.status, 200);
  const body = await recovered.json();
  assert.equal(body.status, "ok");
  assert.equal(body.error, undefined);
  assert.equal(body.data_snapshot.publications, 2);

  const modern = new Client({ name: "http-modern-test", version: "0.0.0" }, {
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  });
  t.after(() => modern.close());
  const captured = [];
  await modern.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === "POST") captured.push({ headers: Object.fromEntries(request.headers), body: await request.clone().text() });
      return fetch(request);
    },
  }));
  const modernResult = await modern.callTool({ name: "get_collection_overview", arguments: {} });
  assert.equal(modernResult.isError, undefined);
  assert.equal(modernResult.structuredContent.counts.publications, 2);
  const modernResources = await modern.listResources();
  assert.ok(modernResources.resources.some((r) => r.uri === "ui://amira/overview"));
  assert.equal(body.refresh.enabled, false);
  const toolCall = captured.find((request) => request.headers["mcp-name"] === "get_collection_overview");
  assert.ok(toolCall, "modern SDK sent routing headers");
  for (const headers of [{ "mcp-name": "get_data_quality" }, { "mcp-method": "tools/list" }]) {
    const mismatch = await fetch(`${base}/mcp`, { method: "POST", headers: { ...toolCall.headers, ...headers }, body: toolCall.body });
    assert.equal(mismatch.status, 400, "routing headers must agree with the envelope");
  }
  const oversized = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(65 * 1024) });
  assert.equal(oversized.status, 413);
  const concurrent = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? client : modern).callTool({ name: "get_collection_overview", arguments: {} })));
  assert.ok(concurrent.every((response) => response.structuredContent.counts.publications === 2));

  // Nothing above may have crashed the server, and it must stop when asked.
  assert.ok(srv.alive(), `server exited during the test:\n${srv.logs()}`);
  await Promise.all([client.close(), modern.close()]);
  const exit = await srv.stop();
  assert.ok(exitedCleanly(exit), `unclean shutdown ${JSON.stringify(exit)}:\n${srv.logs()}`);
});
