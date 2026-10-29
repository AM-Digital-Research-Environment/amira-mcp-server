// The 1.31 contract changes carried over from the IWAC server: what tools/list
// advertises, where structured content travels, what the skill lists, output
// scrubbing, and the release scripts that keep published versions immutable.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, REPO_ROOT } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));
const conn = await connectInMemory(lib, { openai: true }, { name: "contract" });
test.after(() => conn.close());

test("tools/list carries no zod safe-integer bounds", async () => {
  const { tools } = await conn.client.listTools();
  const json = JSON.stringify(tools);
  assert.equal(json.includes(String(Number.MAX_SAFE_INTEGER)), false);
  assert.equal(json.includes(String(Number.MIN_SAFE_INTEGER)), false);
});

test("structured content travels only for an output schema or an app", async () => {
  const { tools } = await conn.client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  // No output schema, no app: text only.
  assert.equal(byName.search_projects.outputSchema, undefined);
  assert.equal(byName.search_projects._meta?.ui, undefined);
  const plain = await conn.raw("search_projects", { limit: 2 });
  assert.equal(plain.structuredContent, undefined);
  assert.ok(JSON.parse(plain.content[0].text).results);
  // An output schema: structured content mirrors the text.
  const overview = await conn.raw("get_collection_overview");
  assert.deepEqual(overview.structuredContent, JSON.parse(overview.content[0].text));
});

test("resources/list names every skill file with a title and summary", async () => {
  const { resources } = await conn.client.listResources();
  const skill = resources.filter((r) => r.uri.startsWith("skill://amira-mcp/"));
  assert.ok(skill.some((r) => r.uri === "skill://amira-mcp/SKILL.md"));
  const references = skill.filter((r) => r.uri.startsWith("skill://amira-mcp/references/"));
  assert.ok(references.length >= 3, "the references are visible to hosts without the Skills extension");
  for (const ref of references) {
    assert.ok(ref.title && ref.title !== ref.name, `${ref.uri} has a heading title`);
    assert.match(ref.description, /^amira-mcp reference: /);
  }
  const read = await conn.client.readResource({ uri: references[0].uri });
  assert.equal(read.contents[0].mimeType, "text/markdown");
});

test("the instructions point at the skill only while it is served", async () => {
  assert.ok(lib.INSTRUCTIONS.includes("skill://amira-mcp/SKILL.md"));
  assert.ok(lib.INSTRUCTIONS.length <= 2048);
  process.env.AMIRA_SKILLS = "0";
  const off = await connectInMemory(lib, {}, { name: "contract-skills-off" });
  try {
    assert.equal(off.client.getInstructions().includes("skill://"), false);
  } finally {
    delete process.env.AMIRA_SKILLS;
    await off.close();
  }
});

test("describeMarkdown takes the first heading and the first prose line", () => {
  assert.deepEqual(lib.describeMarkdown("---\nname: x\n---\n# Data model\n\n- a list\nEvery entity is an item.\n"), {
    title: "Data model",
    summary: "Every entity is an item.",
  });
  assert.deepEqual(lib.describeMarkdown("no heading at all"), { summary: "no heading at all" });
});

test("scrub removes control and private-use characters, keeping tabs and newlines", () => {
  const dirty = { title: "a\u0000b\u0007cd", nested: ["x\u001Fy", { url: "https://e.org/item" }], text: "l1\nl2\tz", n: 3 };
  assert.deepEqual(lib.scrub(dirty), { title: "abcd", nested: ["xy", { url: "https://e.org/item" }], text: "l1\nl2\tz", n: 3 });
});

test("the release guard lets only a definite 404 through", async () => {
  const { assertUnpublished } = await import(new URL("../../scripts/release-guard.mjs", import.meta.url).href);
  const answer = (status) => async () => ({ status, ok: status >= 200 && status < 300 });
  const base = { tag: "v9.9.9", repository: "a/b", version: "9.9.9", manifestVersion: "9.9.9", sleep: async () => {} };
  await assertUnpublished({ ...base, fetchImpl: answer(404) });
  await assert.rejects(assertUnpublished({ ...base, fetchImpl: answer(200) }), /already exists/);
  await assert.rejects(assertUnpublished({ ...base, fetchImpl: answer(503), attempts: 2, retryDelayMs: 1 }), /HTTP 503, 2 attempts/);
  await assert.rejects(assertUnpublished({ ...base, fetchImpl: answer(403) }), /HTTP 403, 1 attempt\)/);
  await assert.rejects(assertUnpublished({ ...base, tag: "v9.9.8", fetchImpl: answer(404) }), /must match/);
});

test("release notes are the version's CHANGELOG section", () => {
  const script = fileURLToPath(new URL("../../scripts/release-notes.mjs", import.meta.url));
  const notes = execFileSync(process.execPath, [script, "1.30.0"], { cwd: REPO_ROOT, encoding: "utf8" });
  assert.match(notes, /collaborator/);
  assert.equal(notes.includes("## 1.29.0"), false, "stops at the next section");
  assert.throws(() => execFileSync(process.execPath, [script, "0.0.1"], { cwd: REPO_ROOT, stdio: "pipe" }));
});
