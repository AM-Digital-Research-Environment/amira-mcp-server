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
// approach the IWAC server took for the same reason. It follows the catalog's
// contract (#56): any spelling of a URI the SDK would accept finds the same
// entry, and a cursor it never issued is refused. The SDK keeps its own sources
// in a private trusted set, so ours is re-validated per skills/list and
// skills/get; for one entry that is a few microseconds.
import { ProtocolError, ProtocolErrorCode, type McpServer, type Resource } from "@modelcontextprotocol/server";
import {
  DIRECTORY_MIME_TYPE,
  SkillsExtension,
  memorySkillFiles,
  type Skill,
  type SkillCatalog,
  type SkillSource,
} from "@modelcontextprotocol/server/ext/skills";
import { config } from "./config.js";
import { bool } from "./env.js";

/**
 * Skill files are immutable for the life of a build, so every skill result is
 * shareable across clients for a day — the same reasoning as the app HTML's
 * hint (src/tools/apps.ts). A curator server keeps its rule of no shared
 * caching whatever the method (#49), although the skill text itself is public.
 * The SDK sends it on 2026-07-28 connections only, where the fields exist.
 */
const skillsCacheHint = () => config.access === "curator"
  ? ({ ttlMs: 0, cacheScope: "private" } as const)
  : ({ ttlMs: 86_400_000, cacheScope: "public" } as const);

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
  return SkillsExtension.load(memorySkillFiles(files), { cacheHint: skillsCacheHint(), strict: true });
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

/**
 * The one spelling of a skill URI, as the SDK's own catalog matches them (#56):
 * WHATWG-serialised (so `SKILL://amira-mcp/SKILL.md` is the entry point), no
 * fragment, each path segment percent-decoded (so `Q%26A.md` and `Q&A.md` are
 * one file). `undefined` when it does not parse.
 */
export function skillUriKey(uri: string): string | undefined {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return undefined;
  }
  url.hash = "";
  const href = url.href;
  if (href.includes("?")) return href;
  const scheme = href.indexOf("://");
  if (scheme < 0) return href;
  const rest = href.slice(scheme + 3).split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return `${href.slice(0, scheme + 3)}${rest.join("/")}`;
}

/** We never hand out a cursor (every list fits one page), so any cursor is one we did not issue: the SDK catalog's answer. */
const refuseCursor = (cursor: string | undefined) => {
  if (cursor !== undefined) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid cursor");
};

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
  // Every map is keyed by `skillUriKey`, so any spelling of a URI finds its file.
  const key = (uri: string) => skillUriKey(uri) ?? uri;
  const byUri = new Map(entries.map((skill) => [key(skill.uri), skill]));
  const served = new Map<string, string>();
  const directories = new Map<string, Resource[]>();
  const listed: Resource[] = [];

  for (const skill of entries) {
    const name = skill.frontmatter.name;
    for (const { uri, size } of manifestOf(skill)) {
      // The snapshot is keyed by the decoded relative path; the URI is percent-encoded.
      const path = key(uri).slice(BASE.length);
      const mimeType = mimeTypeOf(path);
      served.set(key(uri), path);

      // Every directory from the skill's root down to the file gains a child.
      const segments = uri.slice(rootOf(skill).length + 1).split("/");
      let dir = rootOf(skill);
      segments.forEach((segment, i) => {
        const child = `${dir}/${segment}`;
        const children = directories.get(key(dir)) ?? [];
        directories.set(key(dir), children);
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
    list: async ({ cursor }) => {
      refuseCursor(cursor);
      return { skills: [...entries] };
    },
    get: async (uri) => byUri.get(key(uri)),
    read: async (uri) => {
      const path = served.get(key(uri));
      if (path === undefined) return undefined;
      const text = snapshot.text[path];
      if (text !== undefined) return { text, mimeType: mimeTypeOf(path) };
      const base64 = snapshot.base64[path];
      return base64 === undefined ? undefined : { bytes: new Uint8Array(Buffer.from(base64, "base64")), mimeType: mimeTypeOf(path) };
    },
    readDirectory: async (uri, { cursor }) => {
      const children = directories.get(key(uri));
      if (children === undefined) return undefined;
      refuseCursor(cursor);
      return { resources: children };
    },
    listResources: async () => listed,
  };
}

/** The extension that serves a snapshot: the SDK's validated entries, our listing. */
export async function loadSkillsExtension(snapshot: SkillsSnapshot): Promise<SkillsExtension | undefined> {
  const catalog = await loadSkillCatalog(snapshot);
  if (catalog.entries.length === 0) return undefined;
  return new SkillsExtension({ source: snapshotSource(catalog.entries, snapshot), cacheHint: skillsCacheHint(), strict: true });
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
  return bool("AMIRA_SKILLS", true) && EXTENSION !== undefined;
}

/**
 * Serve the SEP-2640 surface on a server, declaring the capability with it.
 * No-op when skills are disabled. Must run before the server connects.
 */
export function registerSkills(server: McpServer): void {
  if (!skillsEnabled()) return;
  EXTENSION?.attach(server);
}
