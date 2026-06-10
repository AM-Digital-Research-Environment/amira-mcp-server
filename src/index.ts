#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { config } from "./config.js";
import { ensureStore } from "./data.js";

const VERSION = typeof __SERVER_VERSION__ !== "undefined" ? __SERVER_VERSION__ : "dev";

const INSTRUCTIONS =
  "Read-only access to the research data of the Africa Multiple Cluster of Excellence (AMIRA collection), " +
  "as published on the cluster's public Omeka S site (https://data.africamultiple.uni-bayreuth.de). The " +
  "collection spans research projects across four partner universities (Bayreuth, Lagos, Joseph " +
  "Ki-Zerbo/Ouagadougou, Bahia) plus external collections (e.g. the International Library of African " +
  "Music), organised into thematic research sections, with ~4,000 digitised research items, people, " +
  "institutions, groups, an academic bibliography, podcast episodes, and the cluster's YouTube videos " +
  "with searchable transcripts.\n\n" +
  "GETTING STARTED: call get_collection_overview first to scope the data, then use the search_* / list_* " +
  "tools to find records and the get_* tools to drill into one. find_related pivots from any " +
  "subject/place/person/project to the entities that co-occur with it. Subjects include the former " +
  "free-form tags — there is no separate tag facet.\n\n" +
  "CITATIONS — follow these rules exactly:\n" +
  "• Every record includes an `amira_url` (its public page, e.g. " +
  "https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392). Whenever you mention an item, person, " +
  "project, subject, place, podcast or video, render its `amira_url` as a markdown link, e.g. " +
  "[Volume 8: Yoruba Architecture…](https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392).\n" +
  "• NEVER print a bare identifier such as `abg-99-0000`, and NEVER collapse several items into an id " +
  "range like `abg-99-0007 through abg-99-0014`. Reference each item as its own full markdown link (a " +
  "bulleted list of links is good when there are several).\n" +
  "• Use only URLs returned by the tools — never invent one. For a publication, cite its own `url` " +
  "(DOI or repository permalink) as the primary reference, with `amira_url` as the collection page.\n\n" +
  "NAMES: people are stored 'Surname, Forename' (e.g. `Baumann, Oliver`) — always display and cite that " +
  "form. All person filters accept either order and ignore accents, so 'Oliver Baumann' still finds " +
  "'Baumann, Oliver'; get_person echoes the canonical `name`.\n\n" +
  "DATA NOTES: results come from a snapshot of the public Omeka S API — the server queries no live " +
  "backend, so it works offline; get_collection_overview reports the snapshot's freshness. Treat the " +
  "collection as curated, not exhaustive: absence of a result is not proof of absence.";

async function main(): Promise<void> {
  const server = new McpServer({ name: "amira-mcp-server", version: VERSION }, { instructions: INSTRUCTIONS });

  registerTools(server);

  // Warm the in-memory snapshot (and kick off the background refresh) without
  // blocking startup. Tool calls await ensureStore() and surface any load error.
  void ensureStore()
    .then((store) =>
      console.error(
        `[amira] loaded ${store.items.length} research items / ${store.projects.length} projects / ` +
          `${store.videos.length} videos from ${store.source} snapshot (fetchedAt=${store.manifest.fetchedAt})`,
      ),
    )
    .catch((err) => console.error(`[amira] initial data load failed: ${(err as Error).message}`));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[amira] AMIRA MCP server v${VERSION} running on stdio (site: ${config.siteBase}, live refresh: ${config.liveRefresh})`,
  );
}

main().catch((err) => {
  console.error("[amira] fatal:", err);
  process.exit(1);
});
