import type { McpServer, RegisteredTool } from "@modelcontextprotocol/server";

export const TOOL_PROFILES = {
  full: null,
  research: ["get_collection_overview", "search_research_items", "get_research_item", "search_projects", "get_project",
    "search_persons", "get_person", "search_publications", "get_publication", "list_publication_facets", "search_videos", "get_video",
    "search_podcasts", "get_podcast", "resolve_entity", "get_entity_graph", "get_text_passages", "compare_collections", "get_data_quality",
    "list_subjects", "list_locations", "list_collections", "search", "fetch"],
  discovery: ["get_collection_overview", "resolve_entity", "get_entity_graph", "find_related", "search_projects", "get_project",
    "search_persons", "get_person", "list_subjects", "list_locations", "search_research_items", "get_research_item", "search", "fetch"],
  visualization: ["get_collection_overview", "resolve_entity", "get_entity_graph", "find_related", "list_locations", "list_years",
    "list_research_sections", "search_research_items", "get_research_item", "search_publications", "get_publication", "list_publication_facets",
    "compare_collections", "get_data_quality", "search", "fetch"],
} as const;
export type ToolProfile = keyof typeof TOOL_PROFILES;
export function resolveToolProfile(value = process.env.AMIRA_TOOL_PROFILE ?? "full"): ToolProfile {
  if (!Object.hasOwn(TOOL_PROFILES, value)) throw new Error("AMIRA_TOOL_PROFILE must be full, research, discovery or visualization");
  return value as ToolProfile;
}

// Concise discovery text. Detailed workflow guidance lives in the companion skill;
// input schemas retain matching, pagination and opt-in semantics.
/** Use only the SDK's public registration/disable API, before connecting. */
export function configureToolRegistration(server: McpServer, profile: ToolProfile): void {
  const register = server.registerTool;
  const allowed = TOOL_PROFILES[profile] as readonly string[] | null;
  server.registerTool = ((...args: Parameters<McpServer["registerTool"]>) => {
    const [name] = args;
    const registered = Reflect.apply(register, server, args) as RegisteredTool;
    if (allowed && !allowed.includes(name)) registered.disable();
    return registered;
  }) as McpServer["registerTool"];
}
