// Build-time skill catalog (scripts/skills.mjs) — the SEP-2640 snapshot the
// runtime serves verbatim.
//
// Two things are worth testing here and nowhere else. First the DIGEST
// CONTRACT: a host that reads a skill file re-hashes it and compares against
// the listed digest, and treats any mismatch as tampering — so a digest
// computed over anything other than the raw file bytes silently makes every
// skill unusable, with no error on our side. Second the LENIENT/STRICT SPLIT:
// a broken skill must be dropped from a dev build and must fail a release
// build, and getting those backwards either ships a bad catalog or blocks
// local work on an unrelated typo.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillsSnapshot } from "../../scripts/skills.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");

/** Write a minimal valid skill; `frontmatter` overrides the defaults. */
async function writeSkill(root, dirName, { name = dirName, description = "A test skill.", extra = {} } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const lines = [`name: ${name}`, `description: ${description}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${lines.join("\n")}\n---\n\n# ${name}\n\nBody.\n`);
  return dir;
}

const tmp = async (label) => fs.mkdtemp(path.join(os.tmpdir(), `amira-skills-${label}-`));

test("the repo catalog holds the companion skill with a complete manifest", async () => {
  const { snapshot, errors } = await buildSkillsSnapshot({ root: REPO, strict: true });

  assert.deepEqual(errors, []);
  assert.equal(snapshot.skills.length, 1);

  const [skill] = snapshot.skills;
  assert.equal(skill.uri, "skill://amira-mcp/SKILL.md");
  assert.equal(skill.frontmatter.name, "amira-mcp");
  assert.equal(typeof skill.frontmatter.description, "string");
  assert.ok(skill.frontmatter.description.length > 0);

  // Every file exactly once, SKILL.md included.
  const uris = skill.resources.map((r) => r.uri);
  assert.ok(uris.includes("skill://amira-mcp/SKILL.md"));
  assert.ok(uris.includes("skill://amira-mcp/references/data-model.md"));
  assert.equal(new Set(uris).size, uris.length);
  assert.equal(uris.length, snapshot.resources.length);

  // Directory resources cover the skill root and each subdirectory.
  const dirs = snapshot.directories.map((d) => d.uri);
  assert.deepEqual(dirs, ["skill://amira-mcp", "skill://amira-mcp/references"]);
});

test("digests are sha256 over the raw file bytes, not the decoded text", async () => {
  const { snapshot } = await buildSkillsSnapshot({ root: REPO, strict: true });

  for (const resource of snapshot.resources) {
    assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);

    const rel = resource.uri.replace("skill://amira-mcp/", "");
    const bytes = await fs.readFile(path.join(REPO, ".claude", "skills", "amira-mcp", rel));
    assert.equal(resource.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);

    // What the host actually re-hashes is the payload we return.
    const payload = resource.text !== undefined ? Buffer.from(resource.text, "utf8") : Buffer.from(resource.blob, "base64");
    assert.equal(resource.digest, `sha256:${createHash("sha256").update(payload).digest("hex")}`);
  }
});

test("lenient drops an invalid skill and keeps the valid ones; strict fails the build", async () => {
  const root = await tmp("mixed");
  const dir = path.join(root, ".claude", "skills");
  await fs.mkdir(dir, { recursive: true });
  await writeSkill(dir, "good-skill");
  // Frontmatter name that contradicts its directory — a host would reject this
  // as a verification failure, so it must never reach the catalog.
  await writeSkill(dir, "bad-skill", { name: "renamed" });

  const lenient = await buildSkillsSnapshot({ root });
  assert.equal(lenient.snapshot.skills.length, 1);
  assert.equal(lenient.snapshot.skills[0].frontmatter.name, "good-skill");
  assert.equal(lenient.errors.length, 1);
  assert.match(lenient.errors[0], /must equal its directory/);

  await assert.rejects(() => buildSkillsSnapshot({ root, strict: true }), /invalid skill catalog/);
});

