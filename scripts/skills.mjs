// Build-time Agent Skills snapshot for "Skills over MCP" (final SEP-2640).
//
// Walks the committed skill directory and returns an IMMUTABLE SNAPSHOT — every
// file under it, keyed by its path relative to that directory — that
// scripts/build.mjs inlines into the bundles as `__SKILLS_SNAPSHOT__`. The
// runtime (src/skills.ts) hands that record to the SDK's Skills extension
// through `memorySkillFiles`, so it needs no filesystem access — the same split
// the data snapshot already uses, and the reason the HTTP deployment can serve
// skills without shipping .claude/.
//
// VALIDATION IS THE SDK'S. The snapshot is checked here by loading it through
// `SkillsExtension.load` — the very call the runtime makes — so the frontmatter
// rules, the name/directory match, SKILL_LIMITS, digests and sizes are the
// SDK's, maintained upstream, and a build can never accept a catalog the
// server would then refuse.
//
// TWO VALIDATION MODES (mcp-use's dev-lenient / build-strict split):
//
//   lenient (default)   an invalid skill is DROPPED from the snapshot and its
//                       error reported; every valid skill still ships. Serving
//                       an empty catalog beats serving a skill whose frontmatter
//                       contradicts its SKILL.md — hosts treat that mismatch as
//                       a verification failure, not as a warning.
//   strict (--strict)   any error fails the build. Wired into prepack-mcpb and
//                       `npm run skills:check`, so a broken skill can never
//                       reach a Release.
//
// Warnings never fail a build in either mode: they flag soft problems the SDK
// reports without skipping a skill (a `skill.md` that should be `SKILL.md`).
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SkillCatalogError, SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";

/** Conventional skill directory — the same folder Claude Code loads locally. */
export const DEFAULT_SKILLS_DIR = ".claude/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Never served: editor droppings, VCS metadata, dependency trees. The SDK skips
 * dot-names itself; these are the rest.
 */
const IGNORED = new Set(["node_modules", "Thumbs.db", "desktop.ini", "__pycache__"]);

/** Lossless UTF-8 only (a BOM is kept), the same test the SDK applies when it serves a file. */
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Recursively list a directory. Returns POSIX-relative file paths, sorted, so
 * two builds of the same tree produce byte-identical snapshots.
 */
async function collectFiles(absDir, prefix = "") {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collectFiles(path.join(absDir, entry.name), rel)));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

/**
 * The record `memorySkillFiles` serves: text where the bytes decode losslessly,
 * raw bytes otherwise. Either way the SDK hashes exactly the committed bytes.
 */
export function skillFiles(snapshot) {
  const files = { ...snapshot.text };
  for (const [rel, base64] of Object.entries(snapshot.base64)) files[rel] = new Uint8Array(Buffer.from(base64, "base64"));
  return files;
}

/** `skill://a/b/SKILL.md` → `a/b`: the skill's folder, as a snapshot path. */
const skillDirOf = (uri) =>
  uri
    .slice("skill://".length, -"/SKILL.md".length)
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");

/** Load a record the way the runtime does, collecting the SDK's reports. */
async function loadCatalog(files, strict) {
  const warnings = [];
  try {
    const catalog = await SkillsExtension.load(memorySkillFiles(files), {
      strict,
      onWarning: ({ path: where, message }) => warnings.push(`${where}: ${message}`),
    });
    return { catalog, warnings, errors: [] };
  } catch (err) {
    if (!SkillCatalogError.isInstance(err)) throw err;
    return { catalog: undefined, warnings, errors: err.problems.map(({ path: where, message }) => `${where}: ${message}`) };
  }
}

/**
 * Snapshot and validate every skill under `dir`.
 *
 * @param {{root?: string, dir?: string, strict?: boolean}} [options]
 * @returns {Promise<{snapshot: {text: Record<string, string>, base64: Record<string, string>}, skills: object[], errors: string[], warnings: string[], skillDir: string}>}
 */
export async function buildSkillsSnapshot(options = {}) {
  const { root = REPO_ROOT, dir = DEFAULT_SKILLS_DIR, strict = false } = options;
  const skillDir = path.resolve(root, dir);
  const empty = { text: {}, base64: {} };

  let rels;
  try {
    rels = await collectFiles(skillDir);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const message = `skills: directory not found: ${skillDir}`;
    if (strict) throw new Error(`invalid skill catalog:\n  - ${message}`);
    return { snapshot: empty, skills: [], errors: [], warnings: [message], skillDir };
  }

  const all = { text: {}, base64: {} };
  for (const rel of rels) {
    const bytes = await fs.readFile(path.join(skillDir, rel));
    try {
      all.text[rel] = utf8.decode(bytes);
    } catch {
      all.base64[rel] = bytes.toString("base64");
    }
  }

  // The one rule that is this repo's, not the SDK's: every folder here is a
  // skill, as Claude Code reads it. The SDK would just not serve a folder
  // without SKILL.md, so a misnamed manifest would vanish without a word.
  const tops = [...new Set(rels.filter((rel) => rel.includes("/")).map((rel) => rel.split("/")[0]))];
  const layout = tops
    .filter((top) => !rels.includes(`${top}/SKILL.md`))
    .map((top) => `${top}: no SKILL.md in ${path.join(skillDir, top)}`);

  // Strict first: it reports every problem without skipping anything. Its
  // warnings are the soft ones only, since strict turns the rest into errors.
  const checked = await loadCatalog(skillFiles(all), true);
  const { warnings } = checked;
  const errors = [...layout, ...checked.errors];
  if (strict && errors.length > 0) throw new Error(`invalid skill catalog:\n  - ${errors.join("\n  - ")}`);
  const catalog = checked.catalog ?? (await loadCatalog(skillFiles(all), false)).catalog;
  const skills = [...(catalog?.entries ?? [])];
  if (strict && skills.length === 0) throw new Error(`invalid skill catalog:\n  - skills: no skill in ${skillDir}`);

  // Ship only what the catalog serves: the files of the skills that loaded. A
  // dropped skill's files, and loose files outside every skill, stay out of
  // the bundle, so the runtime load meets exactly the catalog checked here.
  const dirs = skills.map((skill) => `${skillDirOf(skill.uri)}/`);
  const served = (rel) => dirs.some((prefix) => rel.startsWith(prefix));
  const snapshot = { text: {}, base64: {} };
  for (const kind of ["text", "base64"]) {
    for (const [rel, content] of Object.entries(all[kind])) if (served(rel)) snapshot[kind][rel] = content;
  }
  return { snapshot, skills, errors, warnings, skillDir };
}

// `node scripts/skills.mjs [--strict]` — standalone catalog check (npm run skills:check).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes("--strict");
  try {
    const { snapshot, skills, errors, warnings } = await buildSkillsSnapshot({ strict });
    for (const w of warnings) console.warn(`warn  ${w}`);
    for (const e of errors) console.error(`error ${e}`);
    for (const skill of skills) console.log(`ok    ${skill.uri} (${skill.resources.length} file(s))`);
    const files = Object.keys(snapshot.text).length + Object.keys(snapshot.base64).length;
    console.log(`\n${skills.length} skill(s), ${files} file(s)`);
    if (errors.length > 0) process.exit(1);
  } catch (err) {
    console.error(`skills: ${err.message}`);
    process.exit(1);
  }
}
