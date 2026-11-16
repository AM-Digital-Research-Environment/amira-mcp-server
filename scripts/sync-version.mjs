// Keep manifest.json's `version` equal to package.json's. Both were bumped by
// hand, and `validate:manifest`, the packaging test and the release guard all
// fail on a mismatch, so a forgotten manifest bump cost a release round trip.
// npm's `version` lifecycle runs this after `npm version <x>` has bumped
// package.json and before it commits, then stages manifest.json:
//
//   npm version minor                       bumps both, commits, tags
//   node scripts/sync-version.mjs           copy package.json's version into manifest.json
//   node scripts/sync-version.mjs --check   exit 1 if they differ; write nothing
//
// CITATION.cff is not touched: the release stamps it from the tag
// (scripts/stamp-citation.mjs).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

/**
 * manifest.json's text with its top-level `version` set to `version`. Only that
 * one value is rewritten, so the file keeps its layout; the result is parsed
 * back to prove the edit landed on the top-level key.
 */
export function syncManifestVersion(text, version) {
  if (!VERSION.test(version ?? "")) throw new Error(`not a version: ${version}`);
  const current = JSON.parse(text).version;
  if (typeof current !== "string") throw new Error("manifest.json has no top-level version");
  if (current === version) return text;
  // The top-level key is the first `"version"` at two-space indent.
  const next = text.replace(/^( {2}"version":\s*)"[^"]*"/m, `$1"${version}"`);
  if (JSON.parse(next).version !== version) throw new Error("could not rewrite manifest.json's top-level version");
  return next;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestFile = new URL("../manifest.json", import.meta.url);
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const before = readFileSync(manifestFile, "utf8");
  const after = syncManifestVersion(before, version);
  if (process.argv.includes("--check")) {
    if (after !== before) {
      console.error(`manifest.json cites version ${JSON.parse(before).version}, package.json ${version}. Run: node scripts/sync-version.mjs`);
      process.exit(1);
    }
    console.log(`manifest.json and package.json agree on ${version}`);
  } else if (after === before) {
    console.log(`manifest.json already at ${version}`);
  } else {
    writeFileSync(manifestFile, after);
    console.log(`manifest.json version set to ${version}`);
  }
}
