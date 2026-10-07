// Explicit output-schema validation. The SDK client checks structuredContent
// only after it has run tools/list on the SAME connection, so suites that call
// tools without listing first never validated anything (review 2026-10-06,
// "Testing and CI"). Here ajv (JSON Schema 2020-12, the dialect tools/list
// declares) validates every tool that declares an outputSchema, against
// representative arguments, at all four exposure levels, and checks that every
// error result carries no structuredContent at all.
//
// The tool list is read from tools/list, so a new schema is picked up
// automatically — and the suite fails until it has representative arguments.
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir, cacheDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
await lib.writeSnapshot(dataDir, fixture);
// Load the fixture before any cache history exists: loadInitial() prefers the
// newer of {bundled, cache}, and the history written below is newer.
await lib.ensureStore();

// Two connections on purpose: `lister` runs tools/list, `caller` never does, so
// the SDK's own (implicit) validation cannot mask or pre-empt ajv's.
const lister = await connectInMemory(lib, { openai: true }, { name: "schema-lister" });
const caller = await connectInMemory(lib, { openai: true }, { name: "schema-caller" });
test.after(async () => {
  delete process.env.AMIRA_EXPOSURE;
  await Promise.all([lister.close(), caller.close()]);
});

const LEVELS = ["minimal", "descriptive", "structured", "full"];

/** Representative arguments per tool. A function receives `call` (parsed body
 * at the CURRENT exposure level) to derive arguments from a previous result. */
const CASES = {
  get_collection_overview: [{}],
  list_years: [{}, { bucket: "decade", sort: "count" }, { from: 1960, to: 1965, limit: 2 }, { limit: 9999 },
    { filters: { keyword: "Yoruba" } }, { filters: { subject: "Islam" } }],
  list_publication_facets: [{ facet: "type" }, { facet: "subject" }, { facet: "author", limit: 1 }, { facet: "venue", limit: 500 },
    { facet: "year", has_fulltext: true }, { facet: "language", language: "French" }],
  resolve_entity: [{ query: "Beier" }, { query: "person:100" }, { query: "Lagos", type: "location", limit: 100 }, { query: "no-such-entity-qq" }],
  get_entity_graph: [
    { seed: "person:100" },
    { seed: "item:500", max_nodes: 2, max_edges: 1 },
    async (call) => {
      const graph = await call("get_entity_graph", { seed: "person:100" });
      const edge = graph.edges?.[0];
      return edge ? { seed: graph.seed, edge_id: edge.id, snapshot_id: graph.snapshot_id, limit: 100 } : { seed: "person:100" };
    },
  ],
  get_text_passages: [{ ids: ["pub:510"], keyword: "zanzibar-fulltext-token", limit: 2 },
    { ids: ["video:540", "podcast:530", "item:500"], keyword: "token", limit: 100 }],
  compare_collections: [
    { cohorts: [{ type: "project", id: "300" }, { type: "project", id: "project:301" }] },
    { cohorts: [{ type: "collection", id: "800" }, { type: "project", id: "300" }], filters: { keyword: "Yoruba" } },
  ],
  get_data_quality: [{}],
  get_snapshot_changes: [{}, { corpus: "persons", limit: 1 }, { limit: 500 }],
  search: [{ query: "fixture" }, { query: "architecture", types: ["item", "publication"], limit: 100 }, { query: "qqq-nothing" }],
  fetch: [
    { id: "item:500" }, { id: "research_item:502" }, { id: "pub:510", include_fulltext: true, fulltext_max_chars: 100 },
    { id: "publication:511" }, { id: "video:540", include_transcript: true, max_chars: 700 }, { id: "video:541" },
    { id: "podcast:530", include_transcript: true }, { id: "project:300" }, { id: "section:400" }, { id: "pub:999999" },
  ],
};

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const { tools } = await lister.client.listTools();
const withSchema = tools.filter((t) => t.outputSchema);
const validators = new Map(withSchema.map((t) => [t.name, ajv.compile(t.outputSchema)]));
/** tool -> { valid: number, errors: Set<code> } across all levels. */
const seen = new Map(withSchema.map((t) => [t.name, { valid: 0, validAtFull: 0, errors: new Set() }]));

test("every declared outputSchema is draft 2020-12 and has representative arguments here", () => {
  assert.ok(withSchema.length >= 11, `expected the 11 schema-carrying tools, saw ${withSchema.map((t) => t.name)}`);
  for (const tool of withSchema) {
    assert.equal(tool.outputSchema.$schema, "https://json-schema.org/draft/2020-12/schema", tool.name);
    assert.equal(tool.outputSchema.type, "object", tool.name);
    assert.ok(CASES[tool.name], `${tool.name} declares an outputSchema but output-schemas.test.mjs has no CASES entry for it`);
  }
  // A stale entry here (a tool lost its schema or was renamed) is a test bug too.
  for (const name of Object.keys(CASES)) assert.ok(validators.has(name), `CASES.${name} names no schema-carrying tool`);
});

