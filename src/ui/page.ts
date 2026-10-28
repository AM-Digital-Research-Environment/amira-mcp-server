// The one AMIRA app page, ui://amira/app.html, assembled at BUILD time by
// scripts/build.mjs (which bundles this module for node and calls appPage with
// the freshly built bridge). The server never imports it: it serves the
// finished string, injected as __APP_HTML__.
//
// ONE page renders all seven views. A `ui://` resource is a standalone
// document that shares nothing with its siblings, so seven resources meant
// seven copies of the Apps SDK and zod, 650 KB each and 4.7 MB in all, for
// renderers of 3-20 KB. Tools may all point at the same resource, so the suite
// now costs one copy. The price is a router: the page has to know which view
// a result belongs to. The host's `toolInfo` (McpUiHostContext) names the
// tool that opened the app; a host that sends none is answered from the
// result's shape, which differs across the seven tools. A view's own
// follow-up calls (filters, paging, re-centring) re-render that view directly
// and never pass through the router.
//
// SIZE. Two steps, both from the IWAC server (mcpb/scripts/bundle.mjs):
//   * zod's 50 non-English error catalogues are stubbed out of the bridge
//     bundle (scripts/build.mjs), 258 KB of strings that can never fire;
//   * the decoded script (bridge + views) is gzip-compressed into an inert
//     data element and expanded by a 1 KB bootstrap with the browser's own
//     DecompressionStream. No network, eval, blob URL or CSP grant is needed:
//     the decoded source becomes an ordinary inline script, under the same
//     script-src policy as the inline scripts it replaces, and base64 cannot
//     contain a closing script tag. test/unit/apps.test.mjs gates both sizes.
//
// CSS stays plain text in the head, so the page is themed before the script
// runs. Each view's CSS is scoped to `[data-view="<name>"]`, which the router
// sets on #root: the map's fixed table widths must not reach the graph's table.
import { gzipSync } from "node:zlib";
import { BIBLIOGRAPHY_VIEW } from "./bibliography.js";
import { GRAPH_VIEW } from "./graph.js";
import { MAP_VIEW } from "./map.js";
import { OVERVIEW_VIEW } from "./overview.js";
import { RELATED_VIEW } from "./related.js";
import { SECTIONS_VIEW } from "./sections.js";
import { BAR_CHART_JS, PICKER_JS, SELECTION_JS, SHELL_CSS, scopeCss, type AppView } from "./shell.js";
import { TIMELINE_VIEW } from "./timeline.js";
import { VIEW_OF_TOOL } from "./viewContract.js";

export const VIEWS: readonly AppView[] = [
  OVERVIEW_VIEW, TIMELINE_VIEW, SECTIONS_VIEW, RELATED_VIEW, GRAPH_VIEW, MAP_VIEW, BIBLIOGRAPHY_VIEW,
];

const ROUTER_JS = String.raw`
var amiraRoot = document.getElementById("root");
/** The view for a result: the host's toolInfo first, else the result's shape. */
function amiraViewFor(payload) {
  var named = amiraViewOfTool[window.amiraApp.toolName() || ""];
  if (named) return named;
  var d = payload || {};
  if (Array.isArray(d.nodes) && Array.isArray(d.edges)) return "graph";
  if ("entity_type" in d && "matched_items" in d) return "related";
  if (d.counts && typeof d.counts === "object" && !("results" in d)) return "overview";
  if ("bucket" in d && "dated_items" in d) return "timeline";
  if ("items_without_place" in d) return "map";
  if (Array.isArray(d.results) && "total_matches" in d) return "bibliography";
  if (Array.isArray(d.results)) return "sections";
  return null;
}
window.amiraApp.onResult(function (payload) {
  var name = amiraViewFor(payload), view = name && amiraViews[name];
  if (!view) {
    amiraRoot.removeAttribute("data-view");
    amiraRoot.innerHTML = '<p class="empty">This result has no AMIRA view. Update the AMIRA extension to see it here; the answer in the conversation is unaffected.</p>';
    return;
  }
  if (amiraRoot.dataset.view !== name) {
    amiraRoot.onclick = amiraRoot.onkeydown = amiraRoot.onchange = null;
    amiraRoot.dataset.view = name;
    document.title = view.title;
  }
  view.render(payload);
});
`;

/** Shared helpers, then each view in its own scope, then the router. */
export function viewsScript(): string {
  return [
    PICKER_JS,
    BAR_CHART_JS,
    SELECTION_JS,
    "var amiraViews = {};",
    ...VIEWS.map((view) =>
      `amiraViews[${JSON.stringify(view.name)}] = { title: ${JSON.stringify(view.title)}, render: (function () {\n${view.script}\nreturn render;\n})() };`),
    `var amiraViewOfTool = ${JSON.stringify(VIEW_OF_TOOL)};`,
    ROUTER_JS,
  ].join("\n");
}

/** Expand the gzip data element into an inline script. */
const BOOTSTRAP = `(async () => {
  const data = document.getElementById("amira-app-bundle");
  try {
    if (typeof DecompressionStream !== "function") throw new Error("This host cannot decode gzip.");
    const bytes = Uint8Array.from(atob(data.textContent.trim()), (c) => c.charCodeAt(0));
    const source = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
    const script = document.createElement("script");
    script.textContent = source;
    document.body.appendChild(script);
    data.remove();
  } catch (error) {
    const root = document.getElementById("root");
    root.textContent = "The AMIRA app could not start in this host. The tool result in the conversation is unaffected.";
    root.setAttribute("role", "alert");
    console.error("[amira] app startup failed", error);
  }
})();`;

export interface AppPage {
  html: string;
  /** The decoded script: the bridge, a newline, then viewsScript(). */
  script: string;
  gzipBytes: number;
}

/**
 * `minify` (esbuild's transform, passed in by scripts/build.mjs) compacts the
 * views script's whitespace and syntax. Identifiers stay as written: the views
 * share globals (pickerLoad, selectionControls) and the tests read
 * `api.<member>` uses.
 */
export function appPage(bridgeJs: string, minify: (js: string) => string = (js) => js): AppPage {
  const script = `${bridgeJs}\n${minify(viewsScript())}`;
  const compressed = gzipSync(script, { level: 9 });
  const css = SHELL_CSS + VIEWS.map((view) => scopeCss(`[data-view="${view.name}"]`, view.css)).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AMIRA research data</title>
<style>${css}</style>
</head>
<body>
<div class="wrap" id="root"><p class="empty">Waiting for research data…</p></div>
<p id="app-status" role="status" aria-live="polite"></p>
<script id="amira-app-bundle" type="application/gzip">${compressed.toString("base64")}</script>
<script>${BOOTSTRAP}</script>
</body>
</html>
`;
  return { html, script, gzipBytes: compressed.length };
}
