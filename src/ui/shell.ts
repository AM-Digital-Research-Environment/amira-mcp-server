// Shared chassis for every MCP App this server serves: the DRE design tokens,
// the host bridge, and the page assembler. Each app supplies only its own CSS
// and a render function.
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

/** DRE theme tokens + base typography, shared by every app. */
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
 * Host bridge: the MCP Apps postMessage dialect, reduced to the one thing an
 * app here needs — "call me with the tool result". Handles ui/initialize, the
 * theme from hostContext, and hosts that forward only the content array.
 */
declare const __APP_BRIDGE__: string;
export const BRIDGE_JS = __APP_BRIDGE__;

/** Assemble a complete, self-contained app page. */
export function page(title: string, css: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${SHELL_CSS}${css}</style>
</head>
<body>
<div class="wrap" id="root"><p class="empty">Waiting for research data…</p></div>
<p id="app-status" role="status" aria-live="polite"></p>
<script>${BRIDGE_JS}</script>
<script>${script}</script>
</body>
</html>
`;
}

/**
 * Filter pickers: dropdowns and suggestion lists whose options the app fetches
 * itself through allowlisted tools, so the lists never enter the model's
 * context. Until a list arrives, or when the host refuses the call, a field is
 * the plain text input it replaces, so typing a value always works.
 *
 * A field is `{ name, kind, any, current, maxlength, placeholder }`: kind
 * "select" becomes a dropdown (with `any` as its empty choice) once its list
 * loads; kind "suggest" stays a text field with a datalist. An option is
 * `{ value, label?, alt? }`; `current` matches value or alt, ignoring case, and
 * a current value the list lacks is kept as its own option.
 */
export const PICKER_JS = String.raw`
var pickerLists = {};
/** Every page of a list tool, fetched once per key. Resolves null if the call fails. */
function pickerLoad(key, tool, args, pick, order) {
  if (!(key in pickerLists)) pickerLists[key] = (async function () {
    var out = [], offset = 0, pages = 0, d;
    do {
      d = await window.amiraApp.callTool(tool, Object.assign({}, args, { offset: offset }), { quiet: true });
      (d.results || []).forEach(function (r) { var o = pick(r); if (o) out.push(o); });
      offset = d.next_offset;
    } while (d.has_more && offset != null && ++pages < 10);
    return order ? out.sort(order) : out;
  })().then(function (list) { return pickerLists[key] = list; }, function () { return pickerLists[key] = null; });
  return Promise.resolve(pickerLists[key]);
}
/** A loaded list, or null while it is pending or after it failed. */
function pickerNow(key) { return Array.isArray(pickerLists[key]) ? pickerLists[key] : null; }
function pickerOptions(list, hit) {
  var esc = window.amiraApp.esc;
  return list.map(function (o) {
    return '<option value="' + esc(o.value) + '"' + (hit && hit(o) ? " selected" : "") + ">" + esc(o.label || o.value) + "</option>";
  }).join("");
}
function pickerField(p, list) {
  var esc = window.amiraApp.esc, cur = p.current == null ? "" : String(p.current), low = cur.toLowerCase();
  if (p.kind === "select" && list) {
    var hit = function (o) { return !!low && (o.value.toLowerCase() === low || (o.alt || "").toLowerCase() === low); };
    return '<select name="' + p.name + '"><option value="">' + esc(p.any) + "</option>" +
      (cur && !list.some(hit) ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + "</option>" : "") +
      pickerOptions(list, hit) + "</select>";
  }
  var suggest = p.kind === "suggest";
  return '<input name="' + p.name + '" maxlength="' + (p.maxlength || 1000) + '" value="' + esc(cur) + '"' +
    (p.placeholder ? ' placeholder="' + esc(p.placeholder) + '"' : "") +
    (suggest ? ' list="' + p.name + '-options" autocomplete="off"' : "") + ">" +
    (suggest ? '<datalist id="' + p.name + '-options">' + pickerOptions(list || []) + "</datalist>" : "");
}
/** Choose the option marked selected explicitly: happy-dom, the DOM the renderer
 * tests run in, misreads a parsed selected attribute. A no-op in browsers. */
function pickerSettle(el) {
  var marked = el && el.tagName === "SELECT" && el.querySelector("option[selected]");
  if (marked) el.value = marked.value;
  return el;
}
/** Upgrade a field rendered from list shown (null while pending) once load
 * resolves. A field the page has since re-rendered, or a dropdown the reader is
 * using, is left alone. */
function pickerMount(p, load, shown) {
  var el = pickerSettle(document.querySelector('[name="' + p.name + '"]'));
  load.then(function (list) {
    if (!list || list === shown || !el || !el.isConnected) return;
    if (p.kind === "suggest") { var options = document.getElementById(p.name + "-options"); if (options) options.innerHTML = pickerOptions(list); return; }
    if (el === document.activeElement) return;
    var holder = document.createElement("div");
    holder.innerHTML = pickerField(Object.assign({}, p, { current: el.value }), list);
    var next = holder.firstChild;
    el.replaceWith(next);
    pickerSettle(next);
  });
}
`;

/**
 * A horizontal ranked-bar chart as an SVG string, drawn from `[label, value]`
 * rows. Single series, so the fill carries no identity; the value is direct-
 * labelled at the end of each bar, which doubles as the accessible text
 * alternative and removes the need for an x-axis.
 */
export const BAR_CHART_JS = String.raw`
function barChart(rows, opts) {
  opts = opts || {};
  var esc = window.amiraApp.esc;
  if (!rows.length) return '<p class="empty">No data.</p>';
  var ROW = 20, GAP = 2, LABEL_W = opts.labelWidth || 132, VALUE_W = 44, PAD_R = 4;
  var W = 460, H = rows.length * (ROW + GAP);
  var max = rows.reduce(function (m, r) { return Math.max(m, r[1]); }, 0) || 1;
  var trackW = W - LABEL_W - VALUE_W - PAD_R;
  var out = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' +
    esc(opts.label || "ranked bar chart") + '" preserveAspectRatio="xMinYMin meet">'];
  rows.forEach(function (r, i) {
    var y = i * (ROW + GAP);
    var w = Math.max(1.5, (r[1] / max) * trackW);
    out.push('<text class="axis" x="' + (LABEL_W - 8) + '" y="' + (y + ROW / 2 + 3.5) +
      '" text-anchor="end">' + esc(r[0]) + "</text>");
    // 4px rounded data-end, anchored to the baseline at x = LABEL_W.
    out.push('<rect class="bar" x="' + LABEL_W + '" y="' + (y + 3) + '" width="' + w.toFixed(1) +
      '" height="' + (ROW - 6) + '" rx="3"><title>' + esc(r[0]) + ": " + r[1] + "</title></rect>");
    out.push('<text class="val" x="' + (LABEL_W + w + 6).toFixed(1) + '" y="' + (y + ROW / 2 + 3.5) +
      '">' + r[1] + "</text>");
  });
  out.push("</svg>");
  return out.join("");
}
`;
