// The helpers several views share, defined once at the top of the views
// script, before the views (src/ui/page.ts viewsScript). Plain browser
// JavaScript and a classic script, not a module: its top-level functions are
// the globals the views call, and tsconfig.views.json checks both sides
// against each other. Linted by Biome, which reads every .js file as a module
// and so cannot see the views' calls.
// biome-ignore-all lint/correctness/noUnusedVariables: the views call these globals

// --- filter pickers ------------------------------------------------------------
// Dropdowns and suggestion lists whose options the app fetches itself through
// allowlisted tools, so the lists never enter the model's context. Until a list
// arrives, or when the host refuses the call, a field is the plain text input it
// replaces, so typing a value always works.
//
// A field is a PickerSpec: kind "select" becomes a dropdown (with `any` as its
// empty choice) once its list loads; kind "suggest" stays a text field with a
// datalist. An option is a PickerOption; `current` matches value or alt,
// ignoring case, and a current value the list lacks is kept as its own option.

/** @type {Record<string, Promise<PickerOption[] | null> | PickerOption[] | null>} */
const pickerLists = {};
/**
 * Every page of a list tool, fetched once per key. Resolves null if the call fails.
 * @param {string} key
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {(row: ToolData) => PickerOption | null} pick
 * @param {(a: PickerOption, b: PickerOption) => number} [order]
 * @returns {Promise<PickerOption[] | null>}
 */
function pickerLoad(key, tool, args, pick, order) {
  if (!(key in pickerLists))
    pickerLists[key] = (async function () {
      /** @type {PickerOption[]} */
      const out = [];
      let offset = 0,
        pages = 0;
      /** @type {ToolData} */
      let d;
      do {
        d = await window.amiraApp.callTool(tool, Object.assign({}, args, { offset: offset }), { quiet: true });
        (d.results || []).forEach(function (r) {
          const o = pick(r);
          if (o) out.push(o);
        });
        offset = d.next_offset;
      } while (d.has_more && offset != null && ++pages < 10);
      return order ? out.sort(order) : out;
    })().then(
      function (list) {
        pickerLists[key] = list;
        return list;
      },
      /** @returns {null} */
      function () {
        pickerLists[key] = null;
        return null;
      },
    );
  return Promise.resolve(pickerLists[key]);
}
/**
 * A loaded list, or null while it is pending or after it failed.
 * @param {string} key
 * @returns {PickerOption[] | null}
 */
function pickerNow(key) {
  return Array.isArray(pickerLists[key]) ? pickerLists[key] : null;
}
/**
 * @param {PickerOption[]} list
 * @param {(o: PickerOption) => boolean} [hit]
 */
function pickerOptions(list, hit) {
  const esc = window.amiraApp.esc;
  return list
    .map(function (o) {
      return (
        '<option value="' +
        esc(o.value) +
        '"' +
        (hit && hit(o) ? " selected" : "") +
        ">" +
        esc(o.label || o.value) +
        "</option>"
      );
    })
    .join("");
}
/**
 * A picker's markup.
 * @param {PickerSpec} p
 * @param {PickerOption[] | null} list
 * @returns {string}
 */
function pickerField(p, list) {
  const esc = window.amiraApp.esc,
    cur = p.current == null ? "" : String(p.current),
    low = cur.toLowerCase();
  if (p.kind === "select" && list) {
    /** @param {PickerOption} o */
    const hit = function (o) {
      return !!low && (o.value.toLowerCase() === low || (o.alt || "").toLowerCase() === low);
    };
    return (
      '<select name="' +
      p.name +
      '"><option value="">' +
      esc(p.any) +
      "</option>" +
      (cur && !list.some(hit) ? '<option value="' + esc(cur) + '" selected>' + esc(cur) + "</option>" : "") +
      pickerOptions(list, hit) +
      "</select>"
    );
  }
  const suggest = p.kind === "suggest";
  return (
    '<input name="' +
    p.name +
    '" maxlength="' +
    (p.maxlength || 1000) +
    '" value="' +
    esc(cur) +
    '"' +
    (p.placeholder ? ' placeholder="' + esc(p.placeholder) + '"' : "") +
    (suggest ? ' list="' + p.name + '-options" autocomplete="off"' : "") +
    ">" +
    (suggest ? '<datalist id="' + p.name + '-options">' + pickerOptions(list || []) + "</datalist>" : "")
  );
}
/** Choose the option marked selected explicitly: happy-dom, the DOM the renderer
 * tests run in, misreads a parsed selected attribute. A no-op in browsers.
 * @param {Element | null} el */
