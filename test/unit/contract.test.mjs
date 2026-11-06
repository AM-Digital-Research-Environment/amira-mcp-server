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

test("scrub keeps letters outside ASCII and strips the Private Use Area", () => {
  // The class once held literal U+E000/U+F8FF characters that no editor shows,
  // so it read like a range from DEL to plane 15: this pins what it really strips.
  assert.equal(lib.scrub("Côte d'Ivoire \uE001· ß \uF8FF"), "Côte d'Ivoire · ß ");
});

test("cachedRecent bounds each namespace on its own", () => {
  const f = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
  const store = new lib.DataStore("bundled", f.data, f.manifest);
  // A namespace with a large bound used to keep a small-bound one's entries
  // alive: one shared map evicted at most one entry per call.
  for (let i = 0; i < 300; i++) {
    store.cachedRecent("wide", String(i), () => i, 256);
    if (i % 3 === 0) store.cachedRecent("narrow", String(i), () => i, 64);
  }
  assert.equal(store.recentSize("wide"), 256);
  assert.equal(store.recentSize("narrow"), 64);
  // Most recently used survives; the oldest went first.
  let built = 0;
  store.cachedRecent("narrow", "297", () => built++, 64);
  store.cachedRecent("narrow", "0", () => built++, 64);
  assert.equal(built, 1, "297 was cached, 0 had been evicted");
});

test("every record kind round-trips: typed id → lookup → kind, and the record resource serves it", async () => {
  const store = await lib.ensureStore();
  for (const [kind, def] of Object.entries(lib.RECORD_KINDS)) {
    const row = def.rows(store)[0];
    if (!row) continue; // the fixture holds no record of this kind
    const parsed = lib.parseTypedId(`${kind}:${row.o_id}`);
    assert.equal(parsed?.kind, kind, `${kind}: its own prefix parses back to it`);
    assert.equal(lib.findRecord(store, kind, String(row.o_id)), row, `${kind}: found by Omeka id`);
    assert.equal(lib.recordByOId(store, row.o_id)?.kind, kind, `${kind}: one id map across kinds`);
    assert.equal(typeof lib.recordTitle(row), "string");
    if (def.detail) {
      const read = await conn.client.readResource({ uri: `amira://record/${kind}/${row.o_id}` });
      assert.match(read.contents[0].text, new RegExp(`/item/${row.o_id}"`), `${kind}: served by ${def.detail.tool}`);
    }
  }
});

// Error codes are a client contract: a model or host branches on them. One
// tool shipped `invalid_arguments` beside everyone else's `invalid_argument`.
// A new code is added here on purpose, never by a typo.
const ERROR_CODES = new Set([
  "ambiguous_entity", "deadline_exceeded", "export_too_large", "exposure_restricted", "fulltext_map_unavailable",
  "invalid_argument", "invalid_category", "invalid_date", "invalid_id", "invalid_range", "missing_entity",
  "no_neighbours", "not_embedded", "not_found", "not_on_fulltext_map", "not_on_map", "semantic_unavailable",
  "snapshot_changed", "snapshot_unavailable", "text_access_disabled",
]);

test("every error code in src/ is on the documented list", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");
  const files = readdirSync(path.join(REPO_ROOT, "src"), { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  const unknown = new Set();
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, "src", String(file)), "utf8");
    for (const m of text.matchAll(/(?:errorResult\(\s*|code: )"([a-z_]+)"/g)) if (!ERROR_CODES.has(m[1])) unknown.add(`${m[1]} (${file})`);
  }
  assert.deepEqual([...unknown], []);
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
