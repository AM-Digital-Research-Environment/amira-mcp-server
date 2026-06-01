// Build the bundled JSON snapshot under ./data.
//
// Source resolution (first that works wins):
//   1. --from <dir> / AMIRA_DASHBOARD_DATA_DIR  — a local dashboard static/data dir
//   2. ../WissKI-dashboard/static/data          — sibling checkout (common dev layout)
//   3. the live public dashboard JSON           — https://<base>/data
//
// This mirrors src/data.ts: it reads the manifest, derives the exact file set the
// server needs (core dev/ entities, all project + external item collections, and
// publications.json), and copies/downloads only those — dropping the dashboard's
// heavy derived data (knowledge graphs, embeddings, thumbnails, wisski_urls).

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TARGET = path.join(PROJECT_ROOT, "data");

const DASHBOARD_BASE = (process.env.AMIRA_DASHBOARD_BASE || "https://amira.africamultiple.uni-bayreuth.de").replace(/\/+$/, "");
const DATA_BASE_URL = `${DASHBOARD_BASE}/data`;

const DEV_FILES = [
  "dev.persons.json",
  "dev.institutions.json",
  "dev.groups.json",
  "dev.researchSections.json",
  "dev.geo.json",
  "dev.projectsData.json",
];

function parseArgs() {
  const args = process.argv.slice(2);
  let from;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--from") from = args[i + 1];
  }
  return { from: from || process.env.AMIRA_DASHBOARD_DATA_DIR };
}

function dataFileList(manifest) {
  const files = ["manifest.json", "publications.json"];
  for (const f of DEV_FILES) files.push(`dev/${f}`);
  for (const [uni, ids] of Object.entries(manifest.universities ?? {})) {
    const folder = `projects_metadata_${uni}`;
    for (const id of ids) files.push(`${folder}/${folder}.${id}.json`);
  }
  for (const [folder, names] of Object.entries(manifest.external ?? {})) {
    for (const name of names) files.push(`${folder}/${folder}.${name}.json`);
  }
  return files;
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function resolveLocalSource(fromArg) {
  const candidates = [
    fromArg,
    path.resolve(PROJECT_ROOT, "..", "WissKI-dashboard", "static", "data"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (await pathExists(path.join(c, "manifest.json"))) return c;
  }
  return null;
}

async function readManifest(localDir) {
  if (localDir) {
    return JSON.parse(await fs.readFile(path.join(localDir, "manifest.json"), "utf8"));
  }
  const res = await fetch(`${DATA_BASE_URL}/manifest.json`);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching remote manifest`);
  return res.json();
}

async function copyFile(localDir, rel) {
  const src = path.join(localDir, rel);
  const dest = path.join(TARGET, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
  return (await fs.stat(dest)).size;
}

async function downloadFile(rel) {
  const res = await fetch(`${DATA_BASE_URL}/${rel}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = path.join(TARGET, rel);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, buf);
  return buf.length;
}

async function main() {
  const { from } = parseArgs();
  const localDir = await resolveLocalSource(from);
  console.log(localDir ? `Source: local dir ${localDir}` : `Source: live dashboard ${DATA_BASE_URL}`);

  await fs.rm(TARGET, { recursive: true, force: true });
  await fs.mkdir(TARGET, { recursive: true });

  const manifest = await readManifest(localDir);
  const files = dataFileList(manifest);

  let total = 0;
  let ok = 0;
  let skipped = 0;
  for (const rel of files) {
    try {
      const size = localDir ? await copyFile(localDir, rel) : await downloadFile(rel);
      total += size;
      ok++;
    } catch (err) {
      // publications.json is optional; warn on anything else.
      if (rel.endsWith("publications.json")) {
        skipped++;
        console.warn(`  (optional) skipped ${rel}: ${err.message}`);
      } else {
        console.error(`  FAILED ${rel}: ${err.message}`);
      }
    }
  }

  console.log(
    `\nWrote ${ok} files (${(total / 1024 / 1024).toFixed(1)} MB) to ${TARGET}` +
      (skipped ? `, ${skipped} optional skipped` : ""),
  );
  console.log(`Manifest generatedAt: ${manifest.generatedAt ?? "?"}`);
}

main().catch((err) => {
  console.error("fetch-data failed:", err);
  process.exit(1);
});
