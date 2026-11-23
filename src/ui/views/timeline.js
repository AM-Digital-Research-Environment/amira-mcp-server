// The timeline view's script (src/ui/timeline.ts names it). Plain browser JavaScript, run
// inside a function scope that returns `render` (src/ui/page.ts viewsScript),
// beside the shared helpers of ./_shared.js. Type-checked with
// tsconfig.views.json and linted by Biome. The trailing `export { render }`
// makes the file a module for those checks; the page assembler drops it.
const esc = window.amiraApp.esc;
const api = window.amiraApp;
const W = 720,
  H = 240,
  PAD_L = 40,
  PAD_R = 8,
  PAD_T = 10,
  PAD_B = 26;

/** The chart's loads, and the bar's records: each answers only its latest request (#51). */
const chartOrder = requestOrder(),
  recordsOrder = requestOrder();

// Projects with research items, by name; a project is chosen by id but a name
// passed by the model still selects it. Subjects are suggestions, ranked by use.
function projects() {
  return pickerLoad(
    "projects",
    "search_projects",
    { limit: 100 },
    function (r) {
      return r.item_count
        ? {
            value: String(r.id),
            alt: r.name,
            label: r.name + " (" + r.item_count + ")",
          }
        : null;
    },
    function (a, b) {
      return a.alt.localeCompare(b.alt);
    },
  );
}
function subjects() {
  return pickerLoad("subjects", "list_subjects", { limit: 300 }, function (r) {
    return { value: r.subject };
  });
}

