// MCP App: the cluster's research sections as a funding-phase Gantt — the
// visual form of list_research_sections. Mirrors the "Gantt (project spans)"
// chart the DREVisualizations module renders on the AMIRA site.
//
// The chart exists to make ONE thing obvious that the JSON states but does not
// show: the cluster redefined its sections between AM 1.0 (2019–2025) and
// AM 2.0 (2026–2032), so a reader who treats the section list as one flat set
// mis-reads it — the AM 2.0 sections are seeded and hold ~0 items. Position on
// a shared time axis makes the two cohorts, and where "now" falls between them,
// legible at a glance.
//
// Single series: the phase is a row group with its own heading, so it needs no
// second hue and no legend.

import { page } from "./shell.js";

export const SECTIONS_URI = "ui://amira/sections";

const CSS = String.raw`
.chart { width: 100%; overflow-x: auto; }
.phase { fill: var(--ink-strong); font-size: 11px; font-weight: 650; }
.now { stroke: var(--ink-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.nowlab { fill: var(--ink-muted); font-size: 9px; }
.rowname { fill: var(--ink); font-size: 11px; }
`;

const SCRIPT = String.raw`
var esc = window.amiraApp.esc;
var W = 640, PAD_L = 150, PAD_R = 58, PAD_T = 22, ROW = 22, GROUP_GAP = 26;

function year(s) {
  var n = parseInt(String(s || "").slice(0, 4), 10);
  return isFinite(n) && n > 0 ? n : null;
}

function render(payload) {
  var root = document.getElementById("root");
  var rows = (payload && payload.results) || [];
  if (!rows.length) {
    root.innerHTML = "<h1>Research sections</h1><p class=\"empty\">No sections returned.</p>";
    return;
  }

  // Group by funding phase; sections without a phase (the synthetic "External"
  // grouping) have no span to draw, so they are listed, not plotted.
  var groups = {}, order = [], undated = [];
  rows.forEach(function (r) {
    var from = year(r.date && r.date.start), to = year(r.date && r.date.end);
    if (from == null || to == null) { undated.push(r); return; }
    // fundingPhase() returns null only for the synthetic "External" grouping.
    var key = r.funding_phase || "Outside the funding phases";
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push({ r: r, from: from, to: to });
  });
  order.sort(); // "AM 1.0 (2019–2032)" sorts before "AM 2.0 (…)"

  var plotted = order.reduce(function (n, k) { return n + groups[k].length; }, 0);
  if (!plotted) {
    root.innerHTML = "<h1>Research sections</h1><p class=\"empty\">No section carries a date range.</p>";
    return;
  }

  var minY = Infinity, maxY = -Infinity;
  order.forEach(function (k) {
    groups[k].forEach(function (g) { minY = Math.min(minY, g.from); maxY = Math.max(maxY, g.to); });
  });
  minY = Math.floor(minY / 2) * 2;
  maxY = Math.ceil((maxY + 1) / 2) * 2;

  var H = PAD_T + plotted * ROW + order.length * GROUP_GAP + 24;
  var trackW = W - PAD_L - PAD_R;
  var x = function (y) { return PAD_L + ((y - minY) / (maxY - minY)) * trackW; };

  var out = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" ' +
    'aria-label="Research sections by funding phase, ' + minY + " to " + maxY + '" preserveAspectRatio="xMinYMin meet">'];

  // Year gridlines every two years, recessive.
  for (var yr = minY; yr <= maxY; yr += 2) {
    out.push('<line class="grid" x1="' + x(yr).toFixed(1) + '" y1="' + (PAD_T - 8) + '" x2="' + x(yr).toFixed(1) +
      '" y2="' + (H - 20) + '" />');
    out.push('<text class="axis" x="' + x(yr).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + yr + "</text>");
  }

  var cy = PAD_T;
  order.forEach(function (key) {
    out.push('<text class="phase" x="0" y="' + (cy + 2) + '">' + esc(key) + "</text>");
    cy += 12;
    groups[key]
      .sort(function (a, b) { return a.from - b.from || a.r.name.localeCompare(b.r.name); })
      .forEach(function (g) {
        var x0 = x(g.from), x1 = Math.max(x(g.to), x0 + 3);
        out.push('<text class="rowname" x="' + (PAD_L - 8) + '" y="' + (cy + ROW / 2 + 3.5) +
          '" text-anchor="end">' + esc(g.r.name) + "</text>");
        out.push('<rect class="bar" x="' + x0.toFixed(1) + '" y="' + (cy + 4) + '" width="' + (x1 - x0).toFixed(1) +
          '" height="' + (ROW - 8) + '" rx="3"><title>' + esc(g.r.name) + ": " + g.from + "–" + g.to +
          " · " + (g.r.project_count || 0) + " projects · " + (g.r.item_count || 0) + " items</title></rect>");
        // Direct-label the item count — the number a reader actually wants.
        out.push('<text class="val" x="' + (x1 + 6).toFixed(1) + '" y="' + (cy + ROW / 2 + 3.5) + '">' +
          (g.r.item_count || 0) + "</text>");
        cy += ROW;
      });
    cy += GROUP_GAP - 12;
  });

  // "Now" marker: where the cluster currently sits between the two phases.
  var now = new Date().getFullYear();
  if (now >= minY && now <= maxY) {
    out.push('<line class="now" x1="' + x(now).toFixed(1) + '" y1="' + (PAD_T - 12) + '" x2="' + x(now).toFixed(1) +
      '" y2="' + (H - 20) + '" />');
    out.push('<text class="nowlab" x="' + (x(now) + 4).toFixed(1) + '" y="' + (PAD_T - 14) + '">now</text>');
  }
  out.push("</svg>");

  var tail = undated.length
    ? " " + undated.length + " section" + (undated.length === 1 ? "" : "s") + " without a date range (" +
      undated.map(function (r) { return esc(r.name); }).join(", ") + ") are not plotted."
    : "";
  root.innerHTML =
    "<h1>Research sections by funding phase</h1>" +
    '<p class="sub">' + plotted + " sections plotted; the number after each bar is its digitised item count." + tail + "</p>" +
    '<div class="chart">' + out.join("") + "</div>" +
    '<p class="note">The cluster redefined its sections between AM 1.0 and AM 2.0. The AM 2.0 sections are ' +
    "newly seeded, so a near-zero item count there is expected, not missing data.</p>";
}

window.amiraApp.onResult(render);
`;

export const SECTIONS_HTML = page("AMIRA — research sections by funding phase", CSS, SCRIPT);
