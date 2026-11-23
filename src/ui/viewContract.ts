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

/**
 * The tools a view may call itself, through the bridge's callTool: its
 * follow-up calls (filters, paging, evidence, re-centring) and the pickers'
 * option lists. The bridge (src/ui/bridge.ts) refuses any other;
 * test/unit/apps-views.test.mjs checks that every tool name the views pass is
 * here and that every name here is used.
 */
export const VIEW_CALLABLE_TOOLS = [
  "get_entity_graph",
  "resolve_entity",
  "list_locations",
  "search_research_items",
  "list_years",
  "search_publications",
  "get_publication",
  "list_publication_facets",
  "search_projects",
  "list_subjects",
] as const;

/**
 * Tools whose view keeps state worth restoring when the host re-delivers the
 * result (#32): the server stamps their results with a viewUUID and the
 * snapshot id (src/tools/policy.ts), and the view saves its filters,
 * selections and paging under that instance (src/ui/viewState.ts).
 */
export const RESTORABLE_TOOLS = ["search_publications", "list_locations", "get_entity_graph"] as const;

/** Tools that render the app, in registration order. */
// Marked pure so a bundle that imports only VIEW_CALLABLE_TOOLS (the bridge)
// drops this and VIEW_OF_TOOL.
export const APP_TOOLS = /* @__PURE__ */ Object.keys(VIEW_OF_TOOL) as (keyof typeof VIEW_OF_TOOL)[];
