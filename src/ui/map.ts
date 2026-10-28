import type { AppView } from "./shell.js";
import land from "./land.json";
// Natural Earth 1:110m land, public domain. Source and checksum: docs/apps.md.
// Drawn on the viewBox's 720×360 plate carrée (2 units per degree) as INTEGER
// RELATIVE moves. The map is shown 600-900 px wide, so a unit is about a pixel
// and rounding to it is invisible; the outline was the largest piece of the
// app's script, and this form is a third of the absolute 0.1-unit one (about
// 20 KB against 58 KB). Coordinates are rounded before differencing, so no
// error accumulates along a ring; rings that round to under three points
// (specks of islands) are dropped.
const outline = land.features.flatMap((feature) =>
  (feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates) as number[][][][],
).flatMap((polygon) => polygon.map((ring) => {
  const points: [number, number][] = [];
  for (const [lon, lat] of ring) {
    const x = Math.round((lon! + 180) * 2), y = Math.round((90 - lat!) * 2), last = points.at(-1);
    if (!last || last[0] !== x || last[1] !== y) points.push([x, y]);
  }
  if (points.length < 3) return "";
  // One "l" command, then implicit repeats: a negative dx carries its own
  // separator, a positive one needs a space.
  return `M${points[0]![0]},${points[0]![1]}l` + points.slice(1).map(([x, y], i) => {
    const [px, py] = points[i]!, dx = x - px;
    return `${i && dx >= 0 ? " " : ""}${dx},${y - py}`;
  }).join("") + "z";
})).join("");
const CSS = String.raw`
.land { fill: var(--grid); stroke: var(--border); stroke-width: .5; }
.place { fill: var(--bar); stroke: var(--ink); stroke-width: .6; cursor: pointer; }
.place.root { fill: none; stroke: var(--bar); stroke-width: 2; stroke-dasharray: 3 2; }
.place:focus-visible { stroke: var(--ink-strong); stroke-width: 3; outline: none; }
.map { border: 1px solid var(--border); margin: 12px 0; }
.name-button { text-align: left; padding: 0; border: none; color: var(--bar); }
table { table-layout: fixed; }
th:nth-child(1) { width: 32%; } th:nth-child(2) { width: 30%; } th:nth-child(3) { width: 12%; } th:nth-child(4) { width: 26%; }
`;
const SCRIPT = String.raw`
var api=window.amiraApp, esc=api.esc, active, picked=null;
// Countries are the hierarchy roots in the map's current scope, by name.
function countryKey(scope){return 'countries:'+JSON.stringify(scope||{});}
function countries(scope){return pickerLoad(countryKey(scope),'list_locations',Object.assign({limit:300},scope?{filters:scope}:{}),function(r){return r.coordinate_scope==='hierarchy_root'?{value:r.name,label:r.name+' ('+r.item_count+')'}:null;},function(a,b){return a.value.localeCompare(b.value);});}
async function records(name, offset, id) {
  try {
    var args=Object.assign({}, (active.filters || {}).filters || {}, { limit:20, offset:offset || 0 }, id ? {location_id:Number(id)} : {location:name});
    var data=await api.callTool('search_research_items',args);
    document.getElementById('map-evidence').innerHTML='<h2 tabindex="-1">' + esc(name) + ' · ' + data.total_matches + ' matching records</h2><ol start="' + (data.offset+1) + '">' + data.results.map(function(r){return '<li><a data-citation href="' + esc(r.amira_url) + '">' + esc(r.title) + '</a></li>';}).join('') + '</ol>' + (data.has_more ? '<button id="more-records">Next records</button>' : '');
    document.querySelector('#map-evidence h2').focus();
    var more=document.getElementById('more-records'); if(more) more.onclick=function(){records(name,data.next_offset,id);};
    picked={name:name,id:id,data:data};share();
  } catch(_) {}
}
// What the model is told: the map's filters and, once the reader opens a
// place, that place and the page of its research items in view. Names and
// titles are data; selectionContext.ts bounds and labels them.
function share(){
  var f=active.filters||{},rows=active.results||[];
  var place=picked&&(rows.find(function(r){return picked.id&&String(r.omeka_id)===String(picked.id);})||{name:picked.name});
  api.shareSelection({view:'map',
    summary:picked?'One place is selected (the focus entry); '+picked.data.results.length+' of its '+picked.data.total_matches+' matching research items are listed.':'No place selected; '+active.total_matches+' places match the map filters.',
    filters:Object.assign({},f.filters||{},{country:f.country}),
    counts:Object.assign({places:active.total_matches,places_listed:rows.length},picked?{matching_items:picked.data.total_matches,items_offset:picked.data.offset}:{}),
    focus:place?[{title:place.name,id:place.omeka_id,type:place.coordinate_scope==='hierarchy_root'?'hierarchy root':'place',count:place.item_count,amira_url:place.amira_url}]:[],
    records:picked?picked.data.results.map(function(r){return {title:r.title,id:r.id,year:r.date,amira_url:r.amira_url};}):[],
    records_label:'research items at the selected place'});
}
function render(d){
  active=d;picked=null;
  var rows=d.results || [], mapped=rows.filter(function(r){return Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && Math.abs(r.latitude)<=90 && Math.abs(r.longitude)<=180;});
  var svg=['<svg viewBox="0 0 720 360" role="img" aria-label="Research locations on a world map"><path class="land" d="__OUTLINE__"/>'];
  mapped.forEach(function(r){var x=(r.longitude+180)*2,y=(90-r.latitude)*2;svg.push('<circle role="button" tabindex="0" class="place ' + (r.coordinate_scope==='hierarchy_root'?'root':'') + '" data-place-id="' + (r.omeka_id || '') + '" data-place="' + esc(r.name) + '" aria-label="Browse ' + esc(r.name) + '" cx="' + x + '" cy="' + y + '" r="' + Math.max(3,Math.min(10,Math.sqrt(r.item_count)/3)) + '"><title>' + esc(r.name) + ': ' + r.item_count + ' items</title></circle>');});
  svg.push('</svg>');
  var scope=(d.filters||{}).filters, country={name:'country',kind:'select',any:'All countries',placeholder:'All countries',current:(d.filters||{}).country},countryList=pickerNow(countryKey(scope));
  var filterForm='<form id="map-filter" class="controls"><label>Country' + pickerField(country,countryList) + '</label><button>Filter places</button></form>' + selectionControls();
  if(!rows.length){
    // Empty state: say so and keep the filter, rather than an empty map and "Places 1–0 of 0".
    document.getElementById('root').innerHTML='<h1>Research places</h1>' + filterForm +
      '<p class="empty">No research places match these filters. Clear the country filter or broaden the search.</p>';
  } else
  document.getElementById('root').innerHTML='<h1>Research places</h1><p class="sub">' + mapped.length + ' of ' + rows.length + ' returned places have coordinates · ' + (d.items_without_place || 0) + ' matching items have no place</p>' +
    filterForm + '<div class="map">' + svg.join('') + '</div>' +
    '<p class="note">Hollow markers show hierarchy roots, which may represent whole countries. Coordinates are catalogue locations, not inferred item positions. Counts include descendants and overlap. Made with Natural Earth.</p>' +
    '<table><caption>All returned places, including missing coordinates</caption><thead><tr><th>Place</th><th>Within</th><th>Items</th><th>Coordinates</th></tr></thead><tbody>' + rows.map(function(r){return '<tr><td><button class="name-button" data-place-id="' + (r.omeka_id || '') + '" data-place="' + esc(r.name) + '">' + esc(r.name) + '</button></td><td>' + esc(r.country || 'Hierarchy root') + '</td><td>' + r.item_count + '</td><td>' + (Number.isFinite(r.latitude) && Number.isFinite(r.longitude) ? r.latitude.toFixed(2) + ', ' + r.longitude.toFixed(2) : 'Not recorded') + '</td></tr>';}).join('') + '</tbody></table>' +
    '<p class="note">Places ' + (d.offset+1) + '–' + (d.offset+rows.length) + ' of ' + d.total_matches + '</p>' + (d.has_more ? '<button id="more-places">Next places</button>' : '') + '<section id="map-evidence" class="evidence" aria-live="polite"></section>';
  pickerMount(country,countries(scope),countryList);share();
  document.getElementById('root').onclick=function(event){var place=event.target.closest('[data-place]');if(place) records(place.dataset.place,0,place.dataset.placeId);};
  document.getElementById('root').onkeydown=function(event){if((event.key==='Enter'||event.key===' ')&&event.target.matches('circle[data-place]')){event.preventDefault();records(event.target.dataset.place,0,event.target.dataset.placeId);}};
  document.getElementById('map-filter').onsubmit=async function(event){event.preventDefault();try{render(await api.callTool('list_locations',{country:new FormData(event.target).get('country') || undefined,filters:(d.filters||{}).filters,limit:100}));}catch(_) {}};
  var next=document.getElementById('more-places');if(next)next.onclick=async function(){try{render(await api.callTool('list_locations',Object.assign({},d.filters || {},{offset:d.next_offset,limit:100})));}catch(_) {}};
}
`.replace("__OUTLINE__", outline);
export const MAP_VIEW: AppView = { name: "map", title: "AMIRA — research places", css: CSS, script: SCRIPT };
