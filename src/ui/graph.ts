// MCP App: the one-hop entity graph. It borrows the co-occurrence hub's
// encoding (src/ui/related.ts) rather than inventing a second one: entity
// types own angular sectors, spoke length is a distinct-record count, and
// labels sit on a common ring, rotated along their spoke, so neighbours never
// collide. A graph has up to fifteen entity types and no validated palette
// separates that many, so identity is carried by position and a heading, not
// by hue, and the figure survives greyscale and print.
//
// Selecting a spoke opens that neighbour's links and the records behind its
// strongest one directly under the diagram; re-centring is a separate action,
// so reading the evidence for a link never throws the view away. Type chips
// call the tool again with `types`, which the server applies before its
// bounds: a client-side filter would come too late, after languages and
// formats had spent the node budget.
import { page } from "./shell.js";
export const GRAPH_URI = "ui://amira/graph";
const CSS = String.raw`
.graph { max-width: 720px; margin: 0 auto; }
.graph .spoke { stroke: var(--bar); stroke-width: 5; stroke-linecap: round; }
.graph .spoke.derived { stroke-dasharray: 6 4; stroke-linecap: butt; }
.graph .hit { stroke: transparent; stroke-width: 16; }
.graph .leader { stroke: var(--border); stroke-width: 1; }
.graph .label { fill: var(--ink); font-size: 10.5px; }
.graph .sector { fill: var(--ink-muted); font-size: 9.5px; font-weight: 650; letter-spacing: 0.04em; }
.graph .seed { fill: var(--bar); }
.graph .seedlab { fill: #fff; font-size: 11px; font-weight: 650; }
.graph .seedsub { fill: rgba(255, 255, 255, 0.85); font-size: 9px; }
.node-link { cursor: pointer; outline: none; }
.node-link:hover .spoke, .node-link.picked .spoke { stroke: var(--ink-strong); }
.node-link.picked .label { fill: var(--ink-strong); font-weight: 700; }
.node-link:focus-visible .label { text-decoration: underline; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.chips button { min-height: 30px; padding: 4px 10px; border-radius: 999px; font-size: 12px; }
.chips button[aria-pressed="true"] { background: var(--bar); border-color: var(--bar); color: #fff; }
.pick { margin-top: 14px; }
.pick ul { margin: 6px 0 10px; padding-left: 18px; }
.pick li { margin: 3px 0; }
.row-button { text-align: left; border: 0; padding: 0; min-height: 0; color: var(--bar); }
th:last-child { width: 100px; }
button[data-edge] { white-space: nowrap; }
@media (max-width: 480px) { .graph { overflow-x: auto; } .graph svg { min-width: 560px; } }
`;
const SCRIPT = String.raw`
var api = window.amiraApp, esc = api.esc, active, picked, filter = null;
// Sectors, clockwise from twelve o'clock. Every entity type belongs to one.
var GROUPS = [
  { key: "people", label: "People", heading: "PEOPLE", types: ["person"] },
  { key: "projects", label: "Projects", heading: "PROJECTS", types: ["project", "section", "collection"] },
  { key: "places", label: "Places", heading: "PLACES", types: ["location"] },
  { key: "subjects", label: "Subjects", heading: "SUBJECTS", types: ["subject"] },
  { key: "organisations", label: "Organisations", heading: "ORGANISATIONS", types: ["organisation", "journal"] },
  { key: "records", label: "Records", heading: "RECORDS", types: ["research_item", "publication", "podcast", "video"] },
  { key: "formats", label: "Languages and formats", heading: "LANGUAGES, FORMATS", types: ["language", "format", "playlist"] },
];
var groupOf = function (type) { return GROUPS.find(function (g) { return g.types.indexOf(type) >= 0; }) || GROUPS[GROUPS.length - 1]; };
// Geometry: the label ring plus the longest label must fit inside the viewBox,
// which clips; LABEL_CHARS and the " · n" suffix set that width.
var W = 700, C = 350, R_SEED = 46, R0 = 58, LEN_MAX = 100, R_LABEL = 176, LABEL_CHARS = 24, TOTAL = 16;
function clip(s, n) { s = String(s); return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…"; }
function polar(angle, r) { var a = ((angle - 90) * Math.PI) / 180; return [C + r * Math.cos(a), C + r * Math.sin(a)]; }
function line(cls, a, r1, r2) {
  var p = polar(a, r1), q = polar(a, r2);
  return '<line class="' + cls + '" x1="' + p[0].toFixed(1) + '" y1="' + p[1].toFixed(1) + '" x2="' + q[0].toFixed(1) + '" y2="' + q[1].toFixed(1) + '"/>';
}
/** Radial text at angle a, turned so it never reads upside down. */
function radial(cls, a, r, body) {
  var p = polar(a, r), right = a <= 180;
  return '<text class="' + cls + '" transform="translate(' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ') rotate(' + (right ? a - 90 : a + 90).toFixed(1) +
    ')" text-anchor="' + (right ? 'start' : 'end') + '" dominant-baseline="middle">' + body + '</text>';
}
function citation(r) { return '<a data-citation href="' + esc(r.amira_url) + '">' + esc(r.title || r.label) + '</a>'; }
function relationText(e) { return e.kind === 'explicit' ? e.relation.replaceAll('_', ' ') : 'Co-occurrence · ' + e.relation.replace('shared_', '').replaceAll('_', ' '); }
function other(e) { return e.source === active.seed ? e.target : e.source; }
async function load(seed) {
  var args = { seed: seed };
  if (filter) args.types = filter;
  try { render(await api.callTool('get_entity_graph', args)); } catch (_) {}
}
async function evidence(id, offset) {
  try {
    var data = await api.callTool('get_entity_graph', { seed: active.seed, edge_id: id, snapshot_id: active.snapshot_id, offset: offset || 0 });
    var target = document.getElementById('evidence');
    target.innerHTML = '<h2 tabindex="-1">Evidence · ' + data.total_matches + ' records</h2><ol start="' + (data.offset + 1) + '">' +
      data.results.map(function (r) { return '<li>' + citation(r) + ' <span class="note">' + esc(r.corpus) + '</span></li>'; }).join('') + '</ol>' +
      (data.has_more ? '<button id="more-evidence">Next records</button>' : '');
    target.querySelector('h2').focus();
    var more = document.getElementById('more-evidence');
    if (more) more.onclick = function () { evidence(id, data.next_offset); };
  } catch (_) {}
}
/** A neighbour's links, strongest first, and the records behind the first. */
function pick(id) {
  var node = active.nodes.find(function (n) { return n.id === id; });
  if (!node) return;
  picked = id;
  document.querySelectorAll('g.node-link').forEach(function (g) { g.classList.toggle('picked', g.dataset.pick === id); });
  var links = active.edges.filter(function (e) { return other(e) === id; });
  document.getElementById('pick').innerHTML = '<h2>' + esc(node.label) + ' <span class="note">' + esc(node.type) + '</span></h2><ul>' +
    links.map(function (e) { return '<li>' + esc(relationText(e)) + ' · <button class="row-button" data-edge="' + esc(e.id) + '">' + e.count + (e.count === 1 ? ' record' : ' records') + '</button></li>'; }).join('') +
    '</ul><p><button data-node="' + esc(id) + '">Centre the graph on ' + esc(node.label) + '</button>' +
    (node.amira_url ? ' <a data-citation href="' + esc(node.amira_url) + '">Open in AMIRA</a>' : '') + '</p>';
  if (links.length) evidence(links[0].id);
}
function chips(d) {
  var counts = d.neighbour_types || {}, total = 0;
  var live = GROUPS.map(function (g) {
    var n = g.types.reduce(function (s, t) { return s + (counts[t] || 0); }, 0);
    total += n;
    return { g: g, n: n };
  }).filter(function (x) { return x.n > 0; });
  if (!live.length) return '';
  var on = (d.types || []).join(',');
  return '<div class="chips" role="group" aria-label="Neighbour types">' +
    '<button data-types="" aria-pressed="' + (on ? 'false' : 'true') + '">All · ' + total + '</button>' +
    live.map(function (x) { return '<button data-types="' + x.g.types.join(',') + '" aria-pressed="' + (on === x.g.types.join(',') ? 'true' : 'false') + '">' + esc(x.g.label) + ' · ' + x.n + '</button>'; }).join('') + '</div>';
}
function diagram(d, seed) {
  // A neighbour's weight is its strongest link; solid if any link is explicit.
  var weight = new Map();
  d.edges.forEach(function (e) {
    var id = other(e), w = weight.get(id) || { count: 0, explicit: false };
    w.count = Math.max(w.count, e.count); w.explicit = w.explicit || e.kind === 'explicit';
    weight.set(id, w);
  });
  var ranked = d.nodes.filter(function (n) { return n.id !== seed.id && weight.has(n.id); })
    .map(function (n) { return { node: n, w: weight.get(n.id), group: groupOf(n.type) }; })
    .sort(function (a, b) { return b.w.count - a.w.count; });
  // Share the ring so no one type crowds out the rest.
  var present = new Set(ranked.map(function (r) { return r.group.key; })).size;
  var cap = present <= 1 ? TOTAL : Math.max(3, Math.ceil(TOTAL / present)), per = {}, shown = [];
  ranked.forEach(function (r) {
    if (shown.length >= TOTAL || (per[r.group.key] || 0) >= cap) return;
    per[r.group.key] = (per[r.group.key] || 0) + 1; shown.push(r);
  });
  var sectors = GROUPS.map(function (g) { return { g: g, rows: shown.filter(function (r) { return r.group === g; }) }; })
    .filter(function (s) { return s.rows.length; });
  var max = shown.reduce(function (m, r) { return Math.max(m, r.w.count); }, 0) || 1;
  // One empty slot per sector holds its heading, so a heading never shares a
  // radius with a spoke.
  var step = 360 / (shown.length + sectors.length), cursor = 0;
  var out = ['<svg viewBox="0 0 ' + W + ' ' + W + '" role="group" aria-label="One-hop relationships for ' + esc(seed.label) + '">'];
  sectors.forEach(function (s) {
    out.push(radial('sector', cursor + step / 2, R_SEED + 8, esc(s.g.heading)));
    cursor += step;
    s.rows.forEach(function (r) {
      // Square-root length: one strong collaborator would otherwise shrink
      // every other spoke to a dot.
      var a = cursor + step / 2, len = Math.max(8, Math.sqrt(r.w.count / max) * LEN_MAX), n = r.node;
      cursor += step;
      out.push('<g class="node-link' + (n.id === picked ? ' picked' : '') + '" role="button" tabindex="0" data-pick="' + esc(n.id) + '" aria-label="' +
        esc(n.label) + ', ' + esc(n.type) + ', ' + r.w.count + (r.w.count === 1 ? ' record' : ' records') + '"><title>' + esc(n.label) + ': ' + r.w.count + '</title>' +
        line('hit', a, R0, R_LABEL) + line('spoke' + (r.w.explicit ? '' : ' derived'), a, R0, R0 + len) +
        (R_LABEL - 4 > R0 + len + 3 ? line('leader', a, R0 + len + 3, R_LABEL - 4) : '') +
        radial('label', a, R_LABEL, esc(clip(n.label, LABEL_CHARS)) + ' · ' + r.w.count) + '</g>');
    });
  });
  out.push('<circle class="seed" cx="' + C + '" cy="' + C + '" r="' + R_SEED + '"/>');
  var lines = [], cur = '';
  clip(seed.label, 40).split(' ').forEach(function (word) {
    if ((cur + ' ' + word).trim().length > 14) { if (cur) lines.push(cur); cur = word; } else cur = (cur + ' ' + word).trim();
  });
  if (cur) lines.push(cur);
  lines = lines.slice(0, 3);
  var y0 = C - (lines.length - 1) * 6 - 5;
  lines.forEach(function (ln, i) { out.push('<text class="seedlab" x="' + C + '" y="' + (y0 + i * 12) + '" text-anchor="middle">' + esc(ln) + '</text>'); });
  out.push('<text class="seedsub" x="' + C + '" y="' + (y0 + lines.length * 12 + 2) + '" text-anchor="middle">' + esc(seed.type) + '</text></svg>');
  return { svg: out.join(''), shown: shown.length, of: ranked.length };
}
function render(d) {
  if (!d.nodes) return;
  if (!active || active.seed !== d.seed) picked = null;
  active = d;
  filter = d.types && d.types.length ? d.types : null;
  var nodes = new Map(d.nodes.map(function (n) { return [n.id, n]; })), seed = nodes.get(d.seed);
  var shownGroup = filter ? GROUPS.find(function (g) { return g.types.join(',') === filter.join(','); }) : null;
  var view = d.edges.length ? diagram(d, seed) : null;
  var rows = d.edges.map(function (e) {
    var n = nodes.get(other(e));
    return '<tr><td><button class="row-button" data-node="' + esc(n.id) + '">' + esc(n.label) + '</button><br><span class="note">' + esc(n.type) + '</span></td><td>' + esc(relationText(e)) + '</td><td><button data-edge="' + esc(e.id) + '">' + e.count + (e.count === 1 ? ' record' : ' records') + '</button></td></tr>';
  }).join('');
  document.getElementById('root').innerHTML = '<h1>' + esc(seed.label) + '</h1><p class="sub">One-hop relationships · ' + d.edges.length + ' of ' + d.total_edges + ' edges' + (d.truncated ? ' · bounded view' : '') +
    (filter ? ' · ' + esc(shownGroup ? shownGroup.label : filter.join(', ')) + ' only' : '') + '</p>' +
    '<form id="resolve" class="controls"><label>Find an entity<input name="query" maxlength="1000" required placeholder="Person, place, project or subject"></label><button>Find</button></form><div id="candidates"></div>' +
    chips(d) +
    (view ? '<div class="graph">' + view.svg + '</div><p class="note">Showing ' + view.shown + ' of ' + view.of + ' returned neighbours, grouped by type. Spoke length grows with the records behind each neighbour’s strongest link (square-root scale; the number is the count); solid spokes include a catalogue link, dashed spokes are co-occurrence only. Select a neighbour to read its records. All returned edges appear in the table.</p>'
      : '<p class="empty">' + (filter ? 'No neighbours of this type are recorded for this entity.' : 'No relationships are recorded for this entity.') + '</p>') +
    '<section class="pick" id="pick" aria-live="polite"></section><section class="evidence" id="evidence" aria-live="polite"></section>' +
    '<div class="scroll"><table><caption>Relationships and source records</caption><thead><tr><th>Entity</th><th>Relationship</th><th>Evidence</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (picked) pick(picked);
  var root = document.getElementById('root');
  root.onclick = function (event) {
    var types = event.target.closest('[data-types]'), at = event.target.closest('[data-pick]'),
      node = event.target.closest('[data-node]'), edge = event.target.closest('[data-edge]');
    if (types) { filter = types.dataset.types ? types.dataset.types.split(',') : null; load(active.seed); }
    else if (edge) evidence(edge.dataset.edge);
    else if (node) load(node.dataset.node);
    else if (at) pick(at.dataset.pick);
  };
  root.onkeydown = function (event) {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('g[data-pick]')) { event.preventDefault(); pick(event.target.dataset.pick); }
  };
  document.getElementById('resolve').onsubmit = async function (event) {
    event.preventDefault();
    try {
      var result = await api.callTool('resolve_entity', { query: new FormData(event.target).get('query'), limit: 20 });
      document.getElementById('candidates').innerHTML = result.results.length ? '<p>' + result.total_matches + ' candidates' + (result.has_more ? ' · refine the name to narrow this list' : '') + '</p><ul>' + result.results.map(function (n) { return '<li><button class="row-button" data-node="' + esc(n.id) + '">' + esc(n.label) + '</button> · ' + esc(n.type) + ' · ' + esc(n.id) + '</li>'; }).join('') + '</ul>' : '<p class="empty">No matching entity. Try a broader name.</p>';
    } catch (_) {}
  };
}
api.onResult(render);
`;
export const GRAPH_HTML = page("AMIRA — entity graph", CSS, SCRIPT);