/** @param {ToolData} payload */
function render(payload) {
  // This result supersedes every chart or records request still loading.
  chartOrder.next();
  recordsOrder.next();
  const rows = (payload && payload.results) || [];
  const root = document.getElementById("root");
  const isDecade = payload.bucket === "decade";
  const unit = isDecade ? "decade" : "year";

  if (!rows.length) {
    root.innerHTML =
      "<h1>AMIRA — research items per " +
      unit +
      "</h1>" +
      '<p class="empty">No dated items in this range.</p><button id="reset-range">Clear filters</button>';
    document.getElementById("reset-range").onclick = reset;
    return;
  }

  // list_years can be sorted by count; a timeline must read left to right.
  const data = rows
    .map(function (r) {
      return {
        key: isDecade ? r.from : r.year,
        label: isDecade ? r.decade : String(r.year),
        n: r.item_count,
      };
    })
    .sort(function (a, b) {
      return a.key - b.key;
    });

  const max =
    data.reduce(function (m, d) {
      return Math.max(m, d.n);
    }, 0) || 1;
  const innerW = W - PAD_L - PAD_R,
    innerH = H - PAD_T - PAD_B;
  const step = innerW / data.length;
  const barW = Math.max(1, step - (step > 6 ? 2 : 0.5)); // 2px surface gap between bars

  const parts = [
    '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" role="img" aria-label="Research items per ' +
      unit +
      '" preserveAspectRatio="xMidYMid meet">',
  ];

  [0, 0.5, 1].forEach(function (f) {
    const y = PAD_T + innerH - f * innerH;
    parts.push('<line class="grid" x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" />');
    parts.push(
      '<text class="axis" x="' +
        (PAD_L - 6) +
        '" y="' +
        (y + 3) +
        '" text-anchor="end">' +
        Math.round(f * max) +
        "</text>",
    );
  });

  data.forEach(function (d, i) {
    const h = (d.n / max) * innerH;
    const x = PAD_L + i * step;
    const y = PAD_T + innerH - h;
    parts.push(
      '<rect class="bar" x="' +
        x.toFixed(1) +
        '" y="' +
        y.toFixed(1) +
        '" width="' +
        barW.toFixed(1) +
        '" height="' +
        Math.max(h, 0.6).toFixed(1) +
        '" rx="' +
        (barW > 8 ? 3 : 0) +
        '" role="button" tabindex="0" data-year="' +
        d.key +
        '" aria-label="Browse ' +
        esc(d.label) +
        '"><title>' +
        esc(d.label) +
        ": " +
        d.n +
        (d.n === 1 ? " item" : " items") +
        "</title></rect>",
    );
  });

  // Selective labels only — never one per bar.
  const every = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 46)));
  data.forEach(function (d, i) {
    if (i % every !== 0 && i !== data.length - 1) return;
    parts.push(
      '<text class="axis" x="' +
        (PAD_L + i * step + barW / 2).toFixed(1) +
        '" y="' +
        (H - 8) +
        '" text-anchor="middle">' +
        esc(d.label) +
        "</text>",
    );
  });
  parts.push("</svg>");

  const current = (payload.filters || {}).filters || {};
  const subject = { name: "subject", kind: "suggest", current: current.subject };
  const project = {
    name: "project_id",
    kind: "select",
    any: "All projects",
    maxlength: 256,
    current: current.project_id == null ? "" : String(current.project_id).replace(/^project:/i, ""),
  };
  const subjectList = pickerNow("subjects"),
    projectList = pickerNow("projects");
  const range = payload.year_range ? " spanning " + payload.year_range.min + "–" + payload.year_range.max : "";
  root.innerHTML =
    "<h1>AMIRA — research items per " +
    unit +
    "</h1>" +
    '<p class="sub">' +
    payload.dated_items +
    " dated items" +
    range +
    (payload.undated_items ? " · " + payload.undated_items + " undated" : "") +
    "</p>" +
    '<div class="chart">' +
    parts.join("") +
    "</div>" +
    '<p class="note">An item whose content date is a range counts toward every ' +
    unit +
    " it spans, so the bars can sum to more than the item total. Showing " +
    rows.length +
    " of " +
    payload.total_matches +
    " buckets.</p>" +
    '<form id="timeline-filter"><div class="controls"><label>Subject' +
    pickerField(subject, subjectList) +
    "</label><label>Project" +
    pickerField(project, projectList) +
    '</label></div><div class="controls"><label for="brush-from">From year <output id="from-label"></output><input type="range" id="brush-from" name="from" min="' +
    data[0].key +
    '" max="' +
    (data[data.length - 1].key + (isDecade ? 9 : 0)) +
    '" value="' +
    data[0].key +
    '"></label><label for="brush-to">To year <output id="to-label"></output><input type="range" id="brush-to" name="to" min="' +
    data[0].key +
    '" max="' +
    (data[data.length - 1].key + (isDecade ? 9 : 0)) +
    '" value="' +
    (data[data.length - 1].key + (isDecade ? 9 : 0)) +
    '"></label><button>Apply range</button></div></form>' +
    '<button id="reset-range">Clear filters</button><details><summary>Counts by ' +
    unit +
    "</summary><table><thead><tr><th>Period</th><th>Items</th></tr></thead><tbody>" +
    data
      .map(function (r) {
        return '<tr><td><button data-year="' + r.key + '">' + esc(r.label) + "</button></td><td>" + r.n + "</td></tr>";
      })
      .join("") +
    "</tbody></table></details>" +
    (payload.has_more ? '<button id="next-buckets">Next buckets</button>' : "") +
    '<section id="timeline-evidence" class="evidence" aria-live="polite"></section>';
  pickerMount(subject, subjects(), subjectList);
  pickerMount(project, projects(), projectList);
  const from = document.getElementById("brush-from"),
    to = document.getElementById("brush-to");
  document.getElementById("reset-range").onclick = reset;
  function rangeLabels() {
    document.getElementById("from-label").textContent = from.value;
    document.getElementById("to-label").textContent = to.value;
  }
  from.oninput = to.oninput = rangeLabels;
  rangeLabels();
  const baseFilters = Object.assign({}, (payload.filters || {}).filters || {});
  const windowFrom = (payload.filters || {}).from,
    windowTo = (payload.filters || {}).to;
  /**
   * The records of one bar, within the active window and year filters: a
   * ranged item drawn in an earlier bar must not turn the bounds into an
   * inverted range (#51).
   * @param {number} lo
   * @param {number} hi
   * @param {number} [offset]
   */
  function evidence(lo, hi, offset) {
    const from = Math.max(lo, windowFrom ?? lo, baseFilters.year_from ?? lo),
      to = Math.min(hi, windowTo ?? hi, baseFilters.year_to ?? hi);
    if (from > to) {
      recordsOrder.next();
      document.getElementById("timeline-evidence").innerHTML =
        '<p class="note">This bar counts items whose date ranges reach into it from the filtered years; widen the year filter to list them.</p>';
      return;
    }
    const args = Object.assign({}, baseFilters, { year_from: from, year_to: to, offset: offset || 0, limit: 20 });
    latestCall(recordsOrder, "search_research_items", args, function (d) {
      evidenceList(
        document.getElementById("timeline-evidence"),
        from + "–" + to + " · " + d.total_matches + " matching records",
        d,
        citationLink,
        "next-evidence",
        function (next) {
          evidence(lo, hi, next);
        },
      );
    });
  }
  root.onclick = function (event) {
    const el = event.target.closest("[data-year]");
    if (el) evidence(Number(el.dataset.year), Number(el.dataset.year) + (isDecade ? 9 : 0));
  };
  root.onkeydown = function (event) {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches("rect[data-year]")) {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
  };
  document.getElementById("timeline-filter").onsubmit = function (event) {
    event.preventDefault();
    if (Number(from.value) > Number(to.value)) {
      api.status("From year must precede to year.");
      return;
    }
    const form = new FormData(/** @type {HTMLFormElement} */ (event.target));
    // Candidate filters: committed by render() from the result, never before it (#51).
    const filters = Object.assign({}, baseFilters, {
      subject: form.get("subject") || undefined,
      project_id: form.get("project_id") || undefined,
    });
    latestCall(
      chartOrder,
      "list_years",
      { bucket: payload.bucket, from: Number(from.value), to: Number(to.value), filters: filters, limit: 200 },
      render,
    );
  };
  const nextBuckets = document.getElementById("next-buckets");
  if (nextBuckets)
    nextBuckets.onclick = function () {
      latestCall(
        chartOrder,
        "list_years",
        Object.assign({}, payload.filters || {}, { bucket: payload.bucket, offset: payload.next_offset, limit: 200 }),
        render,
      );
    };
}

function reset() {
  latestCall(chartOrder, "list_years", { bucket: "decade", limit: 200 }, render);
}

export { render };
