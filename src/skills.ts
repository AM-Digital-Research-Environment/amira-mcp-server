// Skills over MCP — the draft SEP-2640 extension, served from the embedded
// snapshot that scripts/skills.mjs builds at compile time.
//
// STATUS: PROTOTYPE. SEP-2640 is an OPEN DRAFT (modelcontextprotocol PR #2640)
// and host support is thin. The `skill://` URIs, the catalog shape and the
// `skills/*` methods are NOT a supported interface — they may change or be
// withdrawn without a major version bump, and `amira-mcp-skill.zip` on the
// GitHub release stays the supported way to install the skill. Nothing else in
// the server depends on this module: deleting the `registerSkills` call in
// mcpServer.ts removes the whole surface, and AMIRA_SKILLS=0 does it at runtime.
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
// Draft status: SEP-2640 is unmerged (modelcontextprotocol/modelcontextprotocol
// PR #2640) and the wire contract may still change. AMIRA_SKILLS=0 turns the
// whole surface off without a rebuild.
import { INVALID_PARAMS, ProtocolError, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

/** Capability id negotiated for the extension (mirrors scripts/skills.mjs). */
export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/**
 * Capability block for the `initialize` / `server/discover` response.
 * `directoryRead: true` is what licenses a host to call
 * `resources/directory/read`; without it the method must never be attempted.
 */
export const SKILLS_CAPABILITY = {
  [SKILLS_EXTENSION_ID]: { directoryRead: true },
} as const;

/**
 * Skill files are immutable for the life of a build, so every skill result is
 * shareable across clients for a day — the same reasoning as the `resources/read`
 * entry in mcpServer.ts CACHE_HINTS. `skills/list` carries the hint in-band
 * because the SDK's `cacheHints` option is keyed by the closed set of spec
 * methods and cannot describe an extension method.
 */
const SKILLS_CACHE_HINT = { ttlMs: 86_400_000, cacheScope: "public" } as const;

type SkillResource = {
  uri: string;
  name: string;
  mimeType: string;
  digest: string;
  text?: string;
  blob?: string;
};

type SkillsSnapshot = {
  skills: { uri: string; frontmatter: Record<string, unknown>; resources: { uri: string; digest: string }[] }[];
  resources: SkillResource[];
  directories: { uri: string; name: string }[];
};

const EMPTY: SkillsSnapshot = { skills: [], resources: [], directories: [] };

/** Injected by esbuild from the validated build-time catalog. */
const SNAPSHOT: SkillsSnapshot = (() => {
  if (typeof __SKILLS_SNAPSHOT__ !== "string" || __SKILLS_SNAPSHOT__.length === 0) return EMPTY;
  try {
    return JSON.parse(__SKILLS_SNAPSHOT__) as SkillsSnapshot;
  } catch {
    return EMPTY;
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
  return SNAPSHOT.skills.length > 0;
}

/** Skill count in the embedded catalog (tests, smoke, diagnostics). */
export const skillCount = (): number => SNAPSHOT.skills.length;

const listParams = z.object({ cursor: z.string().optional() }).loose();
const uriParams = z.object({ uri: z.string(), cursor: z.string().optional() }).loose();
const anyResult = z.record(z.string(), z.unknown());

/** Trailing slashes are not significant for a directory URI. */
const normalizeDir = (uri: string): string => uri.replace(/\/+$/, "");

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * Register the SEP-2640 surface on a server: every skill file as an ordinary
 * MCP resource (so `resources/read` just works), plus the three extension
 * methods. No-op when skills are disabled.
 */
export function registerSkills(server: McpServer): void {
  if (!skillsEnabled()) return;

  const skillsByUri = new Map(SNAPSHOT.skills.map((skill) => [skill.uri, skill]));
  const directoryUris = new Set(SNAPSHOT.directories.map((directory) => directory.uri));

  for (const resource of SNAPSHOT.resources) {
    server.registerResource(
      resource.uri,
      resource.uri,
      {
        title: resource.name,
        mimeType: resource.mimeType,
        cacheHint: SKILLS_CACHE_HINT,
      },
      () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            ...(resource.text !== undefined ? { text: resource.text } : { blob: resource.blob as string }),
          },
        ],
      }),
    );
  }

  // The catalog is small and fixed, so it ships in one page: no nextCursor.
  server.server.setRequestHandler("skills/list", { params: listParams, result: anyResult }, async () => ({
    skills: SNAPSHOT.skills,
    ...SKILLS_CACHE_HINT,
  }));

  server.server.setRequestHandler("skills/get", { params: uriParams, result: anyResult }, async ({ uri }) => {
    const skill = skillsByUri.get(uri);
    if (skill === undefined) throw new ProtocolError(INVALID_PARAMS, `Unknown skill: ${uri}`);
    return { skill };
  });

  server.server.setRequestHandler(
    "resources/directory/read",
    { params: uriParams, result: anyResult },
    async ({ uri }) => {
      const base = normalizeDir(uri);
      if (!directoryUris.has(base)) {
        throw new ProtocolError(INVALID_PARAMS, `Unknown skill directory: ${uri}`);
      }
      // Direct children only — one level, never recursive.
      const prefix = `${base}/`;
      const children = new Map<string, { uri: string; name: string; mimeType: string }>();
      for (const resource of SNAPSHOT.resources) {
        if (!resource.uri.startsWith(prefix)) continue;
        const [segment, ...rest] = resource.uri.slice(prefix.length).split("/");
        if (!segment) continue;
        const childUri = `${base}/${segment}`;
        children.set(childUri, {
          uri: childUri,
          name: decodeSegment(segment),
          mimeType: rest.length > 0 ? "inode/directory" : resource.mimeType,
        });
      }
      for (const directory of SNAPSHOT.directories) {
        if (!directory.uri.startsWith(prefix)) continue;
        // Skip grandchildren: only one level below `base`.
        if (directory.uri.slice(prefix.length).includes("/")) continue;
        children.set(directory.uri, { uri: directory.uri, name: directory.name, mimeType: "inode/directory" });
      }
      return { resources: [...children.values()].sort((a, b) => (a.uri < b.uri ? -1 : 1)) };
    },
  );
}
