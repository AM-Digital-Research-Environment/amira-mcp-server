// Skills over MCP — the finalized SEP-2640 extension, served by the SDK's
// Skills extension from the embedded snapshot that scripts/skills.mjs builds at
// compile time.
//
// STATUS: official extension; SDK and host support still varies. Follow the
// published contract at modelcontextprotocol.io/extensions/skills/overview.
// The release zip remains available for hosts without extension support.
// AMIRA_SKILLS=0 disables this surface without affecting the research tools.
//
// WHY THIS EXISTS. The companion research skill (.claude/skills/amira-mcp/) is
// the server's operating manual: tool-selection guidance, the citation contract,
// the coverage caveats. Until now it reached users only as a zip they unzipped
// into ~/.claude/skills/ — which leaves the remote Streamable HTTP surface
// (ChatGPT, Claude.ai connectors, the APIs) with no way to get it at all, and
// lets a downloaded copy drift from the tool surface it documents. Served over
// the connection, the skill is pinned to the build that answers the tool calls.
//
// COST TO A HOST THAT IGNORES IT: nothing. Skill text is never injected into
// `instructions` or tool descriptions — hosts discover the catalog, then decide
// what to disclose and when. A host that does not implement the extension never
// calls these methods.
//
// WHAT THE SDK DOES. `SkillsExtension.load` computes every digest and size and
// checks the frontmatter rules; `attach` registers the `skill://{+path}`
// resource template, `skills/list`, `skills/get` and `resources/directory/read`
// (paged), checks every `resources/read` against the published entry, and
// declares the capability. `attach` is @experimental — its wiring may change in
// a minor SDK release — so test/unit/skills.test.mjs and both smoke scripts
// cover the served surface rather than trusting the upgrade.
import type { McpServer } from "@modelcontextprotocol/server";
import { SkillsExtension, memorySkillFiles, type SkillCatalog } from "@modelcontextprotocol/server/ext/skills";

/**
 * Skill files are immutable for the life of a build, so every skill result is
 * shareable across clients for a day — the same reasoning as the
 * `resources/read` entry in mcpServer.ts CACHE_HINTS. The SDK sends it on
 * 2026-07-28 connections only, where the fields exist.
 */
const SKILLS_CACHE_HINT = { ttlMs: 86_400_000, cacheScope: "public" } as const;

/** Paths under .claude/skills/: lossless UTF-8 as text, anything else base64. */
export type SkillsSnapshot = { text: Record<string, string>; base64: Record<string, string> };

const EMPTY: SkillsSnapshot = { text: {}, base64: {} };

/** Injected by esbuild from the validated build-time snapshot. */
const SNAPSHOT: SkillsSnapshot = (() => {
  if (typeof __SKILLS_SNAPSHOT__ !== "string" || __SKILLS_SNAPSHOT__.length === 0) return EMPTY;
  try {
    return JSON.parse(__SKILLS_SNAPSHOT__) as SkillsSnapshot;
  } catch {
    return EMPTY;
  }
})();

/**
 * Build a catalog from a snapshot (the embedded one, or a test's). Strict: the
 * build already loaded this exact record through the same SDK call, so a
 * problem here is a bundling fault, never a skill that should be skipped.
 */
export function loadSkillCatalog(snapshot: SkillsSnapshot): Promise<SkillCatalog> {
  const files: Record<string, string | Uint8Array> = { ...snapshot.text };
  for (const [path, base64] of Object.entries(snapshot.base64)) {
    files[path] = new Uint8Array(Buffer.from(base64, "base64"));
  }
  return SkillsExtension.load(memorySkillFiles(files), { cacheHint: SKILLS_CACHE_HINT, strict: true });
}

/**
 * The embedded catalog, built once when the module loads, before any server
 * exists: `createAmiraServer` stays synchronous and every server — stdio, and
 * each per-request server under `createMcpHandler` — attaches the same
 * instance. A catalog that fails to load costs the skill, never the tools.
 */
const CATALOG: SkillCatalog | undefined = await (async () => {
  if (Object.keys(SNAPSHOT.text).length + Object.keys(SNAPSHOT.base64).length === 0) return undefined;
  try {
    const catalog = await loadSkillCatalog(SNAPSHOT);
    return catalog.entries.length > 0 ? catalog : undefined;
  } catch (err) {
    console.error(`[amira] skills catalog rejected, serving none: ${(err as Error).message}`);
    return undefined;
  }
})();

/**
 * Whether to advertise and serve skills. Off when the build carried no valid
 * skill, or when AMIRA_SKILLS is explicitly disabled — read once per server
 * construction (per request on the HTTP transport, which builds a fresh server).
 */
export function skillsEnabled(): boolean {
  const raw = process.env.AMIRA_SKILLS?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
  return CATALOG !== undefined;
}

/**
 * Serve the SEP-2640 surface on a server, declaring the capability with it.
 * No-op when skills are disabled. Must run before the server connects.
 */
export function registerSkills(server: McpServer): void {
  if (!skillsEnabled()) return;
  CATALOG?.attach(server);
}
