import { page } from "./shell.js";
export const GRAPH_URI = "ui://amira/graph";
const CSS = String.raw`
.graph { max-width: 680px; margin: 0 auto; }
.graph text { fill: var(--ink); font-size: 12px; }
.graph circle { fill: var(--bar); }
.graph line { stroke: var(--border); stroke-width: 2; }
.graph .derived { stroke-dasharray: 4 4; }
.graph .centre { fill: var(--ink-strong); }
.graph .centre-label { fill: var(--surface-solid, #fff); font-weight: 600; }
.node-link { cursor: pointer; }
.node-link:focus-visible circle { stroke: var(--ink); stroke-width: 3; }
.row-button { text-align: left; border: 0; padding: 0; color: var(--bar); }
th:last-child { width: 100px; }
button[data-edge] { white-space: nowrap; }
@media (max-width: 480px) { .graph { overflow-x: auto; } .graph svg { min-width: 560px; } }
`;
const SCRIPT = String.raw`
var api = window.amiraApp, esc = api.esc, active, evidenceEdge;
function citation(r) { return '<a data-citation href="' + esc(r.amira_url) + '">' + esc(r.title || r.label) + '</a>'; }
async function load(seed) {
  try { render(await api.callTool('get_entity_graph', { seed: seed })); } catch (_) {}
}
async function evidence(id, offset) {
  evidenceEdge = id;
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
function render(d) {
  if (!d.nodes) return;
  active = d;
  var nodes = new Map(d.nodes.map(function (n) { return [n.id,n]; })), seed = nodes.get(d.seed);
  var neighbors = d.nodes.filter(function (n) { return n.id !== d.seed; }).slice(0, 12);
  var svg = ['<svg viewBox="0 0 680 420" role="img" aria-label="One-hop relationships for ' + esc(seed.label) + '">'];
  neighbors.forEach(function (n,i) {
    var angle = 2 * Math.PI * i / neighbors.length, x = 340 + Math.cos(angle) * 190, y = 200 + Math.sin(angle) * 150;
    var explicit = d.edges.some(function (e) { return e.kind === 'explicit' && (e.source === n.id || e.target === n.id); });
    svg.push('<line class="' + (explicit ? '' : 'derived') + '" x1="340" y1="200" x2="' + x + '" y2="' + y + '"/>');
    var label = n.label.length > 24 ? n.label.slice(0,23) + '…' : n.label;
    svg.push('<g class="node-link" role="button" tabindex="0" data-node="' + esc(n.id) + '" aria-label="Explore ' + esc(n.label) + '"><title>' + esc(n.label) + '</title><circle cx="' + x + '" cy="' + y + '" r="6"/><text text-anchor="middle" x="' + x + '" y="' + (y + 23) + '">' + esc(label) + '</text></g>');
  });
  svg.push('<circle class="centre" cx="340" cy="200" r="40"/><text class="centre-label" text-anchor="middle" x="340" y="204">' + esc(seed.type) + '</text></svg>');
  var rows = d.edges.map(function (e) {
    var other = nodes.get(e.source === d.seed ? e.target : e.source);
    return '<tr><td><button class="row-button" data-node="' + esc(other.id) + '">' + esc(other.label) + '</button><br><span class="note">' + esc(other.type) + '</span></td><td>' + esc(e.kind === 'explicit' ? e.relation.replaceAll('_',' ') : 'Co-occurrence · ' + e.relation.replace('shared_','').replaceAll('_',' ')) + '</td><td><button data-edge="' + esc(e.id) + '">' + e.count + (e.count===1?' record':' records') + '</button></td></tr>';
  }).join('');
  document.getElementById('root').innerHTML = '<h1>' + esc(seed.label) + '</h1><p class="sub">One-hop relationships · ' + d.edges.length + ' of ' + d.total_edges + ' edges' + (d.truncated ? ' · bounded view' : '') + '</p>' +
    '<form id="resolve" class="controls"><label>Find an entity<input name="query" maxlength="1000" required placeholder="Person, place, project or subject"></label><button>Find</button></form><div id="candidates"></div>' +
    (neighbors.length ? '<div class="graph">' + svg.join('') + '</div><p class="note">Showing up to 12 neighbours. Solid lines are catalogue links; dotted lines are co-occurrences. All returned edges appear below.</p>' : '<p class="empty">No relationships are recorded for this entity.</p>') +
    '<div class="scroll"><table><caption>Relationships and source records</caption><thead><tr><th>Entity</th><th>Relationship</th><th>Evidence</th></tr></thead><tbody>' + rows + '</tbody></table></div><section class="evidence" id="evidence" aria-live="polite"></section>';
  document.getElementById('root').onclick = function (event) {
    var node = event.target.closest('[data-node]'), edge = event.target.closest('[data-edge]');
    if (node) load(node.dataset.node); else if (edge) evidence(edge.dataset.edge);
  };
  document.getElementById('root').onkeydown = function (event) {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('g[data-node]')) { event.preventDefault(); load(event.target.dataset.node); }
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
