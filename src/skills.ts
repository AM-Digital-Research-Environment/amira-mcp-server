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
// tool descriptions, and the instructions only name the SKILL.md URI — hosts
// discover the catalog, then decide what to disclose and when. A host that does
// not implement the extension never calls these methods.
//
// WHAT THE SDK DOES. `SkillsExtension.load` computes every digest and size and
// checks the frontmatter rules; `attach` registers the `skill://{+path}`
// resource template, `skills/list`, `skills/get` and `resources/directory/read`
// (paged), and declares the capability. `attach` is @experimental — its wiring
// may change in a minor SDK release — so test/unit/skills.test.mjs and both
// smoke scripts cover the served surface rather than trusting the upgrade.
//
// WHAT IT DOES NOT. The SDK's own catalog lists one entry per skill in
// `resources/list`. Hosts without the extension (Claude Desktop, Claude Code)
// find files there, and SKILL.md names its references by relative path, so the
// three reference files were invisible to them. The extension is therefore
// served through a small `SkillSource` over the SDK-built entries, whose
// `listResources()` lists every file with a title and a one-line summary — the
// approach the IWAC server took for the same reason.
import type { McpServer, Resource } from "@modelcontextprotocol/server";
import {
  DIRECTORY_MIME_TYPE,
  SkillsExtension,
  memorySkillFiles,
  type Skill,
  type SkillCatalog,
  type SkillSource,
} from "@modelcontextprotocol/server/ext/skills";

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

const BASE = "skill://";

/** Media types for the binary files a skill may carry; text files are markdown or their extension's type. */
const MIME_TYPES: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", json: "application/json", yaml: "application/yaml", yml: "application/yaml",
  csv: "text/csv", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", svg: "image/svg+xml",
  webp: "image/webp", pdf: "application/pdf",
};
const mimeTypeOf = (path: string) => MIME_TYPES[path.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** A markdown file's first heading and the first prose line after it, for `resources/list`. */
export function describeMarkdown(text: string): { title?: string; summary?: string } {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n").map((line) => line.trim());
  const heading = lines.findIndex((line) => /^#{1,3} /.test(line));
  const title = heading >= 0 ? lines[heading]?.replace(/^#+ /, "") : undefined;
  const prose = lines.slice(heading + 1).find((line) => line && !/^(#|[-*|>]|```)/.test(line));
  const summary = prose ? (prose.length > 160 ? `${prose.slice(0, 157)}…` : prose) : undefined;
  return { ...(title ? { title } : {}), ...(summary ? { summary } : {}) };
}

/** A skill's root directory URI: its SKILL.md URI without the file name. */
const rootOf = (skill: Skill) => skill.uri.slice(0, -"/SKILL.md".length);

/** The files an entry's manifest names. Ours are never `"dynamic"`. */
const manifestOf = (skill: Skill) => (Array.isArray(skill.resources) ? skill.resources : []);

/**
 * Serve the SDK-built entries from the snapshot. Reads need no re-verification:
 * the entries were computed from these very strings, constants of the bundle.
 * Anything outside a manifest is answered as absent, so a typo cannot resolve
 * to something plausible-looking.
 */
export function snapshotSource(entries: readonly Skill[], snapshot: SkillsSnapshot): SkillSource {
  const byUri = new Map(entries.map((skill) => [skill.uri, skill]));
  const served = new Map<string, string>();
  const directories = new Map<string, Resource[]>();
  const listed: Resource[] = [];

  for (const skill of entries) {
    const name = skill.frontmatter.name;
    for (const { uri, size } of manifestOf(skill)) {
      const path = uri.slice(BASE.length);
      const mimeType = mimeTypeOf(path);
      served.set(uri, path);

      // Every directory from the skill's root down to the file gains a child.
      const segments = uri.slice(rootOf(skill).length + 1).split("/");
      let dir = rootOf(skill);
      segments.forEach((segment, i) => {
        const child = `${dir}/${segment}`;
        const children = directories.get(dir) ?? [];
        directories.set(dir, children);
        if (!children.some((c) => c.uri === child)) {
          const isFile = i === segments.length - 1;
          children.push(
            isFile ? { uri: child, name: segment, mimeType, size } : { uri: child, name: segment, mimeType: DIRECTORY_MIME_TYPE },
          );
        }
        dir = child;
      });

      // The entry point is described by its own frontmatter, the text a host
      // matches a task against; references by their heading and first line.
      const isEntry = uri === skill.uri;
      const { title, summary } = path in snapshot.text ? describeMarkdown(snapshot.text[path] ?? "") : {};
      listed.push({
        uri,
        name: isEntry ? name : path,
        title: isEntry ? `${name} (SKILL.md)` : title || path,
        description: isEntry ? skill.frontmatter.description : `${name} reference: ${summary || title || path}`,
        mimeType,
        size,
      });
    }
  }
  // Code-point order, as the SDK's own catalog lists a directory.
  for (const children of directories.values()) children.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));

  return {
    list: async () => ({ skills: [...entries] }),
    get: async (uri) => byUri.get(uri),
    read: async (uri) => {
      const path = served.get(uri);
      if (path === undefined) return undefined;
      const text = snapshot.text[path];
      if (text !== undefined) return { text, mimeType: mimeTypeOf(path) };
      const base64 = snapshot.base64[path];
      return base64 === undefined ? undefined : { bytes: new Uint8Array(Buffer.from(base64, "base64")), mimeType: mimeTypeOf(path) };
    },
    readDirectory: async (uri) => {
      const children = directories.get(uri);
      return children === undefined ? undefined : { resources: children };
    },
    listResources: async () => listed,
  };
}

/** The extension that serves a snapshot: the SDK's validated entries, our listing. */
export async function loadSkillsExtension(snapshot: SkillsSnapshot): Promise<SkillsExtension | undefined> {
  const catalog = await loadSkillCatalog(snapshot);
  if (catalog.entries.length === 0) return undefined;
  return new SkillsExtension({ source: snapshotSource(catalog.entries, snapshot), cacheHint: SKILLS_CACHE_HINT, strict: true });
}

/**
 * The embedded extension, built once when the module loads, before any server
 * exists: `createAmiraServer` stays synchronous and every server — stdio, and
 * each per-request server under `createMcpHandler` — attaches the same
 * instance. A catalog that fails to load costs the skill, never the tools.
 */
const EXTENSION: SkillsExtension | undefined = await (async () => {
  if (Object.keys(SNAPSHOT.text).length + Object.keys(SNAPSHOT.base64).length === 0) return undefined;
  try {
    return await loadSkillsExtension(SNAPSHOT);
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
  return EXTENSION !== undefined;
}

/**
 * Serve the SEP-2640 surface on a server, declaring the capability with it.
 * No-op when skills are disabled. Must run before the server connects.
 */
export function registerSkills(server: McpServer): void {
  if (!skillsEnabled()) return;
  EXTENSION?.attach(server);
}
