// MCP Apps (extension `io.modelcontextprotocol/ui`, SEP-1865): the interactive
// UI resources this server offers. A tool opts in by carrying
// `_meta.ui.resourceUri` pointing at one of the `ui://` resources below; hosts
// that do not implement the extension ignore that `_meta` and keep the plain
// JSON result, so declaring it is safe on every surface.
//
// Registering a resource makes the server advertise the `resources` capability
// — the UI templates are the only resources it serves.
import { OVERVIEW_HTML, OVERVIEW_URI } from "../ui/overview.js";
import { TIMELINE_HTML, TIMELINE_URI } from "../ui/timeline.js";
import type { Server } from "./_shared.js";

/** MIME type the extension requires for a UI resource. */
const APP_MIME = "text/html;profile=mcp-app";

interface AppResource {
  name: string;
  uri: string;
  title: string;
  description: string;
  html: string;
}

const APPS: AppResource[] = [
  {
    name: "amira-overview",
    uri: OVERVIEW_URI,
    title: "AMIRA collection at a glance",
    description:
      "Stat tiles and ranked breakdowns of the whole collection — the visual form of get_collection_overview.",
    html: OVERVIEW_HTML,
  },
  {
    name: "amira-timeline",
    uri: TIMELINE_URI,
    title: "AMIRA coverage timeline",
    description: "Histogram of research items per year or decade — the visual form of list_years.",
    html: TIMELINE_HTML,
  },
];

export function registerAppResources(server: Server): void {
  for (const app of APPS) {
    server.registerResource(
      app.name,
      app.uri,
      {
        title: app.title,
        description: app.description,
        mimeType: APP_MIME,
        // No csp domains: every template inlines all of its CSS and JS and
        // loads nothing from the network, so it runs in the strictest sandbox.
        _meta: { ui: { prefersBorder: false } },
      },
      () => ({ contents: [{ uri: app.uri, mimeType: APP_MIME, text: app.html }] }),
    );
  }
}

const uiMeta = (resourceUri: string) => ({ ui: { resourceUri, visibility: ["model", "app"] } });

/** `_meta` a tool carries to render its result through one of the apps. */
export const TIMELINE_UI_META = uiMeta(TIMELINE_URI);
export const OVERVIEW_UI_META = uiMeta(OVERVIEW_URI);
