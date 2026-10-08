// MCP Apps (extension `io.modelcontextprotocol/ui`, SEP-1865): the interactive
// UI resources this server offers. A tool opts in by carrying
// `_meta.ui.resourceUri` pointing at one of the `ui://` resources below; hosts
// that do not implement the extension ignore that `_meta` and keep the plain
// JSON result, so declaring it is safe on every surface. An app is registered
// only when a tool that renders it survives the active tool profile.
import { OVERVIEW_HTML, OVERVIEW_URI } from "../ui/overview.js";
import { RELATED_HTML, RELATED_URI } from "../ui/related.js";
import { SECTIONS_HTML, SECTIONS_URI } from "../ui/sections.js";
import { TIMELINE_HTML, TIMELINE_URI } from "../ui/timeline.js";
import type { Server } from "./_shared.js";
import { GRAPH_HTML, GRAPH_URI } from "../ui/graph.js";
import { MAP_HTML, MAP_URI } from "../ui/map.js";
import { BIBLIOGRAPHY_HTML, BIBLIOGRAPHY_URI } from "../ui/bibliography.js";

/** MIME type the extension requires for a UI resource. */
const APP_MIME = "text/html;profile=mcp-app";

interface AppResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  html: string;
  /** The tool whose result this app renders. */
  tool: string;
}

const APPS: AppResource[] = [
  { name: "amira-graph", uri: GRAPH_URI, title: "Entity graph", description: "Explore explicit links, co-occurrences and cited evidence.", html: GRAPH_HTML, tool: "get_entity_graph" },
  { name: "amira-map", uri: MAP_URI, title: "Research places", description: "Offline map and table of research locations and their evidence.", html: MAP_HTML, tool: "list_locations" },
  { name: "amira-bibliography", uri: BIBLIOGRAPHY_URI, title: "Cluster bibliography", description: "Filter publications and export selected citations.", html: BIBLIOGRAPHY_HTML, tool: "search_publications" },
  {
    name: "amira-overview",
    uri: OVERVIEW_URI,
    title: "AMIRA collection at a glance",
    description:
      "Stat tiles and ranked breakdowns of the whole collection — the visual form of get_collection_overview.",
    html: OVERVIEW_HTML,
    tool: "get_collection_overview",
  },
  {
    name: "amira-timeline",
    uri: TIMELINE_URI,
    title: "AMIRA coverage timeline",
    description: "Histogram of research items per year or decade — the visual form of list_years.",
    html: TIMELINE_HTML,
    tool: "list_years",
  },
  {
    name: "amira-sections",
    uri: SECTIONS_URI,
    title: "AMIRA research sections by funding phase",
    description:
      "Gantt of the cluster's research sections across the AM 1.0 and AM 2.0 funding phases — the visual form of list_research_sections.",
    html: SECTIONS_HTML,
    tool: "list_research_sections",
  },
  {
    name: "amira-related",
    uri: RELATED_URI,
    title: "AMIRA co-occurrence hub",
    description:
      "Radial hub of the entities that co-occur with a subject, place, person or project — the visual form of find_related.",
    html: RELATED_HTML,
    tool: "find_related",
  },
];

export function registerAppResources(
  server: Server,
  toolEnabled: (name: string) => boolean = () => true,
  opts: { guidance?: boolean } = {},
): void {
  for (const app of APPS) {
    if (!toolEnabled(app.tool)) continue;
    server.registerResource(
      app.name,
      app.uri,
      {
        // AMIRA_GUIDANCE=off: no title or description (src/guidance.ts).
        ...(opts.guidance ?? true ? { title: app.title, description: app.description } : {}),
        mimeType: APP_MIME,
        // No csp domains: every template inlines all of its CSS and JS and
        // loads nothing from the network, so it runs in the strictest sandbox.
        _meta: { ui: { prefersBorder: false } },
      },
      () => ({ contents: [{ uri: app.uri, mimeType: APP_MIME, text: app.html, _meta: { ui: { prefersBorder: false } } }] }),
    );
  }
}

const uiMeta = (resourceUri: string) => ({ ui: { resourceUri, visibility: ["model", "app"] } });

/** `_meta` a tool carries to render its result through one of the apps. */
export const TIMELINE_UI_META = uiMeta(TIMELINE_URI);
export const OVERVIEW_UI_META = uiMeta(OVERVIEW_URI);
export const SECTIONS_UI_META = uiMeta(SECTIONS_URI);
export const RELATED_UI_META = uiMeta(RELATED_URI);
export const GRAPH_UI_META = uiMeta(GRAPH_URI);
export const MAP_UI_META = uiMeta(MAP_URI);
export const BIBLIOGRAPHY_UI_META = uiMeta(BIBLIOGRAPHY_URI);
