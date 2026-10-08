// Shared MCP server factory — one definition of the server's identity, tools and
// instructions, used by BOTH transports: the stdio entry (src/index.ts, the
// .mcpb) and the remote Streamable HTTP entry (src/http.ts). Only the transport
// and the tool surface differ: HTTP additionally registers the OpenAI-compatible
// `search`/`fetch` tools for ChatGPT.
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { resolveToolProfile, type ToolProfile } from "./toolProfiles.js";
import { registerTools } from "./tools/register.js";
import { registerPrompts } from "./prompts.js";
import { registerDataResources } from "./resources.js";
import { SKILLS_CAPABILITY, registerSkills, skillsEnabled } from "./skills.js";
import { guidanceEnabled } from "./guidance.js";

export const VERSION = typeof __SERVER_VERSION__ !== "undefined" ? __SERVER_VERSION__ : "dev";

/**
 * The stateless MCP revision (SEP-2575). The SDK keeps this string internal on
 * purpose — `SUPPORTED_PROTOCOL_VERSIONS` is the *legacy* `initialize` ladder
 * and tops out at 2025-11-25 — so a server that wants the modern era has to name
 * the revision itself.
 */
const MODERN_PROTOCOL_VERSION = "2026-07-28";

/**
 * Offered revisions, newest first. The SDK splits this list by era internally:
 * `server/discover` advertises only the 2026-era entries, while the legacy
 * `initialize` handshake sees only the 2025-era tail — so naming both here opts
 * into 2026-07-28 without breaking any older client. Registering
 * `server/discover` at all is conditional on a modern entry being present:
 *
 *   if (modernProtocolVersions(this._supportedProtocolVersions).length > 0)
 *       this.setRequestHandler("server/discover", …)
 *
 * Without it the server answers `-32601 Method not found` and no 2026-era client
 * can negotiate.
 */
const PROTOCOL_VERSIONS = [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS];

/**
 * `ttlMs` / `cacheScope` for the cacheable 2026-07-28 results (SEP-2549). The
 * SDK's defaults are `{ ttlMs: 0, cacheScope: "private" }` — correct for a
 * server whose surface is per-user, wrong for this one.
 *
 * Everything listed here is fixed when the process starts: the tool surface is
 * decided by `createAmiraServer`'s options, and the `ui://` app templates are
 * string constants compiled into the bundle. None of it varies by caller — the
 * server is unauthenticated and read-only, and AMIRA_EXPOSURE is a process-wide
 * experiment flag that gates the *content of tool results*, never which tools
 * are listed — so a shared cache can serve every client the same bytes.
 * AMIRA_GUIDANCE=off changes the listed text, but for the whole process, never
 * per caller.
 *
 * An hour is a freshness hint, not a contract: the surface changes only on
 * redeploy, which ends every connection anyway.
 * `resources/read` gets longer because the app HTML is immutable per build.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/read": { ttlMs: 86_400_000, cacheScope: "public" },
} as const;

/**
 * Server instructions. Claude Code truncates instructions at 2,048 characters,
 * and the 1.18 text (3,327) lost its citation rules exactly at that cut. The
 * rules therefore come FIRST and the whole text stays under the limit (a unit
 * test enforces it); institutional background lives in the companion skill and
 * in get_collection_overview.
 */
