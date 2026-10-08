// AMIRA_GUIDANCE: the curatorial-guidance switch behind the evaluation's M−
// condition (src/guidance.ts). Two contracts are pinned here:
//
//   1. the default is the normal server: unset and `on` build the same surface
//      and return the same results, with every channel of guidance intact;
//   2. `off` keeps the operations (names, schemas, handlers, data) and drops the
//      text: instructions, titles, descriptions, advice in errors and results,
//      prompts and the skill.
//
// The variable is read when a server is built and on each call, so every
// off-mode block sets it before connecting and clears it in `finally`.
import test from "node:test";
import assert from "node:assert/strict";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir: fixtureDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(fixtureDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

/** Everything a client can list, from a fresh in-process server. */
async function surface(opts = { openai: true }) {
  const conn = await connectInMemory(lib, opts, { name: "guidance" });
  const { client } = conn;
  const caps = client.getServerCapabilities();
  const out = {
    instructions: client.getInstructions(),
    capabilities: caps,
    tools: (await client.listTools()).tools,
    prompts: caps.prompts ? (await client.listPrompts()).prompts : null,
    resources: (await client.listResources()).resources,
    templates: (await client.listResourceTemplates()).resourceTemplates,
  };
  return { out, conn };
}

/** Run `fn` with AMIRA_GUIDANCE set, restoring the default afterwards. */
async function withGuidance(value, fn) {
  process.env.AMIRA_GUIDANCE = value;
  try {
    return await fn();
  } finally {
    delete process.env.AMIRA_GUIDANCE;
  }
}

const errorOf = (body) => {
  assert.ok(body.isError, `expected an error, got ${JSON.stringify(body).slice(0, 200)}`);
  return body.error;
};

/** Calls whose bodies must not depend on the switch (matches, data, plain errors). */
const SAME_EITHER_WAY = [
  ["get_collection_overview", {}],
  ["search_persons", { keyword: "Ulli Beier" }],
  ["search_persons", {}],
  ["resolve_entity", { query: "Beier, Ulli", type: "person" }],
  ["search_research_items", { keyword: "Cote d'Ivoire" }],
  ["get_person", { id: 100 }],
  ["get_publication", { id: 510, include_fulltext: true }],
  ["get_entity_graph", { seed: "person:100" }],
  ["list_subjects", {}],
  ["search", { query: "architecture" }],
  ["get_research_item", { id: 999999999 }],
];

// --- the default is the normal server ---------------------------------------------

test("guidance: unset and `on` build the same surface, with all guidance present", async () => {
  const unset = await surface();
  const on = await withGuidance("on", () => surface());
  try {
    assert.deepEqual(on.out, unset.out);
    const s = unset.out;
    assert.equal(s.instructions, lib.INSTRUCTIONS);
    assert.ok(s.capabilities.prompts && s.capabilities.extensions, "prompts and the skill extension are declared");
    assert.equal(s.prompts.length, 5);
    assert.ok(s.resources.some((r) => r.uri.startsWith("skill://")), "skill files are served");
    for (const tool of s.tools) {
      assert.ok(tool.title && tool.description, tool.name);
    }
    const persons = s.tools.find((t) => t.name === "search_persons");
    assert.equal(persons.inputSchema.properties.keyword.description, "Matches the name, a name variant or an affiliation");
    assert.deepEqual(s.tools.filter((t) => t._meta?.["anthropic/alwaysLoad"]).map((t) => t.name).sort(),
      ["get_collection_overview", "resolve_entity"]);
    assert.ok(s.templates.every((t) => t.title && t.description));
  } finally {
    await unset.conn.close();
    await on.conn.close();
  }
});

test("guidance: unset and `on` return the same results; advice stays in errors and hints", async () => {
  const unset = await connectInMemory(lib, { openai: true }, { name: "default" });
  try {
    const on = await withGuidance("on", async () => {
      const conn = await connectInMemory(lib, { openai: true }, { name: "on" });
      try {
        const bodies = [];
        for (const [tool, args] of SAME_EITHER_WAY) bodies.push(await conn.call(tool, args));
        return bodies;
      } finally {
        await conn.close();
      }
    });
    for (const [i, [tool, args]] of SAME_EITHER_WAY.entries()) {
      assert.deepEqual(on[i], await unset.call(tool, args), `${tool} ${JSON.stringify(args)}`);
    }
    // The advisory channels, verbatim as v1.20.0 wrote them.
    assert.deepEqual(errorOf(await unset.call("get_entity_graph", { seed: "person:999" })), {
      code: "not_found", message: "Use a typed id returned by resolve_entity (e.g. person:123, research_item:7392).", suggested_tool: "resolve_entity",
    });
    const fragment = errorOf(await unset.call("get_person", { name: "Bei" }));
    assert.equal(fragment.message, "No person named 'Bei'. Names must be complete; use resolve_entity or search_persons for partial names.");
    assert.deepEqual([fragment.suggested_tool, fragment.available_values], ["resolve_entity", ["Beier, Ulli (person:100)"]]);
    const pub = await unset.call("get_publication", { id: 510 });
    assert.match(pub.fulltext_hint, /^Set include_fulltext=true/);
    const doc = await unset.call("fetch", { id: "pub:510" });
    assert.match(doc.text, /call fetch again with include_fulltext=true/);
    const exported = await unset.call("search_publications", { export: "csv" });
    assert.match(exported.note, /^Read the resource/);
    process.env.AMIRA_EXPOSURE = "minimal";
    try {
      assert.equal(errorOf(await unset.call("search_persons", {})).message,
        "search_persons is not available: The server is running with AMIRA_EXPOSURE=minimal, which hides this metadata " +
        "(requires the 'structured' level). Answer from the metadata that remains exposed, or state that the available " +
        "tools do not expose what the question needs.");
    } finally {
      delete process.env.AMIRA_EXPOSURE;
    }
  } finally {
    await unset.close();
  }
});

test("guidance: only `off` turns it off; an unknown value keeps it on", async () => {
  for (const [value, enabled] of [[undefined, true], ["on", true], ["ON", true], [" off ", false], ["OFF", false], ["0", true], ["maybe", true]]) {
    if (value === undefined) delete process.env.AMIRA_GUIDANCE;
    else process.env.AMIRA_GUIDANCE = value;
    try {
      assert.equal(lib.guidanceEnabled(), enabled, String(value));
    } finally {
      delete process.env.AMIRA_GUIDANCE;
    }
  }
});

// --- off: same operations, no curatorial text --------------------------------------

test("guidance off: no instructions, prompts or skill; tools keep names and schemas but lose their text", async () => {
  const on = await surface();
  const off = await withGuidance("off", () => surface());
  try {
    const s = off.out;
    assert.equal(s.instructions, undefined);
    assert.equal(s.capabilities.prompts, undefined);
    assert.equal(s.capabilities.extensions, undefined);
    assert.equal(s.prompts, null);
    assert.ok(!s.resources.some((r) => r.uri.startsWith("skill://")), "no skill files");
    // The same operations, in the same order...
    assert.deepEqual(s.tools.map((t) => t.name), on.out.tools.map((t) => t.name));
    for (const [i, tool] of s.tools.entries()) {
      const full = on.out.tools[i];
      assert.equal(tool.title, undefined, tool.name);
      assert.equal(tool.description, undefined, tool.name);
      assert.equal(tool._meta?.["anthropic/alwaysLoad"], undefined, tool.name);
      // ...with the same schemas once their text is removed: types, enums,
      // bounds and required fields all survive.
      assert.deepEqual(tool.inputSchema, lib.stripSchemaText(full.inputSchema), `${tool.name} input`);
      assert.deepEqual(tool.outputSchema, full.outputSchema && lib.stripSchemaText(full.outputSchema), `${tool.name} output`);
      assert.deepEqual(tool.annotations, full.annotations, tool.name);
      assert.doesNotMatch(JSON.stringify(tool), /"description":"/, tool.name);
    }
    const graph = s.tools.find((t) => t.name === "get_entity_graph");
    assert.deepEqual(graph._meta.ui, on.out.tools.find((t) => t.name === "get_entity_graph")._meta.ui, "apps still render");
    const resolve = s.tools.find((t) => t.name === "resolve_entity");
    assert.deepEqual(resolve.inputSchema.required, ["query"]);
    assert.ok(resolve.inputSchema.properties.type.enum.includes("person"));
    // Resources keep their URIs and types, without titles or descriptions.
    assert.deepEqual(s.resources.map((r) => r.uri), on.out.resources.map((r) => r.uri).filter((u) => !u.startsWith("skill://")));
    assert.ok([...s.resources, ...s.templates].every((r) => r.title === undefined && r.description === undefined));
  } finally {
    await on.conn.close();
    await off.conn.close();
  }
});

test("guidance off: calls behave the same; errors keep their code with a terse message", async () => {
  const on = await connectInMemory(lib, { openai: true }, { name: "on" });
  try {
    await withGuidance("off", async () => {
      const off = await connectInMemory(lib, { openai: true }, { name: "off" });
      try {
        // Data is untouched: the same body for every call that has no advice in it.
        for (const [tool, args] of SAME_EITHER_WAY.filter(([t, a]) => !(t === "get_publication" && !a.include_fulltext))) {
          assert.deepEqual(await off.call(tool, args), await on.call(tool, args), `${tool} ${JSON.stringify(args)}`);
        }
        // Errors: the code and what was wrong, nothing about what to do next.
        assert.deepEqual(errorOf(await off.call("get_entity_graph", { seed: "person:999" })),
          { code: "not_found", message: "Unknown seed; expected a typed id such as person:123 or research_item:7392." });
        assert.deepEqual(errorOf(await off.call("get_person", { name: "Bei" })),
          { code: "not_found", message: "No person named 'Bei'. Names must be complete." });
        assert.deepEqual(errorOf(await off.call("get_person", { id: 999999 })), { code: "not_found", message: "Unknown person id." });
        assert.deepEqual(errorOf(await off.call("list_cluster_partners", { category: "nonsense" })),
          { code: "invalid_category", message: "Unknown partner category 'nonsense'." });
        assert.deepEqual(errorOf(await off.call("get_entity_graph", { seed: "person:100", edge_id: "x", snapshot_id: "stale" })),
          { code: "snapshot_changed", message: "The snapshot changed." });
        assert.deepEqual(errorOf(await off.call("fetch", { id: "item:999999999" })), { code: "not_found", message: "No record with id 'item:999999999'." });
        // Messages that only say what was wrong are the same in both modes.
        assert.deepEqual(errorOf(await off.call("get_person", {})), errorOf(await on.call("get_person", {})));
        // Results: no paging hints, no export note.
        const pub = await off.call("get_publication", { id: 510 });
        const { fulltext_hint: _hint, ...rest } = await on.call("get_publication", { id: 510 });
        assert.deepEqual(pub, rest);
        const doc = await off.call("fetch", { id: "pub:510" });
        assert.match(doc.text, /\[Full text omitted \(\d+ chars\)\.\]$/);
        assert.equal(doc.metadata.fulltext_hint, undefined);
        const exported = await off.call("search_publications", { export: "csv" });
        assert.equal(exported.note, undefined);
        assert.ok(exported.export.uri.startsWith("amira://export/publications/csv/"));
        // Exposure refusals keep the reason, drop the advice on how to answer.
        process.env.AMIRA_EXPOSURE = "minimal";
        try {
          assert.deepEqual(errorOf(await off.call("search_persons", {})), {
            code: "exposure_restricted",
            message: "search_persons is not available: The server is running with AMIRA_EXPOSURE=minimal, which hides this " +
              "metadata (requires the 'structured' level).",
          });
          assert.equal(errorOf(await off.call("get_publication", { id: 510, include_fulltext: true })).code, "text_access_disabled");
        } finally {
          delete process.env.AMIRA_EXPOSURE;
        }
      } finally {
        await off.close();
      }
    });
  } finally {
    await on.close();
  }
});

test("stripSchemaText removes text keywords at every depth and keeps properties that share their names", () => {
  const schema = {
    type: "object", title: "T", description: "D", examples: [{}],
    properties: {
      description: { type: "string", description: "a property called description" },
      title: { type: "string", title: "a property called title" },
      list: { type: "array", items: { type: "string", description: "item" } },
      either: { anyOf: [{ type: "string", description: "s" }, { type: "null" }] },
      ref: { $ref: "#/$defs/x" },
    },
    $defs: { x: { type: "number", description: "x" } },
    required: ["description", "title"],
    additionalProperties: false,
  };
  assert.deepEqual(lib.stripSchemaText(schema), {
    type: "object",
    properties: {
      description: { type: "string" },
      title: { type: "string" },
      list: { type: "array", items: { type: "string" } },
      either: { anyOf: [{ type: "string" }, { type: "null" }] },
      ref: { $ref: "#/$defs/x" },
    },
    $defs: { x: { type: "number" } },
    required: ["description", "title"],
    additionalProperties: false,
  });
});
