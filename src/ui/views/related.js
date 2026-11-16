// The related view's script (src/ui/related.ts names it). Plain browser JavaScript, run
// inside a function scope that returns `render` (src/ui/page.ts viewsScript),
// beside the shared helpers of ./_shared.js. Type-checked with
// tsconfig.views.json and linted by Biome. The trailing `export { render }`
// makes the file a module for those checks; the page assembler drops it.
const esc = window.amiraApp.esc;
// Geometry, sized so nothing is clipped: an SVG clips to its viewBox, so a
// label that escapes is invisible, not merely untidy. Labels sit on a COMMON
// ring (R_LABEL) rather than at each spoke's end — placing them at the spoke
// end put two similar-count neighbours at the same radius and they collided.
// W must therefore be at least 2 * (R_LABEL + LABEL_W).
const W = 600,
  CX = 300,
  CY = 300;
const R_SEED = 42,
  R0 = 74,
  LEN_MAX = 96,
  R_LABEL = 180,
  LABEL_CHARS = 18,
  PER_SECTOR = 4;

const SECTORS = [
  ["related_subjects", "SUBJECTS"],
  ["related_people", "PEOPLE"],
  ["related_projects", "PROJECTS"],
  ["related_countries", "COUNTRIES"],
  ["related_research_sections", "SECTIONS"],
  ["related_formats", "FORMATS"],
];

function clip(s, n) {
  s = String(s);
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}
const polar = function (angle, r) {
  const a = ((angle - 90) * Math.PI) / 180; // 0deg = 12 o'clock, clockwise
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
};

