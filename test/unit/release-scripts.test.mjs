// The release helpers with no other test: stamp-citation (the release pushes
// its output to main), snapshot-signature (decides whether the weekly refresh
// publishes) and sync-version (keeps manifest.json on package.json's version).
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { snapshotSignature } from "../../scripts/snapshot-signature.mjs";
import { citedVersion, stampCitation } from "../../scripts/stamp-citation.mjs";
import { syncManifestVersion } from "../../scripts/sync-version.mjs";
import { REPO_ROOT } from "../helpers/env.mjs";

const CFF = `cff-version: 1.2.0
title: "AMIRA MCP Server"
version: 1.2.3
date-released: "2026-01-02"
references:
  - type: standard
    title: "Model Context Protocol"
    version: 9.9.9
`;

test("stampCitation rewrites the top-level version and date only", () => {
  const out = stampCitation(CFF, { version: "1.4.0", date: "2026-11-16" });
  const parsed = YAML.parse(out);
  assert.equal(parsed.version, "1.4.0");
  assert.equal(parsed["date-released"], "2026-11-16");
  assert.equal(parsed.references[0].version, "9.9.9", "an indented version: is never touched");
  assert.equal(out.split("\n").length, CFF.split("\n").length, "no reflow");
  assert.equal(citedVersion(out), "1.4.0");
  // Stamping again is a no-op, which is how the release finds nothing to commit.
  assert.equal(stampCitation(out, { version: "1.4.0", date: "2026-11-16" }), out);
  assert.equal(stampCitation(CFF, { version: "2.0.0-rc.1", date: "2026-11-16" }).includes("version: 2.0.0-rc.1"), true);
});

test("stampCitation refuses malformed input instead of writing it", () => {
  for (const version of ["v1.4.0", "1.4", "1.4.0 ", "1.4.0\nevil: true", undefined]) {
    assert.throws(() => stampCitation(CFF, { version, date: "2026-11-16" }), /not a version/, String(version));
  }
  for (const date of ["16.11.2026", "2026-11-16T00:00", undefined]) {
    assert.throws(() => stampCitation(CFF, { version: "1.4.0", date }), /not a YYYY-MM-DD date/, String(date));
  }
  assert.throws(() => stampCitation(CFF.replace(/^version: .*\n/m, ""), { version: "1.4.0", date: "2026-11-16" }),
    /no top-level `version:`/);
  assert.throws(() => stampCitation(CFF.replace(/^date-released: .*\n/m, ""), { version: "1.4.0", date: "2026-11-16" }),
    /no top-level `date-released:`/);
});

test("the repository's CITATION.cff cites package.json's version (stamp-citation --check)", () => {
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "stamp-citation.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});

const SNAPSHOT = { data: { research_items: [{ o_id: 1, title: "A" }] }, semantic: { source: { tag: "semantic-v1" } },
  manifest: { fetchedAt: "2026-11-01T00:00:00Z" } };

test("snapshotSignature hashes the code version, the data, the vector build and the full-text map, nothing else", () => {
  const expected = createHash("sha256").update("amira-mcp-server@1.0.0\n").update(JSON.stringify(SNAPSHOT.data))
    .update(JSON.stringify(SNAPSHOT.semantic.source)).update("null").digest("hex");
  const base = snapshotSignature("1.0.0", SNAPSHOT);
  assert.equal(base, expected, "the formula the published signatures were computed with");
  assert.match(base, /^[0-9a-f]{64}$/);

  // A re-crawl of unchanged data keeps the signature: nothing to publish.
  assert.equal(snapshotSignature("1.0.0", { ...SNAPSHOT, manifest: { fetchedAt: "2026-11-08T00:00:00Z" } }), base);
  // Each of these must republish the rolling bundle.
  assert.notEqual(snapshotSignature("1.0.1", SNAPSHOT), base, "a code release");
  assert.notEqual(snapshotSignature("1.0.0", { ...SNAPSHOT, data: { research_items: [{ o_id: 1, title: "B" }] } }), base, "changed data");
  assert.notEqual(snapshotSignature("1.0.0", { ...SNAPSHOT, semantic: { source: { tag: "semantic-v2" } } }), base, "a new vector build");
  assert.notEqual(snapshotSignature("1.0.0", { ...SNAPSHOT, semantic: undefined }), base, "vectors withdrawn");
  // A bundle published without the full-text map (GitHub down) is republished once the map is back (#52).
  assert.notEqual(snapshotSignature("1.0.0", { ...SNAPSHOT, fulltext: { source: { tag: "v1.0.0" } } }), base, "the full-text map");
});

test("syncManifestVersion sets only the top-level version and keeps the layout", () => {
  const manifest = `{\n  "manifest_version": "0.3",\n  "version": "1.0.0",\n  "server": {\n    "version": "inner"\n  }\n}\n`;
  const out = syncManifestVersion(manifest, "1.1.0");
  assert.equal(out, manifest.replace(`"version": "1.0.0"`, `"version": "1.1.0"`));
  assert.equal(JSON.parse(out).server.version, "inner");
  assert.equal(syncManifestVersion(out, "1.1.0"), out, "already in step: unchanged");
  assert.throws(() => syncManifestVersion(manifest, "1.1"), /not a version/);
  assert.throws(() => syncManifestVersion(`{\n  "name": "x"\n}\n`, "1.1.0"), /no top-level version/);
});

test("manifest.json is on package.json's version, and npm version keeps it there", () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.match(pkg.scripts.version ?? "", /scripts\/sync-version\.mjs/, "the npm `version` lifecycle runs sync-version");
  const run = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "sync-version.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
});
