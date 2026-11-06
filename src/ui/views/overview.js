// The overview view's script (src/ui/overview.ts names it). Plain browser JavaScript, run
// inside a function scope that returns `render` (src/ui/page.ts viewsScript),
// beside the shared helpers declared in ./globals.d.ts. Type-checked with
// tsconfig.views.json and linted by Biome. The trailing `export { render }`
// makes the file a module for those checks; the page assembler drops it.
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
    barChart(rows, { label: title, labelWidth: labelWidth }) + '<details><summary>Read values</summary><table><tbody>' + rows.map(function(r){return '<tr><th>' + esc(r[0]) + '</th><td>' + r[1] + '</td></tr>';}).join('') + '</tbody></table></details></section>';
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

export { render };
