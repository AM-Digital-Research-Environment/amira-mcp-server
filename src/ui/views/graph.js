// The graph view's script (src/ui/graph.ts names it). Plain browser JavaScript, run
// inside a function scope that returns `render` (src/ui/page.ts viewsScript),
// beside the shared helpers declared in ./globals.d.ts. Type-checked with
// tsconfig.views.json and linted by Biome. The trailing `export { render }`
// makes the file a module for those checks; the page assembler drops it.
var api = window.amiraApp, esc = api.esc, active, picked, filter = null, shown = null;
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
    evidenceList(document.getElementById('evidence'), 'Evidence · ' + data.total_matches + ' records', data,
      function (r) { return citation(r) + ' <span class="note">' + esc(r.corpus) + '</span>'; },
      'more-evidence', function (next) { evidence(id, next); });
    shown = { edge: active.edges.find(function (e) { return e.id === id; }), data: data };
    share();
  } catch (_) {}
}
// What the model is told: the graph's centre and type filter, the selected
// neighbour, and the link whose records are listed, with that page of records.
// Labels and titles are data; selectionContext.ts bounds and labels them.
function entity(n, role) { return { title: n.label, id: n.id, type: n.type, relation: role, amira_url: n.amira_url }; }
function share() {
  var nodes = new Map(active.nodes.map(function (n) { return [n.id, n]; })), node = picked && nodes.get(picked);
  // Entities, then the listed link: two shapes, as selectionContext.ts expects.
  var focus = /** @type {any[]} */ ([entity(nodes.get(active.seed), 'graph centre')]);
  if (node) focus.push(entity(node, 'selected neighbour'));
  if (shown && shown.edge) focus.push({ title: relationText(shown.edge), id: shown.edge.id, type: 'link', count: shown.edge.count });
  api.shareSelection({ view: 'graph',
    summary: 'Entity graph centred on the first focus entry. Edges shown: ' + active.edges.length + ' of ' + active.total_edges + '.' +
      (filter ? ' Neighbours are limited to the types in filters.' : '') + (node ? ' A neighbour is selected.' : '') +
      (shown ? ' Records behind the selected link: ' + shown.data.total_matches + '; listed: ' + shown.data.results.length + '.' : ''),
    filters: { types: filter || undefined },
    counts: { edges_shown: active.edges.length, total_edges: active.total_edges },
    focus: focus,
    records: shown ? shown.data.results.map(function (r) { return { title: r.title || r.label, id: r.id, corpus: r.corpus, amira_url: r.amira_url }; }) : [],
    records_label: 'records behind the selected link' });
}
/** A neighbour's links, strongest first, and the records behind the first. */
function pick(id) {
  var node = active.nodes.find(function (n) { return n.id === id; });
  if (!node) return;
  picked = id;
  share();
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
  shown = null;
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
    chips(d) + selectionControls() +
    (view ? '<div class="graph">' + view.svg + '</div><p class="note">Showing ' + view.shown + ' of ' + view.of + ' returned neighbours, grouped by type. Spoke length grows with the records behind each neighbour’s strongest link (square-root scale; the number is the count); solid spokes include a catalogue link, dashed spokes are co-occurrence only. Select a neighbour to read its records. All returned edges appear in the table.</p>'
      : '<p class="empty">' + (filter ? 'No neighbours of this type are recorded for this entity.' : 'No relationships are recorded for this entity.') + '</p>') +
    '<section class="pick" id="pick" aria-live="polite"></section><section class="evidence" id="evidence" aria-live="polite"></section>' +
    '<div class="scroll"><table><caption>Relationships and source records</caption><thead><tr><th>Entity</th><th>Relationship</th><th>Evidence</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  if (picked) pick(picked);
  else share();
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
      var result = await api.callTool('resolve_entity', { query: new FormData(/** @type {HTMLFormElement} */ (event.target)).get('query'), limit: 20 });
      document.getElementById('candidates').innerHTML = result.results.length ? '<p>' + result.total_matches + ' candidates' + (result.has_more ? ' · refine the name to narrow this list' : '') + '</p><ul>' + result.results.map(function (n) { return '<li><button class="row-button" data-node="' + esc(n.id) + '">' + esc(n.label) + '</button> · ' + esc(n.type) + ' · ' + esc(n.id) + '</li>'; }).join('') + '</ul>' : '<p class="empty">No matching entity. Try a broader name.</p>';
    } catch (_) {}
  };
}

export { render };
