// MCP Apps (extension `io.modelcontextprotocol/ui`, SEP-1865): the interactive
// UI this server offers. A tool opts in by carrying `_meta.ui.resourceUri`;
// hosts that do not implement the extension ignore that `_meta` and keep the
// plain JSON result, so declaring it is safe on every surface.
//
// ONE resource renders every tool's view (src/ui/page.ts explains why: a
// resource per view meant a copy of the Apps SDK per view). It is registered
// only when at least one tool that renders it survives the active profile.
import { APP_HTML } from "../ui/assets.js";
import { APP_TOOLS, APP_URI } from "../ui/viewContract.js";
import type { Server } from "./_shared.js";

/** MIME type the extension requires for a UI resource. */
const APP_MIME = "text/html;profile=mcp-app";

const APP = {
  name: "amira-app",
  title: "AMIRA research views",
  description:
    "Interactive views of seven tools: collection overview, coverage timeline, research sections by funding phase, " +
    "co-occurrence hub, entity graph, research places map and cluster bibliography.",
};

export function registerAppResources(
  server: Server,
  toolEnabled: (name: string) => boolean = () => true,
  opts: { guidance?: boolean } = {},
): void {
  if (!APP_TOOLS.some((tool) => toolEnabled(tool))) return;
  server.registerResource(
    APP.name,
    APP_URI,
    {
      // AMIRA_GUIDANCE=off: no title or description (src/guidance.ts).
      ...(opts.guidance ?? true ? { title: APP.title, description: APP.description } : {}),
      mimeType: APP_MIME,
      // No csp domains: the page inlines all of its CSS and JS and loads
      // nothing from the network, so it runs in the strictest sandbox.
      _meta: { ui: { prefersBorder: false } },
    },
    () => ({ contents: [{ uri: APP_URI, mimeType: APP_MIME, text: APP_HTML, _meta: { ui: { prefersBorder: false } } }] }),
  );
}

/** `_meta` every app-rendering tool carries; the app picks the view itself. */
export const APP_UI_META = { ui: { resourceUri: APP_URI, visibility: ["model", "app"] } };