function pickerSettle(el) {
  const marked = el && el.tagName === "SELECT" && el.querySelector("option[selected]");
  if (marked) el.value = marked.value;
  return el;
}
/** Upgrade a field rendered from list shown (null while pending) once load
 * resolves. A field the page has since re-rendered, or a dropdown the reader is
 * using, is left alone.
 * @param {PickerSpec} p
 * @param {Promise<PickerOption[] | null>} load
 * @param {PickerOption[] | null} [shown] */
function pickerMount(p, load, shown) {
  const el = pickerSettle(document.querySelector('[name="' + p.name + '"]'));
  load.then(function (list) {
    if (!list || list === shown || !el || !el.isConnected) return;
    if (p.kind === "suggest") {
      const options = document.getElementById(p.name + "-options");
      if (options) options.innerHTML = pickerOptions(list);
      return;
    }
    if (el === document.activeElement) return;
    const holder = document.createElement("div");
    holder.innerHTML = pickerField(Object.assign({}, p, { current: el.value }), list);
    const next = /** @type {Element} */ (holder.firstChild);
    el.replaceWith(next);
    pickerSettle(next);
  });
}

// --- ranked bars -----------------------------------------------------------------
/**
 * A horizontal ranked-bar chart as an SVG string, drawn from `[label, value]`
 * rows. Single series, so the fill carries no identity; the value is direct-
 * labelled at the end of each bar, which doubles as the accessible text
 * alternative and removes the need for an x-axis.
 * @param {any[]} rows
 * @param {Record<string, any>} [opts]
 * @returns {string}
 */
function barChart(rows, opts) {
  opts = opts || {};
  const esc = window.amiraApp.esc;
  if (!rows.length) return '<p class="empty">No data.</p>';
  const ROW = 20,
    GAP = 2,
    LABEL_W = opts.labelWidth || 132,
    VALUE_W = 44,
    PAD_R = 4;
  const W = 460,
    H = rows.length * (ROW + GAP);
  const max =
    rows.reduce(function (m, r) {
      return Math.max(m, r[1]);
    }, 0) || 1;
  const trackW = W - LABEL_W - VALUE_W - PAD_R;
  const out = [
    '<svg viewBox="0 0 ' +
      W +
      " " +
      H +
      '" role="img" aria-label="' +
      esc(opts.label || "ranked bar chart") +
      '" preserveAspectRatio="xMinYMin meet">',
  ];
  rows.forEach(function (r, i) {
    const y = i * (ROW + GAP);
    const w = Math.max(1.5, (r[1] / max) * trackW);
    out.push(
      '<text class="axis" x="' +
        (LABEL_W - 8) +
        '" y="' +
        (y + ROW / 2 + 3.5) +
        '" text-anchor="end">' +
        esc(r[0]) +
        "</text>",
    );
    // 4px rounded data-end, anchored to the baseline at x = LABEL_W.
    out.push(
      '<rect class="bar" x="' +
        LABEL_W +
        '" y="' +
        (y + 3) +
        '" width="' +
        w.toFixed(1) +
        '" height="' +
        (ROW - 6) +
        '" rx="3"><title>' +
        esc(r[0]) +
        ": " +
        r[1] +
        "</title></rect>",
    );
    out.push(
      '<text class="val" x="' + (LABEL_W + w + 6).toFixed(1) + '" y="' + (y + ROW / 2 + 3.5) + '">' + r[1] + "</text>",
    );
  });
  out.push("</svg>");
  return out.join("");
}

// --- the selection ----------------------------------------------------------------
// "Ask about this selection" and the sharing status line, for the views that
// keep a selection (bibliography, map, graph). The button appears only when
// the host accepts app messages, the status line only when it accepts context
// updates, and the row not at all on a host that takes neither. One delegated
// listener serves every render.

/** The "Ask about this selection" controls, or "" when the host takes neither.
 * @returns {string} */
