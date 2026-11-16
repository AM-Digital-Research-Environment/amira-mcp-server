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
import { SHELL_CSS, scopeCss, type AppView } from "./shell.js";
import { TIMELINE_VIEW } from "./timeline.js";
import { VIEW_OF_TOOL } from "./viewContract.js";

export const VIEWS: readonly AppView[] = [
  OVERVIEW_VIEW, TIMELINE_VIEW, SECTIONS_VIEW, RELATED_VIEW, GRAPH_VIEW, MAP_VIEW, BIBLIOGRAPHY_VIEW,
];

/** The helpers every view may call (classic script, top level of the views script). */
const SHARED_FILE = "_shared.js";
/** The router, after the views: hands each result to the view that renders it. */
const ROUTER_FILE = "_router.js";
/** The page's plain inline script, which expands the gzip data element. */
const BOOTSTRAP_FILE = "_bootstrap.js";

/** A view's script as written in src/ui/views/, without the `export { render }`
 * that makes the file a module for its typecheck and lint. */
function viewSource(view: AppView, read: (file: string) => string): string {
  const source = read(view.file).replace(/\nexport \{ render \};\s*$/, "\n");
  if (/^export /m.test(source)) throw new Error(`${view.file}: only the final \`export { render }\` is allowed`);
  return view.prepare ? view.prepare(source) : source;
}

/** A classic-script file of src/ui/views/ (the shared helpers, the router): it
 * must not be a module, since its top-level names are the views' globals. */
function scriptSource(file: string, read: (file: string) => string): string {
  const source = read(file);
  if (/^(?:export|import) /m.test(source)) throw new Error(`${file}: a classic script, no import or export`);
  return source;
}

/** Shared helpers, then each view in its own scope, then the router. `read`
 * returns a file of src/ui/views/ (scripts/build.mjs passes it). */
export function viewsScript(read: (file: string) => string): string {
  return [
    scriptSource(SHARED_FILE, read),
    "var amiraViews = {};",
    ...VIEWS.map((view) =>
      `amiraViews[${JSON.stringify(view.name)}] = { title: ${JSON.stringify(view.title)}, render: (function () {\n${viewSource(view, read)}\nreturn render;\n})() };`),
    `var amiraViewOfTool = ${JSON.stringify(VIEW_OF_TOOL)};`,
    scriptSource(ROUTER_FILE, read),
  ].join("\n");
}

export interface AppPage {
  html: string;
  /** The decoded script: the bridge, a newline, then viewsScript(). */
  script: string;
  gzipBytes: number;
}

/**
 * `minify` (esbuild's transform, passed in by scripts/build.mjs) compacts the
 * whitespace and syntax of the views script and of the bootstrap. Identifiers
 * stay as written: the views share globals (pickerLoad, selectionControls) and
 * the tests read `api.<member>` uses.
 */
export function appPage(bridgeJs: string, read: (file: string) => string, minify: (js: string) => string = (js) => js): AppPage {
  const script = `${bridgeJs}\n${minify(viewsScript(read))}`;
  const bootstrap = minify(scriptSource(BOOTSTRAP_FILE, read)).trim();
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
<script>${bootstrap}</script>
</body>
</html>
`;
  return { html, script, gzipBytes: compressed.length };
}