function render(d) {
  const root = document.getElementById("root");
  // A research-item seed (full-text pivot) is named by its title, not its id.
  const seedName = d.seed_label || d.value || "";
  const live = SECTORS.map(function (s) {
    return {
      key: s[0],
      label: s[1],
      rows: (d[s[0]] || []).slice(0, PER_SECTOR),
    };
  }).filter(function (s) {
    return s.rows.length > 0;
  });

  if (!(d.matched_items || d.matched_publications)) {
    root.innerHTML =
      "<h1>" + esc(seedName) + "</h1>" + '<p class="empty">Nothing co-occurs with this seed in the collection.</p>';
    return;
  }

  let max = 0;
  live.forEach(function (s) {
    s.rows.forEach(function (r) {
      max = Math.max(max, r.count);
    });
  });
  max = max || 1;

  const span = 360 / live.length;
  const out = [
    '<svg viewBox="0 0 ' +
      W +
      " " +
      W +
      '" role="img" aria-label="Entities co-occurring with ' +
      esc(seedName) +
      '" preserveAspectRatio="xMidYMid meet">',
  ];

  live.forEach(function (sector, si) {
    const start = si * span;

    // Sector boundary, so the angular grouping is visible without colour.
    const dv = polar(start, R_LABEL - 6);
    out.push(
      '<line class="sectordiv" x1="' +
        CX +
        '" y1="' +
        CY +
        '" x2="' +
        dv[0].toFixed(1) +
        '" y2="' +
        dv[1].toFixed(1) +
        '" />',
    );

    // Sector heading, in the gap between the seed circle and the spokes.
    const mid = start + span / 2;
    const hp = polar(mid, R_SEED + 6);
    const flip = mid > 180;
    out.push(
      '<text class="sector" transform="translate(' +
        hp[0].toFixed(1) +
        "," +
        hp[1].toFixed(1) +
        ") rotate(" +
        (flip ? mid + 90 : mid - 90).toFixed(1) +
        ')" text-anchor="' +
        (flip ? "end" : "start") +
        '" dominant-baseline="middle">' +
        sector.label +
        "</text>",
    );

    const step = span / (sector.rows.length + 1);
    sector.rows.forEach(function (r, i) {
      const a = start + step * (i + 1);
      const len = Math.max(6, (r.count / max) * LEN_MAX);
      const p0 = polar(a, R0),
        p1 = polar(a, R0 + len);
      out.push(
        '<line class="spoke" x1="' +
          p0[0].toFixed(1) +
          '" y1="' +
          p0[1].toFixed(1) +
          '" x2="' +
          p1[0].toFixed(1) +
          '" y2="' +
          p1[1].toFixed(1) +
          '"><title>' +
          esc(r.name) +
          ": " +
          r.count +
          " shared record" +
          (r.count === 1 ? "" : "s") +
          "</title></line>",
      );

      // Leader from the spoke's end to the label ring, so a short spoke still
      // reads as belonging to its label.
      const l0 = polar(a, R0 + len + 3),
        l1 = polar(a, R_LABEL - 4);
      if (R_LABEL - 4 > R0 + len + 3) {
        out.push(
          '<line class="leader" x1="' +
            l0[0].toFixed(1) +
            '" y1="' +
            l0[1].toFixed(1) +
            '" x2="' +
            l1[0].toFixed(1) +
            '" y2="' +
            l1[1].toFixed(1) +
            '" />',
        );
      }

      const lp = polar(a, R_LABEL);
      const right = a <= 180;
      out.push(
        '<text class="node" transform="translate(' +
          lp[0].toFixed(1) +
          "," +
          lp[1].toFixed(1) +
          ") rotate(" +
          (right ? a - 90 : a + 90).toFixed(1) +
          ')" text-anchor="' +
          (right ? "start" : "end") +
          '" dominant-baseline="middle">' +
          esc(clip(r.name, LABEL_CHARS)) +
          " · " +
          r.count +
          "</text>",
      );
    });
  });

  // The seed itself, last so it sits above the spokes.
  out.push('<circle class="seed" cx="' + CX + '" cy="' + CY + '" r="' + R_SEED + '" />');
  const words = esc(clip(seedName, 30)).split(" ");
  let lines = [],
    cur = "";
  words.forEach(function (w) {
    if ((cur + " " + w).trim().length > 13) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = (cur + " " + w).trim();
    }
  });
  if (cur) lines.push(cur);
  lines = lines.slice(0, 3);
  const y0 = CY - (lines.length - 1) * 6 - 4;
  lines.forEach(function (ln, i) {
    out.push('<text class="seedlab" x="' + CX + '" y="' + (y0 + i * 12) + '" text-anchor="middle">' + ln + "</text>");
  });
  out.push(
    '<text class="seedsub" x="' +
      CX +
      '" y="' +
      (y0 + lines.length * 12 + 3) +
      '" text-anchor="middle">' +
      d.matched_items +
      " items" +
      (d.matched_publications ? " · " + d.matched_publications + " pubs" : "") +
      "</text>",
  );
  out.push("</svg>");

  root.innerHTML =
    "<h1>What co-occurs with " +
    esc(seedName) +
    "</h1>" +
    '<p class="sub">' +
    esc(d.entity_type) +
    " seed · " +
    d.matched_items +
    " matching research items" +
    (d.matched_publications ? " · " + d.matched_publications + " publications" : "") +
    ". Spoke length counts distinct source records; each sector is one relation type.</p>" +
    '<div class="hub">' +
    out.join("") +
    "</div>" +
    '<p class="note">' +
    esc(d.matching || "") +
    "</p>" +
    "<details><summary>All returned relationships and counts</summary><table><thead><tr><th>Entity</th><th>Research items</th><th>Publications</th></tr></thead><tbody>" +
    SECTORS.map(function (s) {
      return (d[s[0]] || [])
        .map(function (r) {
          return (
            "<tr><td>" +
            esc(r.name) +
            "</td><td>" +
            (r.research_item_count || 0) +
            "</td><td>" +
            (r.publication_count || 0) +
            "</td></tr>"
          );
        })
        .join("");
    }).join("") +
    "</tbody></table></details>" +
    ((d.related_publications || []).length
      ? "<h2>Publication evidence</h2><ul>" +
        d.related_publications
          .map(function (p) {
            return "<li>" + citationLink(p) + "</li>";
          })
          .join("") +
        "</ul>"
      : "");
}

export { render };
