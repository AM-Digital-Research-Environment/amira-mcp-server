// MCP round-trip smoke test: spawn the bundled server, list tools, exercise one
// call per tool family, and print a short preview of each response.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/index.js"],
  stderr: "inherit",
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  const preview = body.slice(0, 600).replace(/\s+/g, " ");
  console.log(`\n[${name}] ${preview}${body.length > 600 ? "…" : ""}`);
  return body;
}

await call("get_collection_overview", {});
await call("search_research_items", { subject: "Islam", limit: 3 });
await call("search_research_items", { location: "Nigeria", resource_type: "Image", limit: 2 });
await call("search_projects", { research_section: "Arts & Aesthetics", limit: 3 });
await call("list_research_sections", {});
await call("list_subjects", { limit: 5 });
await call("list_locations", { level: "country", limit: 5 });
await call("list_categories", { category: "resource_types", limit: 5 });
await call("search_persons", { keyword: "Beier", limit: 3 });
await call("get_person", { name: "Beier, Ulli" });
await call("list_institutions", { limit: 3 });
await call("search_publications", { limit: 3 });
await call("find_related", { entity_type: "subject", value: "Architecture", limit: 8 });

await client.close();
await transport.close();
console.log("\nsmoke test complete");
