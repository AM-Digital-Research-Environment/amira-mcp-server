// Shared chassis for every AMIRA view: the DRE design tokens and the view
// contract. Each view supplies only its own CSS and a render function;
// src/ui/page.ts assembles them into the one page. The helpers several views
// call (pickers, ranked bars, the selection controls, evidence lists) are
// browser code, so they live beside the views, in src/ui/views/_shared.js.
//
// Extracted when the second app arrived — same reasoning as textWindowFields in
// v1.6.0: two copies of a protocol handshake drift, and the drift is invisible
// until a host changes behaviour.
//
// COLOURS come from the DREVisualizations Omeka module (asset/css/
// dre-visualizations.css + dashboard-core.js), so an app rendered in the chat
// and the same chart rendered on the AMIRA site read as one system. The bar
// fills were then validated against those surfaces rather than eyeballed:
//   light #007a50 on #fdfcfa — lightness band, chroma floor, 3:1 contrast: pass
//   dark  #35a87d on #1b211e — the theme's own #3fb488 sits at L 0.693, just
//         outside the 0.48–0.67 dark band, so this is one step down from it
// Single-series charts throughout: the category is on the axis label, so hue
// carries no identity and one accent is correct (a rainbow here would be the
// classic single-series anti-pattern).

import type { ViewName } from "./viewContract.js";

/** DRE theme tokens + base typography, shared by every view. */
export const SHELL_CSS = String.raw`
:root {
  color-scheme: light;
  --surface: #fdfcfa;
  --ink-strong: #33291f;
  --ink: #473e33;
  --ink-muted: #6c6357;
  --border: #dcd6cb;
  --bar: #007a50;
  --bar-hi: #00633f;
  --grid: rgba(0, 0, 0, 0.08);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface: #1b211e;
  --ink-strong: #f3f1ec;
  --ink: #e3e0d9;
  --ink-muted: #aaa498;
  --border: #39423d;
  --bar: #35a87d;
  --bar-hi: #5cc49d;
  --grid: rgba(255, 255, 255, 0.11);
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--surface);
  color: var(--ink);
  font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wrap { padding: 12px 14px 8px; }
h1 { font-size: 14px; font-weight: 600; color: var(--ink-strong); margin: 0 0 2px; }
h2 { font-size: 12px; font-weight: 600; color: var(--ink-strong); margin: 0 0 6px; }
.sub { color: var(--ink-muted); font-size: 12px; margin: 0 0 12px; }
.note { color: var(--ink-muted); font-size: 11px; margin: 8px 0 0; }
.empty { color: var(--ink-muted); padding: 18px 0; }
svg { display: block; width: 100%; height: auto; }
.bar { fill: var(--bar); }
.bar:hover { fill: var(--bar-hi); }
.axis { fill: var(--ink-muted); font-size: 10px; }
.val { fill: var(--ink); font-size: 10px; font-variant-numeric: tabular-nums; }
.grid { stroke: var(--grid); stroke-width: 1; }
::selection { background: var(--bar); color: #fff; }
:focus-visible { outline: 2px solid var(--bar); outline-offset: 3px; }
a { color: var(--bar); text-underline-offset: 3px; overflow-wrap: anywhere; }
button, input, select { font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 3px; padding: 7px 10px; min-height: 36px; }
button { overflow-wrap: normal; }
button { cursor: pointer; }
button:hover { border-color: var(--bar); }
button:disabled { opacity: .55; cursor: default; }
input { caret-color: var(--bar); min-width: 0; }
.controls { display: flex; gap: 8px; align-items: end; flex-wrap: wrap; margin: 14px 0; }
.controls label { display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; flex: 1; min-width: 110px; }
.controls label select { width: 100%; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
td, th { border-bottom: 1px solid var(--border); padding: 8px 6px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
th { font-weight: 600; }
.scroll { overflow-x: auto; }
details { margin-top: 16px; }
summary { cursor: pointer; padding: 8px 0; }
#app-status { padding: 0 14px; color: var(--ink-muted); }
.evidence { margin-top: 20px; }
@media (max-width: 420px) { .wrap { padding: 12px 10px; } td, th { padding: 7px 3px; } .controls { align-items: stretch; } }
`;

/**
 * One view of the app. Its script (`file`) is plain browser JavaScript that runs in its
 * own function scope, after the bridge and the shared helpers, and must define `function
 * render(payload)`; it reaches the host only through `window.amiraApp`
 * (src/ui/bridge.ts). `css` is scoped to the view by scopeCss, so one view's
 * table widths cannot leak into another's.
 */
export interface AppView {
  name: ViewName;
  /** Document title while the view is shown. */
  title: string;
  css: string;
  /** Its script, in src/ui/views/ (read by scripts/build.mjs, typechecked by tsconfig.views.json). */
  file: string;
  /** A build-time edit of the script (the map view injects its outline). */
  prepare?: (source: string) => string;
}

/**
 * Prefix every selector in `css` with `scope`, recursing into @media blocks.
 * The views' CSS is hand-written and simple (no nested parentheses holding
 * commas, no strings with braces), which this deliberately relies on.
 */
export function scopeCss(scope: string, css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let out = "";
  for (let i = 0; i < source.length;) {
    const open = source.indexOf("{", i);
    if (open < 0) break;
    let depth = 1, close = open + 1;
    for (; close < source.length && depth; close++) {
      if (source[close] === "{") depth++;
      else if (source[close] === "}") depth--;
    }
    const prelude = source.slice(i, open).trim(), body = source.slice(open + 1, close - 1);
    out += prelude.startsWith("@")
      ? `${prelude} { ${scopeCss(scope, body)} }\n`
      : `${prelude.split(",").map((selector) => `${scope} ${selector.trim()}`).join(", ")} { ${body.trim()} }\n`;
    i = close;
  }
  return out;
}
