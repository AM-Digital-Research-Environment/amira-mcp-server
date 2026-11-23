// The bibliography view's script (src/ui/bibliography.ts names it). Plain browser JavaScript, run
// inside a function scope that returns `render` (src/ui/page.ts viewsScript),
// beside the shared helpers of ./_shared.js. Type-checked with
// tsconfig.views.json and linted by Biome. The trailing `export { render }`
// makes the file a module for those checks; the page assembler drops it.
const api = window.amiraApp,
  esc = api.esc,
  selected = new Map();
/** @type {ToolData} */
let active;
/** @type {ToolData} */
let filters = {};
/** @type {PickerOption[] | null} */
let lastLanguages = null;
/** Searches answer only their latest request; one export runs at a time (#51). */
const searchOrder = requestOrder();
let exporting = false;
/** The citation format of the next export. */
let exportFormat = "bibtex";
/**
 * Saved state being restored (#32): its filters and page are searched again,
 * and the render of that search applies the selection. Nothing is saved meanwhile.
 * @type {{ snapshot: string | null, state: ToolData } | null}
 */
let restoring = null;
const EXPORT_FORMATS = ["bibtex", "ris", "csl-json"];
// Languages are counted for the current search without its own language filter,
// so the other languages stay selectable. Authors are the whole bibliography.
const LANGUAGE_SCOPE = [
  "keyword",
  "author",
  "type",
  "venue",
  "subject",
  "has_fulltext",
  "year_from",
  "year_to",
  "added_since",
];
/** @param {ToolData} scope */
function languageKey(scope) {
  return "languages:" + JSON.stringify(scope);
}
/** @param {ToolData} scope */
function languages(scope) {
  return pickerLoad(
    languageKey(scope),
    "list_publication_facets",
    Object.assign({ facet: "language", limit: 100 }, scope),
    function (r) {
      return {
        value: r.value,
        label: r.value + " (" + r.publication_count + ")",
      };
    },
  ).then(function (list) {
    if (list) lastLanguages = list;
    return list;
  });
}
function authors() {
  return pickerLoad("authors", "list_publication_facets", { facet: "author", limit: 100 }, function (r) {
    return { value: r.value };
  });
}
/**
 * `next` is a candidate: render() commits the filters the result echoes, so a
 * failed search leaves the filters on screen in force (#51).
 * @param {number} [offset]
 * @param {ToolData} [next]
 */
function search(offset, next) {
  return latestCall(searchOrder, "search_publications", Object.assign({}, next || filters, { offset: offset || 0, limit: 20 }), render);
}
async function exportSelection() {
  if (!selected.size || exporting) return;
  exporting = true;
  const button = document.getElementById("export-selected");
  button.disabled = true;
  // The select on screen is the truth; remember it for the saved state.
  const chosen = document.getElementById("export-format").value;
  if (EXPORT_FORMATS.indexOf(chosen) >= 0) exportFormat = chosen;
  const format = exportFormat;
  try {
    /** @type {unknown[]} */
    const entries = [];
    // Selected entries are capped at 25; two requests at a time avoid a burst against the host.
    const ids = Array.from(selected.keys());
    for (let i = 0; i < ids.length; i += 2) {
      const batch = await Promise.all(
        ids.slice(i, i + 2).map(function (id) {
          return api.callTool("get_publication", {
            id: id,
            citation_format: format,
          });
        }),
      );
      batch.forEach(function (p) {
        entries.push(format === "csl-json" ? p.csl_json : p[format]);
      });
    }
    const text = format === "csl-json" ? JSON.stringify(entries, null, 2) : entries.join("\n\n");
    const how = await api.download(text, format === "bibtex" ? "bib" : format === "ris" ? "ris" : "json");
    api.status(
      how === "shown"
        ? "This host cannot save files: the " + entries.length + " citations are shown below to copy."
        : "Exported " + entries.length + " selected publications.",
    );
  } catch (error) {
    api.status(/** @type {Error} */ (error).message);
  } finally {
    exporting = false;
    const current = document.getElementById("export-selected"); // the page may have re-rendered
    if (current) current.disabled = selected.size === 0;
  }
}
function selection() {
  const count = document.getElementById("selection-count");
  count.textContent = selected.size + " selected (maximum 25)";
  document.getElementById("export-selected").disabled = exporting || !selected.size;
  share();
}
// What the model is told the reader is working with: the filters, and the
// selected publications or, with none selected, the page in view. Titles are
// data; selectionContext.ts bounds and labels them.
/** @param {ToolData} p */
function cite(p) {
  return {
    id: String(p.omeka_id || p.id),
    title: p.title,
    year: p.year,
    type: p.type,
    amira_url: p.amira_url,
  };
}
/** Save what reconstructs this view: filters, page, selection and format (#32). */
function save() {
  if (restoring) return;
  api.saveState("bibliography", {
    filters: filters,
    offset: active.offset || 0,
    selected: Array.from(selected.values()),
    format: exportFormat,
  });
}
/**
 * Apply a saved state once its search has answered. The selection's ids and
 * titles hold for the snapshot they were saved on only: on another (or an
 * unknown) snapshot the selection is dropped, and the reader told.
 * @param {{ snapshot: string | null, state: ToolData }} saved
 */
