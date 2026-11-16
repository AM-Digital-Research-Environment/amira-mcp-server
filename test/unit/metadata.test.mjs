// Repository metadata that states facts about the code: the tool counts in
// the citation files, the README and the companion skill, and the committed
// server.json, which the release stamps. These drifted silently before (the
// citation files said 27 tools for months while 36 were registered).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv, REPO_ROOT } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");
await lib.writeSnapshot(dataDir, buildFixture(lib.SNAPSHOT_SCHEMA_VERSION));

const read = (name) => readFileSync(path.join(REPO_ROOT, name), "utf8");

/** Tool names a freshly built server registers (stdio, or HTTP with search/fetch). */
async function registered(openai) {
  const conn = await connectInMemory(lib, { openai }, { name: "metadata-unit" });
  try {
    return (await conn.client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await conn.close();
  }
}

const STDIO = (await registered(false)).length;
const HTTP = (await registered(true)).length;
const PROFILE_CORE = Object.fromEntries(Object.entries(lib.TOOL_PROFILES).filter(([, names]) => names)
  .map(([profile, names]) => [profile, names.filter((name) => name !== "search" && name !== "fetch").length]));

/**
 * Every tool count a text states: "36 core tools", "36 typed tools", "the
 * 36-tool catalogue" (the stdio count) and "38 over HTTP", "(38 total)" (the
 * HTTP count). The README's per-profile triple is checked separately.
 */
function statedCounts(text) {
  const prose = text.replace(/\(\d+\/\d+\/\d+ core tools respectively/g, "");
  return {
    stdio: [...prose.matchAll(/\b(\d+)(?:-| )(?:core |typed )?tools?\b/gi)].map((m) => Number(m[1])),
    http: [...prose.matchAll(/\b(\d+) over HTTP\b|\((\d+)\s+total\)/gi)].map((m) => Number(m[1] ?? m[2])),
  };
}

const SOURCES = {
  "CITATION.cff": () => YAML.parse(read("CITATION.cff")).abstract,
  ".zenodo.json": () => JSON.parse(read(".zenodo.json")).description,
  "README.md": () => read("README.md"),
  ".claude/skills/amira-mcp/SKILL.md": () => read(".claude/skills/amira-mcp/SKILL.md"),
  ".claude/skills/amira-mcp/references/tools-by-task.md": () => read(".claude/skills/amira-mcp/references/tools-by-task.md"),
};

test("the registered surface is the manifest's tools, plus search/fetch over HTTP", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(STDIO, manifest.tools.length);
  assert.equal(HTTP, STDIO + 2);
});

for (const [name, text] of Object.entries(SOURCES)) {
  test(`${name} states the registered tool counts (${STDIO} core, ${HTTP} over HTTP)`, () => {
    const { stdio, http } = statedCounts(text());
    assert.ok(stdio.length + http.length > 0, `${name} states no tool count; drop it from this test if that is intended`);
    for (const n of stdio) assert.equal(n, STDIO, `${name} states ${n} tools; ${STDIO} are registered`);
    for (const n of http) assert.equal(n, HTTP, `${name} states ${n} tools over HTTP; ${HTTP} are registered`);
  });
}

test("the README's per-profile counts match TOOL_PROFILES", () => {
  const match = /\((\d+)\/(\d+)\/(\d+) core tools respectively/.exec(read("README.md"));
  assert.ok(match, "README lists the research/discovery/visualization counts");
  assert.deepEqual(match.slice(1).map(Number), [PROFILE_CORE.research, PROFILE_CORE.discovery, PROFILE_CORE.visualization]);
});

test("the stated-count scanner catches drift", () => {
  assert.deepEqual(statedCounts("as 27 typed tools (38 over HTTP), the 36-tool catalogue, (38\ntotal)"),
    { stdio: [27, 36], http: [38, 38] });
  assert.deepEqual(statedCounts("(24/14/14 core tools respectively; seven tools"), { stdio: [], http: [] });
});

// server.json is published to the MCP Registry only by the release workflow,
// which stamps the version, the .mcpb URL and its SHA-256 from the tag. A
// committed copy that looks real (it sat at 1.18.1 for eighteen releases)
// invites a hand publish of stale values, so it stays a visible placeholder.
test("server.json in git is a placeholder that the release stamps", () => {
  const server = JSON.parse(read("server.json"));
  assert.match(server.version, /stamped-by-release/, "version is the release placeholder");
  const mcpb = server.packages.filter((p) => p.registryType === "mcpb");
  assert.equal(mcpb.length, 1);
  assert.match(mcpb[0].identifier, /\/releases\/download\/STAMPED_BY_RELEASE\/amira-mcp-server\.mcpb$/);
  assert.equal(mcpb[0].fileSha256, "0".repeat(64));

  const release = read(".github/workflows/release.yml");
  for (const field of [".version = $v", ".identifier = $url", ".fileSha256 = $sha"]) {
    assert.ok(release.includes(field), `release.yml stamps ${field}`);
  }
  assert.match(release, /stamped-by-release\|STAMPED_BY_RELEASE/, "release.yml refuses a server.json still holding a placeholder");
});
