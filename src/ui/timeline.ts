// MCP App: the collection's coverage-over-time histogram — the visual form of
// list_years. Mirrors the "Timeline (bar by year)" chart the DREVisualizations
// module renders on the AMIRA site, so the chat and the site agree.
//
// Single series (one bar per year), so the accent carries no identity; colours,
// bridge and page chassis all come from ./shell.

import { page } from "./shell.js";

export const TIMELINE_URI = "ui://amira/timeline";

const CSS = String.raw`
.chart { width: 100%; overflow-x: auto; }
`;

const SCRIPT = String.raw`
var esc = window.amiraApp.esc;
var W = 720, H = 240, PAD_L = 40, PAD_R = 8, PAD_T = 10, PAD_B = 26;

function render(payload) {
  var rows = (payload && payload.results) || [];
  var root = document.getElementById("root");
  var isDecade = payload.bucket === "decade";
  var unit = isDecade ? "decade" : "year";

  if (!rows.length) {
    root.innerHTML = "<h1>AMIRA — research items per " + unit + "</h1>" +
      '<p class="empty">No dated items in this range.</p>';
    return;
  }

  // list_years can be sorted by count; a timeline must read left to right.
  var data = rows
    .map(function (r) {
      return { key: isDecade ? r.from : r.year, label: isDecade ? r.decade : String(r.year), n: r.item_count };
    })
    .sort(function (a, b) { return a.key - b.key; });

  var max = data.reduce(function (m, d) { return Math.max(m, d.n); }, 0) || 1;
  var innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  var step = innerW / data.length;
  var barW = Math.max(1, step - (step > 6 ? 2 : 0.5)); // 2px surface gap between bars

  var parts = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Research items per ' +
    unit + '" preserveAspectRatio="xMidYMid meet">'];

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
      '" height="' + Math.max(h, 0.6).toFixed(1) + '" rx="' + (barW > 8 ? 3 : 0) + '"><title>' +
      esc(d.label) + ": " + d.n + (d.n === 1 ? " item" : " items") + "</title></rect>");
  });

  // Selective labels only — never one per bar.
  var every = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 46)));
  data.forEach(function (d, i) {
    if (i % every !== 0 && i !== data.length - 1) return;
    parts.push('<text class="axis" x="' + (PAD_L + i * step + barW / 2).toFixed(1) + '" y="' + (H - 8) +
      '" text-anchor="middle">' + esc(d.label) + "</text>");
  });
  parts.push("</svg>");

  var range = payload.year_range ? " spanning " + payload.year_range.min + "–" + payload.year_range.max : "";
  root.innerHTML =
    "<h1>AMIRA — research items per " + unit + "</h1>" +
    '<p class="sub">' + payload.dated_items + " dated items" + range +
    (payload.undated_items ? " · " + payload.undated_items + " undated" : "") + "</p>" +
    '<div class="chart">' + parts.join("") + "</div>" +
    '<p class="note">An item whose content date is a range counts toward every ' + unit +
    " it spans, so the bars can sum to more than the item total.</p>";
}

window.amiraApp.onResult(render);
`;

export const TIMELINE_HTML = page("AMIRA — coverage over time", CSS, SCRIPT);
