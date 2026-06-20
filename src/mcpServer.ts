// Shared MCP server factory — one definition of the server's identity, tools and
// instructions, used by BOTH transports: the stdio entry (src/index.ts, the
// .mcpb) and the remote Streamable HTTP entry (src/http.ts). Only the transport
// and the tool surface differ: HTTP additionally registers the OpenAI-compatible
// `search`/`fetch` tools for ChatGPT.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools/register.js";
import { registerOpenAITools } from "./tools/openai.js";

export const VERSION = typeof __SERVER_VERSION__ !== "undefined" ? __SERVER_VERSION__ : "dev";

export const INSTRUCTIONS =
  "Read-only access to the Africa Multiple Interactive Research Atlas (AMIRA), the research-data platform " +
  "of the Africa Multiple Cluster of Excellence at the University of Bayreuth. AMIRA is built and " +
  "maintained by the Cluster's Digital Research Environment (DRE), its digital infrastructure unit. The " +
  "platform connects researchers across the Africa Multiple Research Centres (AMRCs) and partner " +
  "institutions worldwide. Curation and description are joint efforts with partners at the AMRCs in " +
  "Université Joseph Ki-Zerbo, Rhodes University, the University of Lagos, and Moi University. Bayreuth " +
  "hosts the coordinating DRE infrastructure and metadata layer. Federal University of Bahia is a " +
  "privileged partner, not an AMRC. Storage stays distributed by default: research data remains in local " +
  "repositories and becomes findable without being relocated.\n\n" +
  "The AMIRA MCP server exposes Omeka S metadata for research items, projects, research sections, people, " +
  "institutions, groups, collections, publications, podcast episodes, YouTube videos and searchable " +
  "transcripts, plus the places, languages and subjects that connect them.\n\n" +
  "GETTING STARTED: call get_collection_overview first to scope the data, then use the search_* / list_* " +
  "tools to find records and the get_* tools to drill into one. find_related pivots from any " +
  "subject/place/person/project to the entities that co-occur with it. Subjects include the former " +
  "free-form tags — there is no separate tag facet.\n\n" +
  "CITATIONS — follow these rules exactly:\n" +
  "• Every record includes an `amira_url` (its public page, e.g. " +
  "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392). Whenever you mention an item, person, " +
  "project, subject, place, podcast or video, render its `amira_url` as a markdown link, e.g. " +
  "[Volume 8: Yoruba Architecture…](https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392).\n" +
  "• NEVER print legacy DRE identifiers. If an identifier is explicitly needed, use the " +
  "Omeka `omeka_id` / `id` (the final number in the `amira_url`), but citations should normally be links. " +
  "Never collapse several items into an id " +
  "range. Reference each item as its own full markdown link (a " +
  "bulleted list of links is good when there are several).\n" +
  "• Use only URLs returned by the tools — never invent one. Prefer the AMIRA `amira_url` / Omeka page " +
  "as the citation link whenever possible. For publications, videos or podcasts, include DOI, watch or " +
  "listen URLs only as additional links when useful; do not let them replace the AMIRA record link.\n\n" +
  "NAMES: people are stored 'Surname, Forename' (e.g. `Baumann, Oliver`) — always display and cite that " +
  "form. All person filters accept either order and ignore accents, so 'Oliver Baumann' still finds " +
  "'Baumann, Oliver'; get_person echoes the canonical `name`.\n\n" +
  "DATA NOTES: results come from a bundled or refreshed snapshot of the public Omeka S API. The server " +
  "works offline from the bundled snapshot; when live refresh is enabled, it may probe and refresh from " +
  "the public API. get_collection_overview reports the snapshot source and freshness. Treat the " +
  "collection as curated, not exhaustive: absence of a result is not proof of absence.";

export interface CreateServerOptions {
  /** Also register the OpenAI-compatible `search`/`fetch` tools (HTTP transport). */
  openai?: boolean;
}

/** Build a fully-configured AMIRA MCP server (tools registered, not yet connected). */
export function createAmiraServer(opts: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: "amira-mcp-server", version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server);
  if (opts.openai) registerOpenAITools(server);
  return server;
}