function selectionControls() {
  const api = window.amiraApp,
    ask = api.canAsk(),
    share = api.canShare();
  if (!ask && !share) return "";
  return (
    '<div class="controls">' +
    (ask ? '<button type="button" id="ask-selection">Ask about this selection</button>' : "") +
    (share ? '<span id="selection-status" class="note" role="status"></span>' : "") +
    "</div>"
  );
}
document.addEventListener("click", function (event) {
  const button = event.target && event.target.closest && event.target.closest("#ask-selection");
  if (!button) return;
  const api = window.amiraApp;
  button.disabled = true;
  api
    .ask()
    .then(
      function () {
        api.status("Question sent to the conversation.");
      },
      function (error) {
        api.status(error.message);
      },
    )
    .then(function () {
      if (button.isConnected) button.disabled = false;
    });
});

// --- evidence lists -----------------------------------------------------------------
/**
 * A record's title (or `title`) as a citation link to its amira_url. A private
 * record (curator mode) has no public page: it links to its Omeka admin page,
 * which only curators can open, marked private and never as a citation (#26);
 * plain text when it has neither.
 * @param {ToolData} r a record: its amira_url, admin_url, title and visibility are read
 * @param {string} [title]
 * @returns {string}
 */
function citationLink(r, title) {
  const esc = window.amiraApp.esc,
    label = esc(title == null ? r.title : title);
  if (r.amira_url) return '<a data-citation href="' + esc(r.amira_url) + '">' + label + "</a>";
  const mark = r.visibility === "private" ? ' <span class="note">(private)</span>' : "";
  if (r.admin_url) return adminLink(r.admin_url, label) + mark;
  return label + mark;
}
/**
 * A link to an Omeka admin page: opened through the host like a citation, but
 * marked so it is never mistaken for (or shared as) a public source.
 * @param {string} url
 * @param {string} label markup (escaped by the caller)
 * @returns {string}
 */
function adminLink(url, label) {
  return '<a data-admin href="' + window.amiraApp.esc(url) + '" title="Omeka admin page, for AMIRA curators only">' + label + "</a>";
}
/**
 * A page of records behind a mark (a graph edge, a place, a span of years):
 * heading, numbered list, "Next records". Three views wrote this out by hand.
 * `heading` is markup (escape data in it); `item` renders one record's markup;
 * "Next records" calls `onMore(next_offset)`.
 * @param {Element} target
 * @param {string} heading
 * @param {ToolData} data
 * @param {(r: ToolData) => string} item
 * @param {string} moreId
 * @param {(offset: number) => void} onMore
 */
function evidenceList(target, heading, data, item, moreId, onMore) {
  target.innerHTML =
    '<h2 tabindex="-1">' +
    heading +
    '</h2><ol start="' +
    (data.offset + 1) +
    '">' +
    data.results
      .map(function (r) {
        return "<li>" + item(r) + "</li>";
      })
      .join("") +
    "</ol>" +
    (data.has_more ? '<button id="' + moreId + '">Next records</button>' : "");
  target.querySelector("h2").focus();
  const more = document.getElementById(moreId);
  if (more)
    more.onclick = function () {
      onMore(data.next_offset);
    };
}

// --- request order -------------------------------------------------------------
// A view can have several requests in flight (a filter change, then another, a
// page of records, a host result arriving meanwhile). Without an order a slow
// earlier response overwrote a newer one (#51). Each stream of requests that
// replaces one part of the screen keeps its own order; a newer request, or a
// render from the host, makes every older response in that stream stale.

/** @returns {{ next: () => number, isLatest: (ticket: number) => boolean }} */
function requestOrder() {
  let last = 0;
  return {
    next: function () {
      return ++last;
    },
    isLatest: function (ticket) {
      return ticket === last;
    },
  };
}
/**
 * Call a tool and apply its result only if no newer request in `order` was made
 * meanwhile. A failure applies nothing (the bridge reports it on the status
 * line), so state is committed only by `apply`, on success.
 * @param {{ next: () => number, isLatest: (ticket: number) => boolean }} order
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {(data: ToolData) => void} apply
 * @returns {Promise<void>}
 */
async function latestCall(order, tool, args, apply) {
  const ticket = order.next();
  let data;
  try {
    data = await window.amiraApp.callTool(tool, args);
  } catch (_) {
    return;
  }
  if (!order.isLatest(ticket)) return;
  try {
    apply(data);
  } catch (error) {
    // A page torn down while the call ran has nothing left to render into.
    window.amiraApp.status("This view could not show the result: " + /** @type {Error} */ (error).message);
  }
}
