// Keep CITATION.cff's `version` and `date-released` in step with the release,
// so citing the software never quotes a version that was never released.
//
// The version lives in three files (package.json, manifest.json, CITATION.cff)
// and a human bumping three files by hand will eventually bump two. The first
// two are load-bearing — the build injects package.json's version into the
// bundle and `mcpb validate` reads manifest.json — so they fail loudly when
// wrong. CITATION.cff fails silently: nothing validates it, and GitHub's "Cite
// this repository" button will happily render a stale version forever. So this
// is stamped from the tag at release time instead of being maintained by hand.
//
// Two lines are rewritten by regex rather than round-tripping the YAML: this
// repo has no YAML dependency, and a formatter reflowing the whole file to
// normalise quoting would make every release diff unreadable.
//
// Usage:
//   node scripts/stamp-citation.mjs                    stamp from package.json + today (UTC)
//   node scripts/stamp-citation.mjs --version 1.13.0 --date 2026-08-05
//   node scripts/stamp-citation.mjs --check            exit 1 on version drift; write nothing
//
// `--check` compares the VERSION only. `date-released` records when a release
// happened, which is not derivable from the working tree — checking it against
// today would report drift on every day that is not a release day.

import { readFile, writeFile } from "node:fs/promises";

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

if (!/^\d+\.\d+\.\d+/.test(version)) {
  console.error(`stamp-citation: not a version: ${version}`);
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`stamp-citation: not a YYYY-MM-DD date: ${date}`);
  process.exit(2);
}

const before = await readFile(CFF, "utf8");

// Anchored to the line start so the `version:` inside a `references:` entry —
// indented — can never be hit.
const after = before
  .replace(/^version: .*$/m, `version: ${version}`)
  .replace(/^date-released: .*$/m, `date-released: "${date}"`);

for (const key of ["version", "date-released"]) {
  if (!new RegExp(`^${key}: `, "m").test(after)) {
    console.error(`stamp-citation: no top-level \`${key}:\` line in CITATION.cff`);
    process.exit(2);
  }
}

if (check) {
  const found = before.match(/^version: (.*)$/m)?.[1]?.trim();
  if (found === version) {
    console.log(`CITATION.cff cites version ${version}`);
    process.exit(0);
  }
  console.error(
    `CITATION.cff cites version ${found}, expected ${version}.\n` +
      `Run: npm run stamp-citation`,
  );
  process.exit(1);
}

if (after === before) {
  console.log(`CITATION.cff already at ${version} (${date})`);
  process.exit(0);
}

await writeFile(CFF, after);
console.log(`CITATION.cff stamped: version ${version}, date-released ${date}`);