function applyRestore(saved) {
  const state = saved.state;
  if (EXPORT_FORMATS.indexOf(state.format) >= 0) exportFormat = state.format;
  const picks = Array.isArray(state.selected) ? state.selected.slice(0, 25) : [];
  if (!picks.length) return;
  if (!saved.snapshot || saved.snapshot !== api.snapshot()) {
    api.status("The collection has been updated since this view was saved, so its selection was cleared.");
    return;
  }
  picks.forEach(function (/** @type {ToolData} */ p) {
    if (p && (typeof p.id === "string" || typeof p.id === "number")) {
      selected.set(String(p.id), cite(p));
    }
  });
}
function share() {
  save();
  const picked = Array.from(selected.values()),
    page = (active.results || []).map(cite);
  api.shareSelection({
    view: "bibliography",
    summary: picked.length
      ? "Publications selected for export: " + picked.length + ", of " + active.total_matches + " matching the filters."
      : "No publication selected. Publications matching the filters: " +
        active.total_matches +
        "; the current page is listed.",
    filters: filters,
    counts: {
      total_matches: active.total_matches,
      selected: picked.length,
      page_offset: active.offset || 0,
    },
    records: picked.length ? picked : page,
    records_label: picked.length ? "selected publications" : "publications on the current page",
  });
}
const FORMAT_LABEL = { bibtex: "BibTeX", ris: "RIS", "csl-json": "CSL-JSON", csv: "CSV", jsonl: "JSONL" };
/** @param {unknown} format */
function formatLabel(format) {
  return esc(/** @type {Record<string, string>} */ (FORMAT_LABEL)[String(format)] || format);
}
/**
 * A citation entry's title, read from the entry itself (citation rows carry no `title`).
 * @param {ToolData} r
 * @param {string} format
 */
