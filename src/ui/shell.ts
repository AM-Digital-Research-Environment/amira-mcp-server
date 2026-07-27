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
  color-scheme: light dark;
  --surface: transparent;
  --ink-strong: #33291f;
  --ink: #473e33;
  --ink-muted: #6c6357;
  --border: #dcd6cb;
  --bar: #007a50;
  --bar-hi: #00633f;
  --grid: rgba(0, 0, 0, 0.08);
}
:root[data-theme="dark"] {
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
`;

/**
 * Host bridge: the MCP Apps postMessage dialect, reduced to the one thing an
 * app here needs — "call me with the tool result". Handles ui/initialize, the
 * theme from hostContext, and hosts that forward only the content array.
 */
export const BRIDGE_JS = String.raw`
(function () {
  "use strict";
  var nextId = 1;
  function request(method, params) {
    var id = nextId++;
    window.parent.postMessage({ jsonrpc: "2.0", id: id, method: method, params: params }, "*");
    return new Promise(function (resolve, reject) {
      function handler(event) {
        var d = event.data;
        if (!d || d.id !== id) return;
        window.removeEventListener("message", handler);
        if (d.error) reject(new Error(d.error.message || "host error"));
        else resolve(d.result);
      }
      window.addEventListener("message", handler);
    });
  }
  function notify(method, params) {
    window.parent.postMessage({ jsonrpc: "2.0", method: method, params: params || {} }, "*");
  }
  window.amiraApp = {
    esc: function (s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    },
    onResult: function (render) {
      window.addEventListener("message", function (event) {
        if (!event.data || event.data.method !== "ui/notifications/tool-result") return;
        var p = event.data.params || {};
        var payload = p.structuredContent;
        if (!payload && p.content && p.content[0] && p.content[0].text) {
          try { payload = JSON.parse(p.content[0].text); } catch (e) { payload = null; }
        }
        if (payload) render(payload);
      });
      request("ui/initialize", {
        protocolVersion: "2026-01-26",
        capabilities: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } },
        clientInfo: { name: "amira-mcp-app", version: "1.0.0" },
      })
        .then(function (result) {
          var ctx = result && result.hostContext;
          if (ctx && ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
          notify("ui/notifications/initialized", {});
        })
        .catch(function () {
          // No host bridge (opened directly, or a client without the extension):
          // stay quiet and render if a result arrives anyway.
          notify("ui/notifications/initialized", {});
        });
    },
  };
})();
`;

/** Assemble a complete, self-contained app page. */
export function page(title: string, css: string, script: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>${SHELL_CSS}${css}</style>
</head>
<body>
<div class="wrap" id="root"></div>
<script>${BRIDGE_JS}</script>
<script>${script}</script>
</body>
</html>
`;
}

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
