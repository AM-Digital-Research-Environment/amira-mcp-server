// MCP Apps (extension `io.modelcontextprotocol/ui`, SEP-1865): the interactive
// UI resources this server offers. A tool opts in by carrying
// `_meta.ui.resourceUri` pointing at one of the `ui://` resources below; hosts
// that do not implement the extension ignore that `_meta` and keep the plain
// JSON result, so declaring it is safe on every surface.
//
// Registering a resource makes the server advertise the `resources` capability
// — the UI templates are the only resources it serves.
import { TIMELINE_HTML, TIMELINE_URI } from "../ui/timeline.js";
import type { Server } from "./_shared.js";

/** MIME type the extension requires for a UI resource. */
const APP_MIME = "text/html;profile=mcp-app";

export function registerAppResources(server: Server): void {
  server.registerResource(
    "amira-timeline",
    TIMELINE_URI,
    {
      title: "AMIRA coverage timeline",
      description:
        "Interactive histogram of research items per year or decade — the visual form of list_years.",
      mimeType: APP_MIME,
      // No csp domains: the template inlines all of its CSS and JS and loads
      // nothing from the network, so it runs under the strictest sandbox.
      _meta: { ui: { prefersBorder: false } },
    },
    () => ({
      contents: [{ uri: TIMELINE_URI, mimeType: APP_MIME, text: TIMELINE_HTML }],
    }),
  );
}

/** `_meta` a tool carries to render its result through the timeline app. */
export const TIMELINE_UI_META = { ui: { resourceUri: TIMELINE_URI, visibility: ["model", "app"] } };