function citationTitle(r, format) {
  const entry = format === "csl-json" ? r.csl_json : r[format];
  if (entry && typeof entry === "object" && entry.title) return String(entry.title);
  const text = typeof entry === "string" ? entry : "";
  const found = format === "ris" ? /^TI {2}- (.+)$/m.exec(text) : /^\s*title\s*=\s*[{"](.+?)[}"],?\s*$/m.exec(text);
  return found ? found[1].replace(/[{}]/g, "") : "Publication " + (r.omeka_id || r.id);
}
/**
 * search_publications with `export` (a file link) or `citation_format` (a page
 * of citation entries, without titles or authors): a read-only summary. The
 * filterable list is the plain search.
 * @param {ToolData} d
 */
function renderFile(d) {
  const root = document.getElementById("root");
  root.onchange = null;
  if (d.export) {
    const file = d.export;
    root.innerHTML =
      '<h1>Cluster bibliography</h1><p class="sub">' +
      formatLabel(file.format) +
      " export · " +
      file.rows +
      (file.rows === 1 ? " publication" : " publications") +
      '</p><p class="note">The file is linked in the conversation (' +
      esc(file.uri) +
      "). " +
      esc(d.hint || "") +
      "</p>";
    return;
  }
  const format = String(d.citation_format);
  const rows = d.results || [];
  root.innerHTML =
    '<h1>Cluster bibliography</h1><p class="sub">' +
    formatLabel(format) +
    " citations · " +
    d.total_matches +
    " matching publications · " +
    (rows.length ? "showing " + (d.offset + 1) + "–" + (d.offset + rows.length) : "no results") +
    "</p>" +
    (rows.length
      ? "<ol start=\"" +
        (d.offset + 1) +
        '">' +
        rows
          .map(function (r) {
            return "<li>" + citationLink(r, citationTitle(r, format)) + "</li>";
          })
          .join("") +
        "</ol>"
      : '<p class="empty">No publications match these filters. Try removing a filter.</p>') +
    '<p class="note">The citation entries are in the conversation. Search without a citation format to browse, filter and select publications here.</p>';
}
/** @param {ToolData} d */
function render(d) {
  // This result supersedes every search still loading.
  searchOrder.next();
  // A result from the host starts its own instance: its saved state, if any,
  // replaces the selection in memory (#32).
  const saved = api.restoreState("bibliography");
  if (saved !== undefined) {
    restoring = null;
    selected.clear();
    exportFormat = "bibtex";
  }
  if (d.export || d.citation_format) {
    renderFile(d);
    return;
  }
  let apply = null;
  if (saved) {
    restoring = saved;
    const state = saved.state,
      again = state.filters && typeof state.filters === "object" && !Array.isArray(state.filters) ? state.filters : {};
    search(Math.max(0, Number(state.offset) || 0), again).then(function () {
      // A search that failed leaves the fresh view, which is then saved as it is.
      if (restoring === saved) restoring = null;
    });
  } else if (restoring) {
    apply = restoring;
    restoring = null;
  }
  active = d;
  filters = Object.assign({}, d.filters || {});
  delete filters.citation_format;
  if (apply) applyRestore(apply);
  const rows = d.results || [];
  /** @type {ToolData} */
  const scope = {};
  LANGUAGE_SCOPE.forEach(function (k) {
    if (filters[k] !== undefined) scope[k] = filters[k];
  });
  const author = { name: "author", kind: "suggest", current: filters.author },
    language = {
      name: "language",
      kind: "select",
      any: "Any language",
      current: filters.language,
    };
  const authorList = pickerNow("authors"),
    languageList = pickerNow(languageKey(scope)) || lastLanguages;
  document.getElementById("root").innerHTML =
    '<h1>Cluster bibliography</h1><p class="sub">' +
    d.total_matches +
    " matching publications · " +
    (rows.length ? "showing " + (d.offset + 1) + "–" + (d.offset + rows.length) : "no results") +
    "</p>" +
    '<form id="publication-search"><div class="controls"><label>Keyword<input name="keyword" maxlength="1000" value="' +
    esc(filters.keyword || "") +
    '"></label><label>Author' +
    pickerField(author, authorList) +
    "</label><label>Language" +
    pickerField(language, languageList) +
    '</label></div><div class="controls"><label>From year<input type="number" min="0" max="2200" name="year_from" value="' +
    esc(filters.year_from || "") +
    '"></label><label>To year<input type="number" min="0" max="2200" name="year_to" value="' +
    esc(filters.year_to || "") +
    '"></label><button>Search bibliography</button><button type="button" id="clear-filters">Clear filters</button></div></form>' +
    '<div class="controls"><span id="selection-count"></span><label>Export format<select id="export-format">' +
    EXPORT_FORMATS.map(function (f) {
      return '<option value="' + f + '"' + (f === exportFormat ? " selected" : "") + ">" + formatLabel(f) + "</option>";
    }).join("") +
    '</select></label><button id="export-selected">Download selection</button><button id="clear-selection">Clear selection</button></div>' +
    selectionControls() +
    (rows.length
      ? "<table><thead><tr><th>Select</th><th>Publication</th><th>Year</th></tr></thead><tbody>" +
        rows
          .map(function (p) {
            const id = String(p.omeka_id || p.id);
            return (
              '<tr><td><input type="checkbox" data-id="' +
              esc(id) +
              '" aria-label="Select ' +
              esc(p.title) +
              '" ' +
              (selected.has(id) ? "checked" : "") +
              "></td><td>" +
              citationLink(p) +
              '<br><span class="note">' +
              esc((p.authors || []).join("; ")) +
              (p.has_fulltext ? " · Full text available" : "") +
              "</span></td><td>" +
              esc(p.year || "Undated") +
              "</td></tr>"
            );
          })
          .join("") +
        "</tbody></table>"
      : '<p class="empty">No publications match these filters. Try removing a filter.</p>') +
    '<div class="controls">' +
    (d.offset ? '<button id="previous">Previous page</button>' : "") +
    (d.has_more ? '<button id="next">Next page</button>' : "") +
    '</div><p class="note">Selections persist across pages. Citation exports contain the selected records; open a title to read its source catalogue entry.</p>';
  selection();
  pickerMount(author, authors(), authorList);
  pickerMount(language, languages(scope), languageList);
  document.getElementById("publication-search").onsubmit = function (event) {
    event.preventDefault();
    const values = new FormData(/** @type {HTMLFormElement} */ (event.target));
    const next = Object.assign({}, filters);
    for (const entry of values) {
      if (entry[1]) next[entry[0]] = entry[0].startsWith("year_") ? Number(entry[1]) : entry[1];
      else delete next[entry[0]];
    }
    search(0, next);
  };
  document.getElementById("clear-filters").onclick = function () {
    search(0, {});
  };
  document.getElementById("root").onchange = function (event) {
    const box = event.target;
    if (box.matches("#export-format")) {
      exportFormat = box.value;
      save();
      return;
    }
    if (!box.dataset.id) return;
    if (box.checked) {
      if (selected.size >= 25) {
        box.checked = false;
        api.status("Select up to 25 publications per export.");
        return;
      }
      selected.set(
        box.dataset.id,
        cite(
          rows.find(function (p) {
            return String(p.omeka_id || p.id) === box.dataset.id;
          }) || { id: box.dataset.id },
        ),
      );
    } else selected.delete(box.dataset.id);
    selection();
  };
  document.getElementById("export-selected").onclick = exportSelection;
  document.getElementById("clear-selection").onclick = function () {
    selected.clear();
    render(active);
  };
  const next = document.getElementById("next");
  if (next)
    next.onclick = function () {
      search(d.next_offset);
    };
  const prev = document.getElementById("previous");
  if (prev)
    prev.onclick = function () {
      search(Math.max(0, d.offset - 20));
    };
}

export { render };
