// Freshness signature for the rolling `data-latest` release
// (.github/workflows/refresh-data.yml). The workflow republishes only when this
// value differs from the signature attached to the previous rolling release.
//
// It covers the transformed snapshot (vocabulary-derived metadata, item sets
// and every record) AND the code version from package.json. Hashing data alone
// meant a code release never refreshed the rolling .mcpb: it kept serving the
// old bundle until the Omeka data happened to change.
//
// The hash is exported and unit-tested (test/unit/release-scripts.test.mjs):
// a signature that ignores a change publishes nothing, one that varies on its
// own republishes every week.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * sha256 over the code version, the snapshot's data, and the corpus-vector
 * build and full-text map it serves. `out` is what loadSnapshot returns; the fetch time and the
 * rest of the manifest are left out on purpose, so a re-crawl of unchanged
 * data keeps its signature.
 */
export function snapshotSignature(version, out) {
  return createHash("sha256")
    .update(`amira-mcp-server@${version}\n`)
    .update(JSON.stringify(out.data))
    // A new corpus-vector build changes the neighbours the bundle serves.
    .update(JSON.stringify(out.semantic?.source ?? null))
    // So does the full-text map: a run during a GitHub outage published a
    // bundle without it, and later runs, signing the same data, never put it back.
    .update(JSON.stringify(out.fulltext?.source ?? null))
    .digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { loadSnapshot } = await import("../server/lib.js");
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  // Resolved from this file, like every other script, not from the working directory.
  const out = await loadSnapshot(fileURLToPath(new URL("../data", import.meta.url)));
  console.log(snapshotSignature(version, out));
}
