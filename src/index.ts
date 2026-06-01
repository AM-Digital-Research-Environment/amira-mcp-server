#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools/register.js";
import { config } from "./config.js";
import { ensureStore } from "./data.js";

const INSTRUCTIONS =
  "Read-only access to the Africa Multiple Cluster of Excellence research data, as published by the " +
  "amira dashboard (https://amira.africamultiple.uni-bayreuth.de). The collection spans research projects " +
  "across four partner universities (Bayreuth, Lagos, Joseph Ki-Zerbo/Ouagadougou, Bahia) plus external " +
  "collections, organised into thematic research sections, with ~4,000 digitised research items, people, " +
  "institutions, groups, and an academic bibliography.\n\n" +
  "GETTING STARTED: call get_collection_overview first to scope the data, then use the search_* / list_* " +
  "tools to find records and the get_* tools to drill into one. find_related pivots from any " +
  "subject/place/person/project/tag to the entities that co-occur with it.\n\n" +
  "CITATIONS: every record includes a `dashboard_url` field (e.g. " +
  "https://amira.africamultiple.uni-bayreuth.de/research-items?id=abg-99-0000). ALWAYS cite an entity by " +
  "rendering this URL as a markdown link so the user can open and verify the source page on the amira " +
  "dashboard — never invent a citation or use a bare id. Publications additionally carry their own `url` " +
  "(DOI or repository permalink); cite that as the primary reference for a publication. When you list " +
  "multiple results, attach each one's dashboard_url to the item you mention.\n\n" +
  "DATA NOTES: results come from a snapshot of the dashboard's public JSON — the server never queries the " +
  "underlying MongoDB, so it works offline. The snapshot may lag the live site; get_collection_overview " +
  "reports its freshness. Person/contributor names use 'Surname, Forename'. Treat the collection as " +
  "curated, not exhaustive: absence of a result is not proof of absence.";

async function main(): Promise<void> {
  const server = new McpServer(
    { name: "africa-multiple-mcp-server", version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  registerTools(server);

  // Warm the in-memory snapshot (and kick off the background refresh) without
  // blocking startup. Tool calls await ensureStore() and surface any load error.
  void ensureStore()
    .then((store) =>
      console.error(
        `[amira] loaded ${store.items.length} items / ${store.projects.length} projects ` +
          `from ${store.source} snapshot (generatedAt=${store.generatedAt || "?"})`,
      ),
    )
    .catch((err) => console.error(`[amira] initial data load failed: ${(err as Error).message}`));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[amira] Africa Multiple MCP server running on stdio ` +
      `(dashboard: ${config.dashboardBase}, live refresh: ${config.liveRefresh})`,
  );
}

main().catch((err) => {
  console.error("[amira] fatal:", err);
  process.exit(1);
});