test("structural defects are rejected", async () => {
  const root = await tmp("bad");
  const dir = path.join(root, ".claude", "skills");
  await fs.mkdir(path.join(dir, "no-manual"), { recursive: true });
  await fs.writeFile(path.join(dir, "no-manual", "notes.md"), "# not a skill\n");
  await fs.mkdir(path.join(dir, "no-frontmatter"), { recursive: true });
  await fs.writeFile(path.join(dir, "no-frontmatter", "SKILL.md"), "# straight to the body\n");
  await writeSkill(dir, "no-description", { description: "" });
  await writeSkill(dir, "Bad_Name", { name: "Bad_Name" });

  const { snapshot, errors } = await buildSkillsSnapshot({ root });
  assert.equal(snapshot.skills.length, 0);
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => /no SKILL\.md/.test(e)));
  assert.ok(errors.some((e) => /no YAML frontmatter/.test(e)));
  assert.ok(errors.some((e) => /'description' is required/.test(e)));
  assert.ok(errors.some((e) => /lowercase letters, digits and single hyphens/.test(e)));
});

test("a nested skill is published independently and as parent supporting content", async () => {
  const root = await tmp("nested");
  const dir = path.join(root, ".claude", "skills");
  const parent = await writeSkill(dir, "parent", {});
  await writeSkill(parent, "child", {});

  const { snapshot, errors } = await buildSkillsSnapshot({ root, strict: true });
  assert.deepEqual(errors, []);

  const uris = snapshot.skills.map((s) => s.uri);
  assert.deepEqual(uris, ["skill://parent/SKILL.md", "skill://parent/child/SKILL.md"].sort());

  const parentEntry = snapshot.skills.find((s) => s.uri === "skill://parent/SKILL.md");
  assert.ok(
    parentEntry.resources.some((r) => r.uri === "skill://parent/child/SKILL.md"),
    "the child's files are listed as supporting content of the parent",
  );
  // Contents are stored once even though two manifests reference them.
  assert.equal(new Set(snapshot.resources.map((r) => r.uri)).size, snapshot.resources.length);
});

test("binary files travel as base64 blobs, text as utf-8", async () => {
  const root = await tmp("binary");
  const dir = path.join(root, ".claude", "skills");
  const skill = await writeSkill(dir, "assets");
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fs.writeFile(path.join(skill, "logo.png"), png);
  await fs.writeFile(path.join(skill, "data.json"), '{"a":1}\n');

  const { snapshot } = await buildSkillsSnapshot({ root, strict: true });
  const byUri = Object.fromEntries(snapshot.resources.map((r) => [r.uri, r]));

  const image = byUri["skill://assets/logo.png"];
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.text, undefined);
  assert.equal(image.blob, png.toString("base64"));
  assert.equal(image.digest, `sha256:${createHash("sha256").update(png).digest("hex")}`);

  const json = byUri["skill://assets/data.json"];
  assert.equal(json.mimeType, "application/json");
  assert.equal(json.text, '{"a":1}\n');
  assert.equal(json.blob, undefined);
});

test("a missing skill directory warns in lenient mode and fails in strict mode", async () => {
  const root = await tmp("absent");

  const lenient = await buildSkillsSnapshot({ root });
  assert.deepEqual(lenient.snapshot.skills, []);
  assert.equal(lenient.errors.length, 0);
  assert.match(lenient.warnings[0], /directory not found/);

  await assert.rejects(() => buildSkillsSnapshot({ root, strict: true }), /directory not found/);
});

test("hidden and ignored files never enter the catalog", async () => {
  const root = await tmp("ignored");
  const dir = path.join(root, ".claude", "skills");
  const skill = await writeSkill(dir, "tidy");
  await fs.writeFile(path.join(skill, ".DS_Store"), "junk");
  await fs.mkdir(path.join(skill, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(skill, "node_modules", "dep.md"), "# dep\n");

  const { snapshot } = await buildSkillsSnapshot({ root, strict: true });
  assert.deepEqual(
    snapshot.resources.map((r) => r.uri),
    ["skill://tidy/SKILL.md"],
  );
  assert.deepEqual(snapshot.directories.map((d) => d.uri), ["skill://tidy"]);
});
