// Skills over MCP (SEP-2640): the build-time snapshot (scripts/skills.mjs) and
// the catalog the SDK's Skills extension serves from it, read back the way a
// host reads it — through the client SDK's SkillsClient, which re-hashes every
// file against its listed digest and size and checks SKILL.md's frontmatter
// against the entry.
//
// Three things are worth testing here and nowhere else. First the DIGEST
// CONTRACT: a host that reads a skill file re-hashes it and compares against
// the listed digest, and treats any mismatch as tampering — so a digest
// computed over anything other than the raw committed bytes silently makes
// every skill unusable, with no error on our side. Second the LENIENT/STRICT
// SPLIT: a broken skill must be dropped from a dev build and must fail a
// release build, and getting those backwards either ships a bad catalog or
// blocks local work on an unrelated typo. Third the SERVED SURFACE: the SDK's
// `attach` is @experimental, so the URIs, digests and directory listings a
// host sees are pinned here rather than trusted across an SDK upgrade.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { SkillsClient } from "@modelcontextprotocol/client/ext/skills";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension, memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { z } from "zod";
import { buildSkillsSnapshot, skillFiles } from "../../scripts/skills.mjs";
import { hermeticEnv, REPO_ROOT as REPO, tempDir } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

hermeticEnv();
const lib = await import("../../server/lib.js");

/** Write a minimal valid skill; `frontmatter` overrides the defaults. */
async function writeSkill(root, dirName, { name = dirName, description = "A test skill.", extra = {} } = {}) {
  const dir = path.join(root, dirName);
  await fs.mkdir(dir, { recursive: true });
  const lines = [`name: ${name}`, `description: ${description}`, ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)];
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\n${lines.join("\n")}\n---\n\n# ${name}\n\nBody.\n`);
  return dir;
}

// Registered temp dirs: removed when this file's process exits.
const tmp = async (label) => tempDir(`skills-${label}`);

/** A SkillsClient over a linked in-process pair, against `server`. */
async function skillsClientFor(server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "skills-unit", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, skills: new SkillsClient(client), close: () => Promise.all([client.close(), server.close()]) };
}

/** Serve a build snapshot on a bare server, the way src/skills.ts serves the embedded one. */
async function serveSnapshot(snapshot) {
  const catalog = await SkillsExtension.load(memorySkillFiles(skillFiles(snapshot)), { strict: true });
  const server = new McpServer({ name: "skills-fixture", version: "0.0.0" });
  catalog.attach(server);
  return skillsClientFor(server);
}

