// Keep CITATION.cff's `version` and `date-released` in step with the release,
// so citing the software never quotes a version that was never released.
//
// The version lives in three files (package.json, manifest.json, CITATION.cff).
// The first two are load-bearing — the build injects package.json's version
// into the bundle, `validate:manifest` reads manifest.json, and
// scripts/sync-version.mjs keeps them equal — so they fail loudly when wrong.
// CITATION.cff fails silently: nothing validates it, and GitHub's "Cite this
// repository" button will happily render a stale version forever. So it is
// never maintained by hand: npm's `version` lifecycle stamps it with the bump
// (package.json), and the release stamps it again from the tag.
//
// Two lines are rewritten by regex rather than round-tripping the YAML: a YAML
// serializer (the `yaml` devDependency the tests use) would reflow the whole
// file and normalise quoting, which would make every release diff unreadable.
//
// Usage:
//   node scripts/stamp-citation.mjs                    stamp from package.json + today (UTC)
//   node scripts/stamp-citation.mjs --version 1.13.0 --date 2026-08-05
//   node scripts/stamp-citation.mjs --check            exit 1 on version drift; write nothing
//
// `--check` compares the VERSION only. `date-released` records when a release
// happened, which is not derivable from the working tree — checking it against
// today would report drift on every day that is not a release day.
//
// The release job runs this on a checkout of main and pushes the result, so
// the text transformation is exported and unit-tested
// (test/unit/release-scripts.test.mjs).

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CITATION.cff's text with its top-level `version` and `date-released` set.
 * Anchored to the line start, so the `version:` inside an indented
 * `references:` entry can never be hit. Throws on a malformed version or date,
 * or when either top-level line is missing.
 */
export function stampCitation(text, { version, date }) {
  if (!VERSION.test(version ?? "")) throw new Error(`not a version: ${version}`);
  if (!DATE.test(date ?? "")) throw new Error(`not a YYYY-MM-DD date: ${date}`);
  for (const key of ["version", "date-released"]) {
    if (!new RegExp(`^${key}: `, "m").test(text)) throw new Error(`no top-level \`${key}:\` line in CITATION.cff`);
  }
  return text
    .replace(/^version: .*$/m, `version: ${version}`)
    .replace(/^date-released: .*$/m, `date-released: "${date}"`);
}

/** The top-level version CITATION.cff cites, or undefined. */
export function citedVersion(text) {
  return text.match(/^version: (.*)$/m)?.[1]?.trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const CFF = new URL("../CITATION.cff", import.meta.url);
  const PKG = new URL("../package.json", import.meta.url);

  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? undefined : args[i + 1];
  };
  const check = args.includes("--check");

  const version = flag("version") ?? JSON.parse(await readFile(PKG, "utf8")).version;
  const date = flag("date") ?? new Date().toISOString().slice(0, 10);

  const before = await readFile(CFF, "utf8");
  let after;
  try {
    after = stampCitation(before, { version, date });
  } catch (err) {
    console.error(`stamp-citation: ${err.message}`);
    process.exit(2);
  }

  if (check) {
    const found = citedVersion(before);
    if (found === version) {
      console.log(`CITATION.cff cites version ${version}`);
      process.exit(0);
    }
    console.error(`CITATION.cff cites version ${found}, expected ${version}.\nRun: npm run stamp-citation`);
    process.exit(1);
  }

  if (after === before) {
    console.log(`CITATION.cff already at ${version} (${date})`);
    process.exit(0);
  }

  await writeFile(CFF, after);
  console.log(`CITATION.cff stamped: version ${version}, date-released ${date}`);
}