test("the compiled validators are not vacuous", () => {
  for (const [name, validate] of validators) {
    // fetch's schema is all-optional (it doubles as the not-found shape); a
    // wrongly typed field must still fail it.
    const bogus = name === "fetch" ? { id: 5, metadata: "x" } : {};
    assert.equal(validate(bogus), false, `${name}: ${JSON.stringify(bogus)} must not validate`);
  }
});

/** Run one call and check it against the contract: valid structuredContent, or
 * a text-only error. Returns the parsed body. */
async function check(name, args, level) {
  const label = `${name}(${JSON.stringify(args)}) @${level}`;
  const result = await caller.raw(name, args);
  const body = JSON.parse(result.content[0].text);
  const stats = seen.get(name);
  if (result.isError) {
    assert.equal(result.structuredContent, undefined, `${label}: error results carry no structuredContent`);
    assert.equal(typeof body.error?.code, "string", `${label}: error text is {error:{code,message}}`);
    assert.equal(typeof body.error?.message, "string", label);
    stats.errors.add(body.error.code);
    return body;
  }
  assert.ok(result.structuredContent, `${label}: a success carries structuredContent`);
  assert.deepEqual(result.structuredContent, body, `${label}: text and structured content agree`);
  const validate = validators.get(name);
  assert.ok(validate(result.structuredContent), `${label}: ${ajv.errorsText(validate.errors)}`);
  stats.valid++;
  if (level === "full") stats.validAtFull++;
  return body;
}

for (const level of LEVELS) {
  test(`structuredContent validates against outputSchema at exposure=${level}`, async () => {
    if (level === "full") delete process.env.AMIRA_EXPOSURE;
    else process.env.AMIRA_EXPOSURE = level;
    try {
      const call = async (name, args) => JSON.parse((await caller.raw(name, args)).content[0].text);
      for (const tool of withSchema) {
        for (const spec of CASES[tool.name] ?? []) {
          const args = typeof spec === "function" ? await spec(call) : spec;
          await check(tool.name, args, level);
        }
      }
    } finally {
      delete process.env.AMIRA_EXPOSURE;
    }
  });
}

test("restricted levels refuse with exposure_restricted, never with a schema-breaking body", () => {
  // Under minimal, every structured-level tool must have refused at least once
  // (the refusal path is exactly what used to emit schema-invalid structured errors).
  for (const name of ["resolve_entity", "get_entity_graph", "compare_collections", "get_data_quality",
    "get_snapshot_changes", "list_publication_facets", "get_text_passages"]) {
    assert.ok(seen.get(name).errors.has("exposure_restricted"), `${name}: ${[...seen.get(name).errors]}`);
  }
  assert.ok(seen.get("fetch").errors.has("not_found"), "fetch of an unknown id is an error result");
});

test("every schema-carrying tool produced at least one valid structured result at full exposure", () => {
  const missing = [...seen].filter(([, s]) => s.validAtFull === 0).map(([name]) => name);
  assert.deepEqual(missing, [], "tools whose success path was never validated");
});

test("get_snapshot_changes 'ready' pages validate once history is retained", async () => {
  const before = structuredClone(fixture), after = structuredClone(fixture);
  before.manifest.fetchedAt = "2026-10-01T00:00:00Z";
  after.manifest.fetchedAt = "2026-10-02T00:00:00Z";
  after.data.persons[0].name = "Updated label";
  after.data.persons.splice(1, 1);
  after.manifest.counts.persons = after.data.persons.length;
  const cache = lib.snapshotCacheDir(cacheDir, fixture.manifest.apiBase);
  await lib.writeSnapshotAtomic(cache, before);
  await lib.writeSnapshotAtomic(cache, after);
  for (const args of [{}, { corpus: "persons", limit: 1 }, { corpus: "persons", offset: 1 }, { limit: 500 }]) {
    const body = await check("get_snapshot_changes", args, "full");
    assert.equal(body.status, "ready", JSON.stringify(body));
    if (args.limit === 500) assert.deepEqual([body.requested_limit, body.effective_limit], [500, 100], "limit clamped and echoed");
  }
  const unknown = await check("get_snapshot_changes", { from_id: "nope", to_id: "nope" }, "full");
  assert.equal(unknown.error.code, "snapshot_unavailable");
});

test("error results across the schema-less tools carry no structuredContent either", async () => {
  // The policy wrapper strips structuredContent from EVERY isError result, not
  // only from tools with an outputSchema. One refusal per error family.
  const cases = [
    ["get_research_item", { id: 999999 }, "not_found"],
    ["get_project", { id: "   " }, "invalid_argument"],
    ["get_institution", {}, "missing_entity"],
    ["list_cluster_partners", { category: "nope" }, "invalid_category"],
    ["search_videos", { year_from: 2020, year_to: 1900 }, "invalid_range"],
    ["get_person", { id: "person:abc" }, "invalid_id"],
  ];
  for (const [name, args, code] of cases) {
    const result = await caller.raw(name, args);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent, undefined, name);
    assert.equal(JSON.parse(result.content[0].text).error.code, code, name);
  }
  process.env.AMIRA_EXPOSURE = "structured";
  try {
    const result = await caller.raw("get_video", { id: 540, include_transcript: true });
    assert.equal(result.structuredContent, undefined);
    assert.equal(JSON.parse(result.content[0].text).error.code, "text_access_disabled");
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});
