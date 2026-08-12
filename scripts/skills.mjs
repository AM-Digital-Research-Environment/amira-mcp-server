// Build-time Agent Skills discovery for "Skills over MCP" (draft SEP-2640).
//
// Walks the committed skill directory, validates each skill, hashes every file,
// and returns an IMMUTABLE SNAPSHOT that scripts/build.mjs inlines into the
// bundles as `__SKILLS_SNAPSHOT__`. The runtime (src/skills.ts) therefore needs
// no filesystem access and no YAML parser — the same split the data snapshot
// already uses, and the reason the HTTP deployment can serve skills without
// shipping .claude/.
//
// TWO VALIDATION MODES (mcp-use's dev-lenient / build-strict split):
//
//   lenient (default)   an invalid skill is DROPPED from the catalog and its
//                       error reported; every valid skill still ships. Serving
//                       an empty catalog beats serving a skill whose frontmatter
//                       contradicts its SKILL.md — hosts treat that mismatch as
//                       a verification failure, not as a warning.
//   strict (--strict)   any error fails the build. Wired into prepack-mcpb and
//                       `npm run skills:check`, so a broken skill can never
//                       reach a Release.
//
// Warnings never fail a build in either mode: they flag soft limits from the
// Agent Skills spec that SEP-2640 does not make a wire requirement.
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

/** Capability id negotiated for the draft Skills over MCP extension. */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/** Conventional skill directory — the same folder Claude Code loads locally. */
export const DEFAULT_SKILLS_DIR = ".claude/skills";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Agent Skills naming rule for the `name` field (and the directory it lives in). */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;

/** Soft limit from the Agent Skills spec — warned about, never fatal here. */
const DESCRIPTION_MAX = 1024;

/** Never served: editor droppings, VCS metadata, dependency trees. */
const IGNORED = new Set(["node_modules", "Thumbs.db", "desktop.ini", "__pycache__"]);

/**
 * Extension → [mimeType, isBinary]. Binary files travel as base64 `blob`,
 * everything else as UTF-8 `text`; the digest is over the raw bytes either way,
 * so the classification only decides the transport, never the hash.
 */
const MIME_TYPES = {
  ".md": ["text/markdown", false],
  ".markdown": ["text/markdown", false],
  ".txt": ["text/plain", false],
  ".json": ["application/json", false],
  ".jsonl": ["application/jsonl", false],
  ".yaml": ["application/yaml", false],
  ".yml": ["application/yaml", false],
  ".csv": ["text/csv", false],
  ".tsv": ["text/tab-separated-values", false],
  ".js": ["text/javascript", false],
  ".mjs": ["text/javascript", false],
  ".ts": ["text/typescript", false],
  ".py": ["text/x-python", false],
  ".sh": ["application/x-sh", false],
  ".html": ["text/html", false],
  ".css": ["text/css", false],
  ".svg": ["image/svg+xml", false],
  ".png": ["image/png", true],
  ".jpg": ["image/jpeg", true],
  ".jpeg": ["image/jpeg", true],
  ".gif": ["image/gif", true],
  ".webp": ["image/webp", true],
  ".pdf": ["application/pdf", true],
  ".zip": ["application/zip", true],
};

const mimeFor = (file) => MIME_TYPES[path.extname(file).toLowerCase()] ?? ["application/octet-stream", true];

/** `sha256:<64 lowercase hex>` over the raw file bytes, per SEP-2640. */
const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Percent-encode one path segment; `/` stays the separator, dots stay readable. */
const encodeSegment = (segment) => encodeURIComponent(segment);

const skillUri = (skillPath, relFile = "") => {
  const base = `skill://${skillPath.split("/").map(encodeSegment).join("/")}`;
  if (!relFile) return base;
  return `${base}/${relFile.split("/").map(encodeSegment).join("/")}`;
};

/**
 * Recursively list a skill directory. Returns POSIX-relative paths, sorted, so
 * two builds of the same tree produce byte-identical snapshots.
 *
 * @returns {Promise<{files: string[], dirs: string[]}>}
 */
async function collectTree(absDir, prefix = "") {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const files = [];
  const dirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || IGNORED.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      dirs.push(rel);
      const nested = await collectTree(path.join(absDir, entry.name), rel);
      files.push(...nested.files);
      dirs.push(...nested.dirs);
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  files.sort();
  dirs.sort();
  return { files, dirs };
}

/** Split `---\nYAML\n---\nbody` — returns the raw frontmatter block or null. */
function frontmatterBlock(source) {
  const text = source.startsWith("﻿") ? source.slice(1) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return match ? match[1] : null;
}

/**
 * Validate one skill directory and turn it into snapshot entries.
 *
 * @returns {Promise<{entry: object, resources: object[], directories: object[], warnings: string[]}>}
 * @throws {Error} on any condition that makes the skill unservable.
 */
