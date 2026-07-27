// MCP App: the collection's coverage-over-time histogram, rendered inline in
// the conversation (MCP Apps extension `io.modelcontextprotocol/ui`, SEP-1865;
// supported by Claude and Claude Desktop since 2026-01-26).
//
// It is the visual counterpart of `list_years`: the same payload the tool
// already returns, drawn instead of read. Self-contained by construction — no
// external scripts, styles, fonts or tiles — so the resource needs no
// `_meta.ui.csp` domains and works in the strictest sandbox.
//
// Read-only on purpose: the app renders what the tool returned and does not
// call back into the server. That keeps the prototype's trust surface at zero
// while proving the whole contract (resource → tool `_meta.ui.resourceUri` →
// `ui/initialize` → `ui/notifications/tool-result`).

export const TIMELINE_URI = "ui://amira/timeline";

export const TIMELINE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AMIRA — coverage over time</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: transparent;
    --fg: #1b1b1f;
    --muted: #6b6b76;
    --bar: #7a3e2f;
    --bar-hi: #a8543f;
    --grid: rgba(0, 0, 0, 0.09);
  }
  :root[data-theme="dark"] {
    --fg: #ececf1;
    --muted: #a0a0ad;
    --bar: #c2705a;
    --bar-hi: #e0917a;
    --grid: rgba(255, 255, 255, 0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { padding: 12px 14px 6px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0 0 2px; }
  .sub { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
  .chart { width: 100%; overflow-x: auto; }
  svg { display: block; width: 100%; height: auto; }
  .bar { fill: var(--bar); }
  .bar:hover { fill: var(--bar-hi); }
  .axis { fill: var(--muted); font-size: 10px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .legend { color: var(--muted); font-size: 11px; margin: 6px 0 0; }
  .empty { color: var(--muted); padding: 18px 0; }
</style>
</head>
<body>
<div class="wrap">
  <h1 id="title">AMIRA — coverage over time</h1>
  <p class="sub" id="sub">Waiting for data…</p>
  <div class="chart" id="chart"></div>
  <p class="legend" id="legend"></p>
</div>
<script>
(function () {
  "use strict";

  // --- host bridge (postMessage JSON-RPC, MCP Apps dialect) ------------------
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
  function onNotification(method, cb) {
    window.addEventListener("message", function (event) {
      if (event.data && event.data.method === method) cb(event.data.params);
    });
  }

  // --- rendering -------------------------------------------------------------
  var W = 720, H = 240, PAD_L = 40, PAD_R = 8, PAD_T = 10, PAD_B = 26;

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function render(payload) {
    var chart = document.getElementById("chart");
    var rows = (payload && payload.results) || [];
    if (!rows.length) {
      chart.innerHTML = '<p class="empty">No dated items in this range.</p>';
      return;
    }
    var isDecade = payload.bucket === "decade";
    // list_years may be sorted by count; a timeline must read left-to-right.
    var data = rows
      .map(function (r) {
        return { key: isDecade ? r.from : r.year, label: isDecade ? r.decade : String(r.year), n: r.item_count };
      })
      .sort(function (a, b) { return a.key - b.key; });

    var max = data.reduce(function (m, d) { return Math.max(m, d.n); }, 0) || 1;
    var innerW = W - PAD_L - PAD_R;
    var innerH = H - PAD_T - PAD_B;
    var step = innerW / data.length;
    var barW = Math.max(1, step - (step > 6 ? 2 : 0.5));

    var parts = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Items per ' +
      (isDecade ? "decade" : "year") + '" preserveAspectRatio="xMidYMid meet">'];

    // y grid + labels at 0, half, max
    [0, 0.5, 1].forEach(function (f) {
      var y = PAD_T + innerH - f * innerH;
      parts.push('<line class="grid" x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" />');
      parts.push('<text class="axis" x="' + (PAD_L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' +
        Math.round(f * max) + "</text>");
    });

    data.forEach(function (d, i) {
      var h = (d.n / max) * innerH;
      var x = PAD_L + i * step;
      var y = PAD_T + innerH - h;
      parts.push('<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + Math.max(h, 0.6).toFixed(1) + '"><title>' + esc(d.label) + ": " + d.n +
        (d.n === 1 ? " item" : " items") + "</title></rect>");
    });

    // x labels: first, last and a few evenly spaced between, without collisions
    var maxLabels = Math.max(2, Math.floor(innerW / 46));
    var every = Math.ceil(data.length / maxLabels);
    data.forEach(function (d, i) {
      if (i % every !== 0 && i !== data.length - 1) return;
      var x = PAD_L + i * step + barW / 2;
      parts.push('<text class="axis" x="' + x.toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle">' +
        esc(d.label) + "</text>");
    });

    parts.push("</svg>");
    chart.innerHTML = parts.join("");

    var range = payload.year_range ? payload.year_range.min + "–" + payload.year_range.max : "";
    document.getElementById("sub").textContent =
      payload.dated_items + " dated items" + (range ? " spanning " + range : "") +
      (payload.undated_items ? " · " + payload.undated_items + " undated" : "");
    document.getElementById("title").textContent =
      "AMIRA — research items per " + (isDecade ? "decade" : "year");
    document.getElementById("legend").textContent =
      "An item whose content date is a range counts toward every " + (isDecade ? "decade" : "year") +
      " it spans, so the bars can sum to more than the item total.";
  }

  function applyTheme(ctx) {
    if (ctx && ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
  }

  onNotification("ui/notifications/tool-result", function (params) {
    // Prefer structuredContent; fall back to parsing the JSON text block, which
    // is what a host that only forwards the content array will carry.
    var payload = params && params.structuredContent;
    if (!payload && params && params.content && params.content[0] && params.content[0].text) {
      try { payload = JSON.parse(params.content[0].text); } catch (e) { payload = null; }
    }
    if (payload) render(payload);
  });

  request("ui/initialize", {
    protocolVersion: "2026-01-26",
    capabilities: { appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } },
    clientInfo: { name: "amira-timeline", version: "1.0.0" },
  })
    .then(function (result) {
      applyTheme(result && result.hostContext);
      notify("ui/notifications/initialized", {});
    })
    .catch(function () {
      // No host bridge (opened directly, or an unsupporting client): the page
      // still renders as soon as a tool result arrives, so fail quietly.
      notify("ui/notifications/initialized", {});
    });
})();
</script>
</body>
</html>
`;
