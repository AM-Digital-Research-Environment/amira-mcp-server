// Downloading a corpus-vector release (src/snapshot.ts fetchSemanticRelease)
// and the CPU side of a build (src/semantic.ts computeNeighbours): which tag
// "latest" settles on, what a pinned tag refuses, that no token leaves for a
// stand-in host, and how the k-means and the abort behave.
//
// GitHub is a local stub (AMIRA_ENRICHMENT_BASE, read when the config loads,
// so it is set before server/lib.js is imported): nothing here reaches the network.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";

const REPO = "AM-Digital-Research-Environment/DRE-Visualizations";
const DIMS = 768;

/** A release over fixture records 500–502, every row a unit vector at `deg` degrees. */
function releaseFiles(degrees = [0, 10, 20], { model = "google/embeddinggemma-2" } = {}) {
  const bytes = new Uint8Array(degrees.length * DIMS * 4);
  const view = new DataView(bytes.buffer);
  degrees.forEach((deg, row) => {
    view.setFloat32(row * DIMS * 4, Math.cos((deg * Math.PI) / 180), true);
    view.setFloat32((row * DIMS + 1) * 4, Math.sin((deg * Math.PI) / 180), true);
  });
  const manifest = {
    schemaVersion: 1, model, dimensions: DIMS, dtype: "float32-le", normalization: "l2", count: degrees.length,
    modelRevision: "r1", rowOrder: "ids.json", vectors: "vectors.f32",
    vectorsSha256: createHash("sha256").update(bytes).digest("hex"), generatedAt: "2026-11-01T00:00:00Z",
  };
  const ids = degrees.map((_, i) => ({ id: 500 + i, type: "research-items", lowSignal: false }));
  return { manifest, ids, vectors: bytes };
}

// Tag → files. v1-9 is a draft, v1-8 has the wrong model, v1-7 verifies.
const RELEASES = {
  "semantic-embeddings-v1-8": releaseFiles(undefined, { model: "some/other-model" }),
  "semantic-embeddings-v1-7": releaseFiles(),
};
const LISTING = [
  { tag_name: "semantic-embeddings-v1-9", draft: true, prerelease: false },
  { tag_name: "semantic-embeddings-v1-8", draft: false, prerelease: false },
  { tag_name: "not-a-vector-release", draft: false, prerelease: false },
  { tag_name: "semantic-embeddings-v1-7", draft: false, prerelease: false },
];

const requests = [];
const server = createServer((req, res) => {
  requests.push({ url: req.url, authorization: req.headers.authorization });
  const asset = /^\/download\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(req.url);
  if (req.url === `/api/repos/${REPO}/releases?per_page=100`) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(LISTING));
  }
  const files = asset && RELEASES[asset[1]];
  if (files && asset[2] === "vectors.f32") { res.writeHead(200); return res.end(Buffer.from(files.vectors)); }
  if (files && (asset[2] === "manifest.json" || asset[2] === "ids.json")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(asset[2] === "manifest.json" ? files.manifest : files.ids));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
test.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

hermeticEnv();
process.env.AMIRA_ENRICHMENT_BASE = `http://127.0.0.1:${server.address().port}`;
// A token in the environment must never reach a stand-in host.
process.env.GITHUB_TOKEN = "must-not-leak";
const lib = await import("../../server/lib.js");

test("latest settles on the newest release that verifies, skipping drafts, other tags and a wrong model", async () => {
  const log = [];
  const release = await lib.fetchSemanticRelease("latest", (m) => log.push(m));
  assert.equal(release.tag, "semantic-embeddings-v1-7");
  assert.match(log.join("\n"), /semantic-embeddings-v1-8 skipped: .*model/);
  assert.ok(!requests.some((r) => r.url.includes("v1-9")), "a draft is never downloaded");
  assert.ok(requests.every((r) => r.authorization === undefined), "no Authorization header to a stand-in host");
});

test("a pinned tag is checked before any request, and never falls back to another build", async () => {
  await assert.rejects(lib.fetchSemanticRelease("v1-7"), /must be "latest", "off" or a release tag/);
  await assert.rejects(lib.fetchSemanticRelease("semantic-embeddings-v1-8"), /model is some\/other-model/);
  assert.equal(await lib.fetchSemanticRelease("off"), null);
  assert.equal((await lib.fetchSemanticRelease("semantic-embeddings-v1-7")).tag, "semantic-embeddings-v1-7");
});

test("computeNeighbours stops when its signal aborts", async () => {
  const f = RELEASES["semantic-embeddings-v1-7"];
  const release = lib.verifySemanticRelease({ tag: "semantic-embeddings-v1-7", ...f });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(lib.computeNeighbours(release, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION).data, { signal: controller.signal }),
    { name: "AbortError" });
});

test("k-means with more groups than distinct points restarts empty groups and still partitions every record", async () => {
  // Three identical rows and three groups: two starts land on the same point,
  // so a group empties and restarts on the record furthest from its centre.
  const f = releaseFiles([0, 0, 0]);
  const release = lib.verifySemanticRelease({ tag: "semantic-embeddings-v1-7", ...f });
  const out = await lib.computeNeighbours(release, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION).data, { clusters: 3 });
  const members = out.clusters.members.flat().sort();
  assert.deepEqual(members, [500, 501, 502], "every clustered record sits in exactly one group");
  assert.ok(out.clusters.members.every((g) => g.length > 0), "no empty group is stored");
  assert.ok(out.clusters.members.length <= 3);
  // Sizes descending: group 1 is the largest.
  const sizes = out.clusters.members.map((g) => g.length);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});
