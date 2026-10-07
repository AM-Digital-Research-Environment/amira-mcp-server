// Deployment profiles: smaller tool surfaces for hosts that pay for every tool
// definition on every turn. `full` (the default) registers everything. Removal
// happens in tools/policy.ts through the SDK's public `RegisteredTool.remove()`.
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
  const profile = value.trim() || "full";
  if (!Object.hasOwn(TOOL_PROFILES, profile)) throw new Error("AMIRA_TOOL_PROFILE must be full, research, discovery or visualization");
  return profile as ToolProfile;
}

/** Tool names a profile keeps, or null for every tool. */
export function allowedTools(profile: ToolProfile): ReadonlySet<string> | null {
  const names = TOOL_PROFILES[profile] as readonly string[] | null;
  return names ? new Set(names) : null;
}