async function readSkill(absDir, skillPath) {
  const label = `skill://${skillPath}`;
  const { files, dirs } = await collectTree(absDir);
  if (!files.includes("SKILL.md")) throw new Error(`${label}: no SKILL.md in ${absDir}`);

  const source = await fs.readFile(path.join(absDir, "SKILL.md"), "utf8");
  const block = frontmatterBlock(source);
  if (block === null) throw new Error(`${label}: SKILL.md has no YAML frontmatter block`);

  let frontmatter;
  try {
    frontmatter = parseYaml(block);
  } catch (err) {
    throw new Error(`${label}: frontmatter is not valid YAML — ${err.message}`);
  }
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new Error(`${label}: frontmatter must be a YAML mapping`);
  }

  const warnings = [];
  const { name, description } = frontmatter;
  const dirName = skillPath.split("/").pop();

  if (typeof name !== "string" || name.length === 0) throw new Error(`${label}: frontmatter 'name' is required`);
  if (name !== dirName) throw new Error(`${label}: frontmatter name '${name}' must equal its directory '${dirName}'`);
  if (!NAME_RE.test(name)) throw new Error(`${label}: name '${name}' must be lowercase letters, digits and single hyphens`);
  if (name.length > NAME_MAX) throw new Error(`${label}: name is ${name.length} chars (max ${NAME_MAX})`);
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new Error(`${label}: frontmatter 'description' is required and must be a non-empty string`);
  }
  if (description.length > DESCRIPTION_MAX) {
    warnings.push(`${label}: description is ${description.length} chars (Agent Skills soft limit ${DESCRIPTION_MAX})`);
  }

  const resources = [];
  for (const rel of files) {
    const bytes = await fs.readFile(path.join(absDir, rel));
    const [mimeType, binary] = mimeFor(rel);
    resources.push({
      uri: skillUri(skillPath, rel),
      name: rel.split("/").pop(),
      mimeType,
      digest: digestOf(bytes),
      ...(binary ? { blob: bytes.toString("base64") } : { text: bytes.toString("utf8") }),
    });
  }

  const directories = [
    { uri: skillUri(skillPath), name: dirName },
    ...dirs.map((rel) => ({ uri: skillUri(skillPath, rel), name: rel.split("/").pop() })),
  ];

  return {
    entry: {
      uri: skillUri(skillPath, "SKILL.md"),
      frontmatter,
      // Complete manifest: every file exactly once, SKILL.md included.
      resources: resources.map(({ uri, digest }) => ({ uri, digest })),
    },
    resources,
    directories,
    warnings,
  };
}

/**
 * Discover, validate and snapshot every skill under `dir`.
 *
 * @param {{root?: string, dir?: string, strict?: boolean}} [options]
 * @returns {Promise<{snapshot: object, errors: string[], warnings: string[], skillDir: string}>}
 */
export async function buildSkillsSnapshot(options = {}) {
  const { root = REPO_ROOT, dir = DEFAULT_SKILLS_DIR, strict = false } = options;
  const skillDir = path.resolve(root, dir);
  const errors = [];
  const warnings = [];
  const skills = [];
  const resources = new Map();
  const directories = new Map();

  let roots = [];
  try {
    roots = (await fs.readdir(skillDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !IGNORED.has(e.name))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    const message = `skills: directory not found: ${skillDir}`;
    if (strict) errors.push(message);
    else warnings.push(message);
    roots = [];
  }

  // A directory holding its own SKILL.md is an independent skill AND supporting
  // content of its parent — SEP-2640 requires both, so nested skills are queued
  // rather than skipped.
  const queue = [];
  for (const name of roots) queue.push({ abs: path.join(skillDir, name), skillPath: name });

  while (queue.length > 0) {
    const { abs, skillPath } = queue.shift();
    let read;
    try {
      read = await readSkill(abs, skillPath);
    } catch (err) {
      errors.push(err.message);
      continue; // lenient: drop this skill, keep the rest
    }
    skills.push(read.entry);
    warnings.push(...read.warnings);
    for (const resource of read.resources) resources.set(resource.uri, resource);
    for (const directory of read.directories) directories.set(directory.uri, directory);

    const { dirs } = await collectTree(abs);
    for (const rel of dirs) {
      const nestedAbs = path.join(abs, rel);
      try {
        await fs.access(path.join(nestedAbs, "SKILL.md"));
        queue.push({ abs: nestedAbs, skillPath: `${skillPath}/${rel}` });
      } catch {
        /* an ordinary supporting directory */
      }
    }
  }

  if (strict && errors.length > 0) {
    throw new Error(`invalid skill catalog:\n  - ${errors.join("\n  - ")}`);
  }

  const byUri = (a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0);
  return {
    snapshot: {
      skills: skills.sort(byUri),
      resources: [...resources.values()].sort(byUri),
      directories: [...directories.values()].sort(byUri),
    },
    errors,
    warnings,
    skillDir,
  };
}

// `node scripts/skills.mjs [--strict]` — standalone catalog check (npm run skills:check).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes("--strict");
  try {
    const { snapshot, errors, warnings } = await buildSkillsSnapshot({ strict });
    for (const w of warnings) console.warn(`warn  ${w}`);
    for (const e of errors) console.error(`error ${e}`);
    for (const skill of snapshot.skills) {
      console.log(`ok    ${skill.uri} (${skill.resources.length} file(s))`);
    }
    console.log(
      `\n${snapshot.skills.length} skill(s), ${snapshot.resources.length} resource(s), ` +
        `${snapshot.directories.length} directory resource(s)`,
    );
    if (errors.length > 0) process.exit(1);
  } catch (err) {
    console.error(`skills: ${err.message}`);
    process.exit(1);
  }
}