test("the server serves the companion skill: URIs, manifest and directory levels", async () => {
  const conn = await connectInMemory(lib, {}, { name: "skills-unit" });
  const skills = new SkillsClient(conn.client);
  try {
    assert.equal(skills.supported, true);
    assert.equal(skills.directoryRead, true);

    const { skills: entries, invalid } = await skills.list();
    assert.deepEqual(invalid, []);
    assert.equal(entries.length, 1);
    const [skill] = entries;
    assert.equal(skill.uri, "skill://amira-mcp/SKILL.md");
    assert.equal(skill.frontmatter.name, "amira-mcp");
    assert.ok(skill.frontmatter.description.length > 0);
    assert.deepEqual((await skills.get(skill.uri)).skill, skill);

    // Complete manifest: every committed file exactly once, SKILL.md included.
    const committed = (await fs.readdir(path.join(REPO, ".claude", "skills", "amira-mcp"), { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(path.join(REPO, ".claude", "skills", "amira-mcp"), path.join(entry.parentPath, entry.name)))
      .map((rel) => `skill://amira-mcp/${rel.split(path.sep).join("/")}`)
      .sort();
    assert.deepEqual(skill.resources.map((r) => r.uri), committed);

    // One level at a time, never recursive.
    const root = await skills.readDirectory("skill://amira-mcp");
    assert.deepEqual(
      root.resources.map((r) => `${r.uri} ${r.mimeType}`),
      ["skill://amira-mcp/SKILL.md text/markdown", "skill://amira-mcp/references inode/directory"],
    );
    const references = await skills.readDirectory("skill://amira-mcp/references");
    assert.deepEqual(
      references.resources.map((r) => r.uri),
      committed.filter((uri) => uri.startsWith("skill://amira-mcp/references/")),
    );
  } finally {
    await conn.close();
  }
});

test("digests are sha256 over the raw committed bytes, and every file verifies on read", async () => {
  const conn = await connectInMemory(lib, {}, { name: "skills-unit" });
  const skills = new SkillsClient(conn.client);
  try {
    const [skill] = (await skills.list()).skills;
    for (const resource of skill.resources) {
      assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);
      const rel = resource.uri.replace("skill://amira-mcp/", "");
      const bytes = await fs.readFile(path.join(REPO, ".claude", "skills", "amira-mcp", rel));
      assert.equal(resource.digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`, rel);
      assert.equal(resource.size, bytes.length, rel);

      // What a host re-hashes is the payload served; SkillsClient throws on a mismatch.
      const file = await skills.read(skill, rel);
      assert.equal(file.verified, true, rel);
      assert.deepEqual(Buffer.from(file.bytes), bytes, rel);
    }
    const manual = await skills.read(skill);
    assert.deepEqual(manual.frontmatter, skill.frontmatter);
    assert.match(manual.body, /amira_url/);
  } finally {
    await conn.close();
  }
});

test("AMIRA_SKILLS=0 withdraws the capability, the methods and the files", async () => {
  process.env.AMIRA_SKILLS = "0";
  let conn;
  try {
    conn = await connectInMemory(lib, {}, { name: "skills-off" });
  } finally {
    delete process.env.AMIRA_SKILLS;
  }
  try {
    assert.equal(new SkillsClient(conn.client).supported, false);
    assert.equal(conn.client.getServerCapabilities().extensions, undefined);
    await assert.rejects(conn.client.request({ method: "skills/list", params: {} }, z.looseObject({})), (err) => err.code === -32601);
    const { resources } = await conn.client.listResources();
    const { resourceTemplates } = await conn.client.listResourceTemplates();
    assert.ok(!resources.some((r) => r.uri.startsWith("skill://")));
    assert.ok(!resourceTemplates.some((t) => t.uriTemplate.startsWith("skill://")));
  } finally {
    await conn.close();
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
  assert.deepEqual(lenient.skills.map((s) => s.frontmatter.name), ["good-skill"]);
  assert.equal(lenient.errors.length, 1);
  assert.match(lenient.errors[0], /must match the last path segment/);
  // The dropped skill's files stay out of the bundle.
  assert.deepEqual(Object.keys(lenient.snapshot.text), ["good-skill/SKILL.md"]);

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

  const { snapshot, skills, errors } = await buildSkillsSnapshot({ root });
  assert.equal(skills.length, 0);
  assert.deepEqual(snapshot, { text: {}, base64: {} });
  assert.equal(errors.length, 4, errors.join("\n"));
  assert.ok(errors.some((e) => /^no-manual: no SKILL\.md/.test(e)));
  assert.ok(errors.some((e) => /^no-frontmatter\/SKILL\.md: .*must begin with a "---" line/.test(e)));
  assert.ok(errors.some((e) => /^no-description\/SKILL\.md: .*"description"/.test(e)));
  assert.ok(errors.some((e) => /^Bad_Name\/SKILL\.md: .*lowercase letters, digits and single hyphens/.test(e)));
});

test("a nested skill is published independently and as parent supporting content", async () => {
  const root = await tmp("nested");
  const dir = path.join(root, ".claude", "skills");
  const parent = await writeSkill(dir, "parent", {});
  await writeSkill(parent, "child", {});

  const { snapshot, errors } = await buildSkillsSnapshot({ root, strict: true });
  assert.deepEqual(errors, []);

  const served = await serveSnapshot(snapshot);
  try {
    const { skills } = await served.skills.list();
    assert.deepEqual(skills.map((s) => s.uri), ["skill://parent/SKILL.md", "skill://parent/child/SKILL.md"]);
    const parentEntry = skills.find((s) => s.uri === "skill://parent/SKILL.md");
    assert.ok(
      parentEntry.resources.some((r) => r.uri === "skill://parent/child/SKILL.md"),
      "the child's files are listed as supporting content of the parent",
    );
    // Both manifests verify the same served file.
    const child = skills.find((s) => s.uri === "skill://parent/child/SKILL.md");
    assert.deepEqual((await served.skills.read(parentEntry, "child/SKILL.md")).bytes, (await served.skills.read(child)).bytes);
  } finally {
    await served.close();
  }
});

test("binary files travel as base64 blobs, text as utf-8", async () => {
  const root = await tmp("binary");
  const dir = path.join(root, ".claude", "skills");
  const skill = await writeSkill(dir, "assets");
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fs.writeFile(path.join(skill, "logo.png"), png);
  await fs.writeFile(path.join(skill, "data.json"), '{"a":1}\n');

  const { snapshot } = await buildSkillsSnapshot({ root, strict: true });
  assert.deepEqual(Object.keys(snapshot.base64), ["assets/logo.png"]);
  assert.equal(snapshot.base64["assets/logo.png"], png.toString("base64"));

  // The runtime decodes the snapshot into the same bytes the build hashed.
  const runtime = await lib.loadSkillCatalog(snapshot);
  const built = await SkillsExtension.load(memorySkillFiles(skillFiles(snapshot)));
  assert.deepEqual(runtime.entries, built.entries);

  const served = await serveSnapshot(snapshot);
  try {
    const [entry] = (await served.skills.list()).skills;
    const image = entry.resources.find((r) => r.uri === "skill://assets/logo.png");
    assert.equal(image.size, png.length);
    assert.equal(image.digest, `sha256:${createHash("sha256").update(png).digest("hex")}`);

    const raw = await served.client.readResource({ uri: "skill://assets/logo.png" });
    assert.equal(raw.contents[0].mimeType, "image/png");
    assert.equal(raw.contents[0].text, undefined);
    assert.equal(raw.contents[0].blob, png.toString("base64"));
    assert.deepEqual(Buffer.from((await served.skills.read(entry, "logo.png")).bytes), png);

    const json = await served.client.readResource({ uri: "skill://assets/data.json" });
    assert.equal(json.contents[0].mimeType, "application/json");
    assert.equal(json.contents[0].text, '{"a":1}\n');
    assert.equal(json.contents[0].blob, undefined);
  } finally {
    await served.close();
  }
});

test("a missing skill directory warns in lenient mode and fails in strict mode", async () => {
  const root = await tmp("absent");

  const lenient = await buildSkillsSnapshot({ root });
  assert.deepEqual(lenient.skills, []);
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

  const { snapshot, skills } = await buildSkillsSnapshot({ root, strict: true });
  assert.deepEqual(Object.keys(snapshot.text), ["tidy/SKILL.md"]);
  assert.deepEqual(skills[0].resources.map((r) => r.uri), ["skill://tidy/SKILL.md"]);
});
