// Dependency-free identifiers shared by the server (src/tools/apps.ts), the
// page assembler that runs at build time (src/ui/page.ts) and the tests.
//
// The server must not import the view modules: they carry the Natural Earth
// outline and every renderer's source, which belong in the one HTML resource,
// not in the server's own code. This module has no imports, so each side can
// depend on it without pulling the other behind it.

/** The one `ui://` resource that renders every AMIRA view. */
export const APP_URI = "ui://amira/app.html";

/**
 * Tool name -> the view that renders its result. Every tool listed here
 * carries `_meta.ui.resourceUri = APP_URI`; the app picks the view from the
 * host's `toolInfo` and, when a host sends none, from the result's shape.
 */
export const VIEW_OF_TOOL = {
  get_collection_overview: "overview",
  list_years: "timeline",
  list_research_sections: "sections",
  find_related: "related",
  get_entity_graph: "graph",
  list_locations: "map",
  search_publications: "bibliography",
} as const;

export type ViewName = (typeof VIEW_OF_TOOL)[keyof typeof VIEW_OF_TOOL];

/** Tools that render the app, in registration order. */
export const APP_TOOLS = Object.keys(VIEW_OF_TOOL) as (keyof typeof VIEW_OF_TOOL)[];
