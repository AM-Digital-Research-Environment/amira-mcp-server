// Shared MCP server factory — one definition of the server's identity, tools and
// instructions, used by BOTH transports: the stdio entry (src/index.ts, the
// .mcpb) and the remote Streamable HTTP entry (src/http.ts). Only the transport
// and the tool surface differ: HTTP additionally registers the OpenAI-compatible
// `search`/`fetch` tools for ChatGPT.
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import { allowedTools, resolveToolProfile, type ToolProfile } from "./toolProfiles.js";
import { registerTools } from "./tools/register.js";
import { registerPrompts } from "./prompts.js";
import { registerDataResources } from "./resources.js";
import { registerSkills, skillsEnabled } from "./skills.js";
import { guidanceEnabled } from "./guidance.js";
import { config } from "./config.js";

export const VERSION = typeof __SERVER_VERSION__ !== "undefined" ? __SERVER_VERSION__ : "dev";
/** The emblem, injected by esbuild like the version; absent when the source runs unbundled (#59). */
const ICON = typeof __SERVER_ICON__ !== "undefined" && __SERVER_ICON__ ? __SERVER_ICON__ : undefined;

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
 *
 * `resources/read` is different: the data resources (amira://record/*,
 * amira://dataset, amira://export/*) follow the snapshot, which a live refresh
 * replaces, so their reads keep a short hint (#49). The app HTML, immutable per
 * build, carries its own day-long hint (src/tools/apps.ts), as do the skill files.
 */
const CACHE_HINTS = {
  "tools/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/templates/list": { ttlMs: 3_600_000, cacheScope: "public" },
  "server/discover": { ttlMs: 3_600_000, cacheScope: "public" },
  "resources/read": { ttlMs: 300_000, cacheScope: "public" },
} as const;

/**
 * Server instructions. Claude Code truncates instructions at 2,048 characters,
 * and the 1.18 text (3,327) lost its citation rules exactly at that cut. The
 * rules therefore come FIRST and the whole text stays under the limit (a unit
 * test enforces it); institutional background lives in the companion skill and
 * in get_collection_overview.
 *
 * The one sentence about the skill names its SKILL.md, so a host without the
 * Skills extension still learns where the workflow lives (it reads it with
 * resources/read; the IWAC server does the same). It is dropped when the skill
 * is not served (AMIRA_SKILLS=0), and INSTRUCTIONS is the longer text.
 */
const SKILL_POINTER = " Before substantial research, read skill://amira-mcp/SKILL.md.";
const CURATOR_SKILL_POINTER = " Before substantial research, read skill://amira-mcp/SKILL.md and skill://amira-curator/SKILL.md.";

export const INSTRUCTIONS =
  "CITATIONS — follow exactly:\n" +
  "• Every record carries an `amira_url`. Whenever you mention an item, person, project, subject, place, " +
  "publication, podcast, video or chronicle, link its `amira_url` in markdown — one link per record " +
  "(e.g. a bulleted list), never an id range.\n" +
  "• Use only URLs returned by tools; never invent one. DOI, watch or listen URLs may supplement, never " +
  "replace, the AMIRA link.\n" +
  "• Never print legacy DRE identifiers; if an id is needed, use `omeka_id` (the final number of amira_url).\n\n" +
  "NAMES: people are stored 'Surname, Forename' (e.g. `Baumann, Oliver`); display and cite that form. Person " +
  "filters accept either order and ignore accents. A person's records show what AMIRA catalogues, not their full " +
  "work or standing: present them as records, never as an evaluation, and never rank or judge people.\n\n" +
  "WORKFLOW: start with get_collection_overview, then search_* / list_* (items, projects, people, publications, " +
  "podcasts, videos, chronicles) and get_* for detail. resolve_entity → get_entity_graph maps links; " +
  "find_related pivots across corpora; get_text_passages quotes passages; get_similar_items / get_semantic_map " +
  "find semantic clusters; get_fulltext_map covers ILAM African Music; compare_collections and get_data_quality " +
  "check coverage. Multi-word keywords require every word; quote phrases. Long texts are opt-in on get_* " +
  "(include_fulltext / include_transcript / include_text)." +
  SKILL_POINTER +
  "\n\n" +
  "ABOUT: AMIRA (Africa Multiple Interactive Research Atlas) is the research-data platform of the Africa Multiple " +
  "Cluster of Excellence, University of Bayreuth (DRE), curated with the Africa Multiple Research Centres at " +
  "Université Joseph Ki-Zerbo, Rhodes University, the University of Lagos and Moi University (Federal University " +
  "of Bahia is a privileged partner, not an AMRC). Results come from a snapshot of the public Omeka S API " +
  "(see get_collection_overview) and are curated, not exhaustive: absence is not proof of absence.";

/**
 * Curator mode (#26): the private-record rules come first, then the public
 * rules and workflow; the institutional paragraph is shortened so the whole
 * text stays within the same 2,048-character limit (a unit test enforces it).
 */
const CURATOR_RULES =
  "CURATOR MODE — also serves PRIVATE AMIRA records and values:\n" +
  "• `visibility: \"private\"` records have no public page: `admin_url` (Omeka admin) and `citation_note` " +
  "replace `amira_url`; name them as private.\n" +
  "• `restricted` holds private values (security level, MongoDB id, full text); quoting them is the curator's call.\n\n";
const CURATOR_ABOUT =
  "\n\nABOUT: AMIRA (Africa Multiple, University of Bayreuth). " +
  "Authenticated Omeka S snapshot; get_collection_overview gives its date and public/private split.";
export function curatorInstructions(skills = true): string {
  // The public citation rules, restated for public records: a private one has no amira_url.
  const rules = INSTRUCTIONS.slice(0, INSTRUCTIONS.indexOf("\n\nABOUT:"))
    .replace("• Every record carries an `amira_url`", "• Every public record carries an `amira_url`");
  return CURATOR_RULES + (skills ? rules.replace(SKILL_POINTER, CURATOR_SKILL_POINTER) : rules.replace(SKILL_POINTER, "")) + CURATOR_ABOUT;
}

/** Curator results hold private data: no shared caching, whatever the method. */
const CURATOR_CACHE_HINTS = {
  "tools/list": { ttlMs: 0, cacheScope: "private" },
  "prompts/list": { ttlMs: 0, cacheScope: "private" },
  "resources/list": { ttlMs: 0, cacheScope: "private" },
  "resources/templates/list": { ttlMs: 0, cacheScope: "private" },
  "server/discover": { ttlMs: 0, cacheScope: "private" },
  "resources/read": { ttlMs: 0, cacheScope: "private" },
} as const;

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
      // The Africa Multiple emblem, 96 px. Claude shows it over the app's views
      // and on the overview's entry-point tile; it accepts only an inline PNG or
      // JPEG (64-128 px, under 10 KB) and fetches no icon URL.
      ...(ICON ? { icons: [{ src: `data:image/png;base64,${ICON}`, mimeType: "image/png", sizes: ["96x96"] }] } : {}),
    },
    {
      ...(guidance
        ? { instructions: config.access === "curator" ? curatorInstructions(skills) : skills ? INSTRUCTIONS : INSTRUCTIONS.replace(SKILL_POINTER, "") }
        : {}),
      supportedProtocolVersions: PROTOCOL_VERSIONS,
      cacheHints: config.access === "curator" ? CURATOR_CACHE_HINTS : CACHE_HINTS,
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      capabilities: {
        ...(guidance ? FIXED_LISTS : { tools: FIXED_LISTS.tools, resources: FIXED_LISTS.resources }),
      },
    },
  );
  const profile = opts.profile ?? resolveToolProfile();
  const servedTools = allowedTools(profile);
  const tools = registerTools(server, profile, { openai: opts.openai, guidance });
  if (guidance) registerPrompts(server, servedTools);
  registerDataResources(server, tools, { guidance, servedTools });
  // SEP-2640: the SDK extension declares its capability as it attaches, so a
  // host never sees the capability without `skills/list` behind it.
  if (skills) registerSkills(server);
  return server;
}
