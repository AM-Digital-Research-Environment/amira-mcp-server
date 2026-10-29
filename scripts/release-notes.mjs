// Print one version's CHANGELOG.md section, the body of its GitHub Release.
// `--generate-notes` only lists merged pull requests, and this repository
// mostly lands on main directly, so the generated notes said almost nothing.
// The IWAC server releases with a notes file the same way.
//
//   node scripts/release-notes.mjs 1.31.0 > notes.md
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
  console.error("usage: node scripts/release-notes.mjs <version>");
  process.exit(2);
}
const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} `) || line === `## ${version}`);
if (start < 0) {
  console.error(`CHANGELOG.md has no "## ${version}" section`);
  process.exit(1);
}
const next = lines.findIndex((line, i) => i > start && line.startsWith("## "));
const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
if (!body) {
  console.error(`CHANGELOG.md's "## ${version}" section is empty`);
  process.exit(1);
}
process.stdout.write(`${body}\n\nSee [CHANGELOG.md](CHANGELOG.md) for earlier releases.\n`);