export const INSTRUCTIONS =
  "CITATIONS — follow exactly:\n" +
  "• Every record carries an `amira_url`, its public AMIRA page. Whenever you mention an item, person, project, " +
  "subject, place, publication, podcast or video, render its `amira_url` as a markdown link. For several records " +
  "use one link each (a bulleted list is good) — never collapse them into an id range.\n" +
  "• Use only URLs returned by the tools; never invent one. DOI, watch or listen URLs may be added, but never " +
  "replace the AMIRA link.\n" +
  "• Never print legacy DRE identifiers. If an id is needed, use `omeka_id` (the final number of the amira_url).\n\n" +
  "NAMES: people are stored 'Surname, Forename' (e.g. `Baumann, Oliver`); display and cite that form. Person " +
  "filters accept either order and ignore accents.\n\n" +
  "WORKFLOW: call get_collection_overview first, then search_* / list_* to find records and get_* for detail. " +
  "resolve_entity turns a name into a typed id for get_entity_graph; find_related pivots on a subject, place, " +
  "person or project. Multi-word keywords match records containing every word; quote a phrase to match it " +
  "exactly. Transcripts and publication full text are opt-in on the detail tools (include_transcript / " +
  "include_fulltext, paged by offset).\n\n" +
  "ABOUT: AMIRA (Africa Multiple Interactive Research Atlas) is the research-data platform of the Africa Multiple " +
  "Cluster of Excellence, University of Bayreuth, built by its Digital Research Environment and curated with the " +
  "Africa Multiple Research Centres at Université Joseph Ki-Zerbo, Rhodes University, the University of Lagos and " +
  "Moi University. Federal University of Bahia is a privileged partner, not an AMRC. Results come from a snapshot " +
  "of the public Omeka S API; get_collection_overview reports its date. The collection is curated, not " +
  "exhaustive: absence of a result is not proof of absence.";

export interface CreateServerOptions {
  /** Also register the OpenAI-compatible `search`/`fetch` tools (HTTP transport). */
  openai?: boolean;
  profile?: ToolProfile;
}

/**
 * Cap on array elements + object members in one call's arguments (SDK 2.3
 * `maxToolInputElements`), checked before schema validation. The largest
 * legitimate input is a handful of cohorts, ids or filters.
 */
const MAX_TOOL_INPUT_ELEMENTS = 200;

/**
 * The tool, prompt and resource lists are fixed for the life of a process (see
 * CACHE_HINTS), so `listChanged` is declared false. The SDK would otherwise
 * advertise true, and 2026-07-28 clients use that bit to decide whether to hold
 * a `subscriptions/listen` stream open for list changes that never come.
 */
const FIXED_LISTS = {
  tools: { listChanged: false },
  prompts: { listChanged: false },
  resources: { listChanged: false },
} as const;

/**
 * Build a fully-configured AMIRA MCP server (tools registered, not yet connected).
 * AMIRA_GUIDANCE is read here, once for the surface: with it off the server sends
 * no instructions, registers and declares no prompts or skill, and its tools and
 * resources lose their titles and descriptions (src/guidance.ts).
 */
export function createAmiraServer(opts: CreateServerOptions = {}): McpServer {
  const guidance = guidanceEnabled();
  const skills = guidance && skillsEnabled();
  const server = new McpServer(
    {
      name: "amira-mcp-server",
      version: VERSION,
      title: "AMIRA — Africa Multiple Research Data",
      description:
        "Read-only access to AMIRA, the research-data platform of the Africa Multiple Cluster of " +
        "Excellence at the University of Bayreuth (Omeka S).",
      websiteUrl: "https://data.africamultiple.uni-bayreuth.de",
    },
    {
      ...(guidance ? { instructions: INSTRUCTIONS } : {}),
      supportedProtocolVersions: PROTOCOL_VERSIONS,
      cacheHints: CACHE_HINTS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      capabilities: {
        ...(guidance ? FIXED_LISTS : { tools: FIXED_LISTS.tools, resources: FIXED_LISTS.resources }),
        // SEP-2640. Declared only when a valid skill catalog was built, so
        // a host never sees the capability without `skills/list` behind it.
        ...(skills ? { extensions: SKILLS_CAPABILITY } : {}),
      },
    },
  );
  const tools = registerTools(server, opts.profile ?? resolveToolProfile(), { openai: opts.openai, guidance });
  if (guidance) registerPrompts(server);
  registerDataResources(server, tools, { guidance });
  if (skills) registerSkills(server);
  return server;
}
