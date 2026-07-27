// MCP App: the collection at a glance — the visual form of
// get_collection_overview, the tool everyone calls first.
//
// Form follows the data's job (dataviz procedure step 1): the headline counts
// are single values, so they are STAT TILES, not a chart; the four breakdowns
// are magnitude-by-category, so they are ranked horizontal bars, as small
// multiples. Every chart is single-series — the category sits on the axis
// label — so one validated accent is correct and no legend is needed.
//
// Degrades by exposure level: under AMIRA_EXPOSURE below `structured` the
// relational breakdowns are absent from the payload, so the app renders the
// tiles and whatever survives rather than erroring.

import { BAR_CHART_JS, page } from "./shell.js";

export const OVERVIEW_URI = "ui://amira/overview";

const CSS = String.raw`
.tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
.tile {
  flex: 1 1 96px; min-width: 96px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 6px;
}
.tile .n {
  display: block; font-size: 19px; font-weight: 650; line-height: 1.15;
  color: var(--ink-strong); font-variant-numeric: tabular-nums;
}
.tile .k { display: block; font-size: 11px; color: var(--ink-muted); margin-top: 1px; }
.tile .sub2 { display: block; font-size: 10px; color: var(--ink-muted); margin-top: 2px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px 20px; }
.panel { min-width: 0; }
`;

const SCRIPT =
  BAR_CHART_JS +
  String.raw`
var esc = window.amiraApp.esc;

/** Top-N of an object map, biggest first, with the tail folded into "Other". */
function topRows(map, n) {
  var rows = Object.keys(map || {})
    .map(function (k) { return [k, map[k]]; })
    .filter(function (r) { return r[1] > 0; })
    .sort(function (a, b) { return b[1] - a[1]; });
  if (rows.length <= n) return rows;
  var head = rows.slice(0, n);
  var tail = rows.slice(n).reduce(function (s, r) { return s + r[1]; }, 0);
  if (tail > 0) head.push(["Other (" + (rows.length - n) + ")", tail]);
  return head;
}

/** Shorten the long university labels so they fit the axis gutter. */
function shortenUniversity(label) {
  return String(label)
    .replace("Université Joseph Ki-Zerbo", "Joseph Ki-Zerbo")
    .replace("Federal University of Bahia", "Bahia")
    .replace("University of Bayreuth", "Bayreuth")
    .replace("University of Lagos", "Lagos")
    .replace("External collection", "External");
}

function tile(n, label, sub) {
  if (n == null) return "";
  return '<div class="tile"><span class="n">' + n.toLocaleString("en") + '</span>' +
    '<span class="k">' + esc(label) + "</span>" +
    (sub ? '<span class="sub2">' + esc(sub) + "</span>" : "") + "</div>";
}

function panel(title, rows, labelWidth) {
  if (!rows.length) return "";
  return '<section class="panel"><h2>' + esc(title) + "</h2>" +
    barChart(rows, { label: title, labelWidth: labelWidth }) + "</section>";
}

function render(d) {
  var c = d.counts || {};
  var withText = function (part, whole) {
    return part == null || !whole ? null : part + " of " + whole + " with text";
  };

  var tiles = [
    tile(c.research_items, "research items"),
    tile(c.projects, "projects"),
    tile(c.persons, "people"),
    tile(c.institutions, "institutions"),
    tile(c.publications, "publications", withText(c.publications_with_fulltext, c.publications)),
    tile(c.youtube_videos, "videos", withText(c.videos_with_transcript, c.youtube_videos)),
    tile(c.podcasts, "podcast episodes", withText(c.podcasts_with_transcript, c.podcasts)),
    tile(c.journals, "journals"),
  ].join("");

  var byUni = topRows(d.items_by_university, 6).map(function (r) { return [shortenUniversity(r[0]), r[1]]; });
  var charts = [
    panel("Items by university", byUni, 118),
    panel("Items by research section", topRows(d.items_by_research_section, 8), 132),
    panel("Items by resource type", topRows(d.items_by_resource_type, 8), 118),
    panel("Items by language", topRows(d.items_by_language, 8), 110),
  ].join("");

  var range = d.content_date_range
    ? "Content dates span " + d.content_date_range.earliest + "–" + d.content_date_range.latest + ". "
    : "";
  var snap = d.data_snapshot
    ? "Snapshot: " + esc(d.data_snapshot.source) + ", fetched " + String(d.data_snapshot.fetched_at).slice(0, 10) + "."
    : "";
  var gated = d.metadata_exposure
    ? " Metadata exposure is limited to '" + esc(d.metadata_exposure) + "', so some breakdowns are withheld."
    : "";

  document.getElementById("root").innerHTML =
    "<h1>" + esc(d.collection_name || "AMIRA collection") + "</h1>" +
    '<p class="sub">' + range + snap + gated + "</p>" +
    '<div class="tiles">' + tiles + "</div>" +
    (charts ? '<div class="charts">' + charts + "</div>"
            : '<p class="empty">No breakdowns available at this metadata-exposure level.</p>') +
    '<p class="note">Counts are of the curated collection, not of African research at large; ' +
    "coverage is uneven and skews toward a few large collections.</p>";
}

window.amiraApp.onResult(render);
`;

export const OVERVIEW_HTML = page("AMIRA — collection at a glance", CSS, SCRIPT);
