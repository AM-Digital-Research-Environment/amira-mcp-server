// MCP App: the collection's coverage-over-time histogram — the visual form of
// list_years. Mirrors the "Timeline (bar by year)" chart the DREVisualizations
// module renders on the AMIRA site, so the chat and the site agree.
//
// Single series (one bar per year), so the accent carries no identity; colours,
// bridge and page chassis all come from ./shell.

import { PICKER_JS, page } from "./shell.js";

export const TIMELINE_URI = "ui://amira/timeline";

const CSS = String.raw`
.chart { width: 100%; overflow-x: auto; }
`;

const SCRIPT = String.raw`
var esc = window.amiraApp.esc;
var api = window.amiraApp;
var W = 720, H = 240, PAD_L = 40, PAD_R = 8, PAD_T = 10, PAD_B = 26;

// Projects with research items, by name; a project is chosen by id but a name
// passed by the model still selects it. Subjects are suggestions, ranked by use.
function projects() {
  return pickerLoad("projects", "search_projects", { limit: 100 }, function (r) {
    return r.item_count ? { value: String(r.id), alt: r.name, label: r.name + " (" + r.item_count + ")" } : null;
  }, function (a, b) { return a.alt.localeCompare(b.alt); });
}
function subjects() {
  return pickerLoad("subjects", "list_subjects", { limit: 300 }, function (r) { return { value: r.subject }; });
}

function render(payload) {
  var rows = (payload && payload.results) || [];
  var root = document.getElementById("root");
  var isDecade = payload.bucket === "decade";
  var unit = isDecade ? "decade" : "year";

  if (!rows.length) {
    root.innerHTML = "<h1>AMIRA — research items per " + unit + "</h1>" +
      '<p class="empty">No dated items in this range.</p><button id="reset-range">Clear filters</button>';
    document.getElementById('reset-range').onclick=reset;
    return;
  }

  // list_years can be sorted by count; a timeline must read left to right.
  var data = rows
    .map(function (r) {
      return { key: isDecade ? r.from : r.year, label: isDecade ? r.decade : String(r.year), n: r.item_count };
    })
    .sort(function (a, b) { return a.key - b.key; });

  var max = data.reduce(function (m, d) { return Math.max(m, d.n); }, 0) || 1;
  var innerW = W - PAD_L - PAD_R, innerH = H - PAD_T - PAD_B;
  var step = innerW / data.length;
  var barW = Math.max(1, step - (step > 6 ? 2 : 0.5)); // 2px surface gap between bars

  var parts = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Research items per ' +
    unit + '" preserveAspectRatio="xMidYMid meet">'];

  [0, 0.5, 1].forEach(function (f) {
    var y = PAD_T + innerH - f * innerH;
    parts.push('<line class="grid" x1="' + PAD_L + '" y1="' + y + '" x2="' + (W - PAD_R) + '" y2="' + y + '" />');
    parts.push('<text class="axis" x="' + (PAD_L - 6) + '" y="' + (y + 3) + '" text-anchor="end">' +
      Math.round(f * max) + "</text>");
  });

  data.forEach(function (d, i) {
    var h = (d.n / max) * innerH;
    var x = PAD_L + i * step;
    var y = PAD_T + innerH - h;
    parts.push('<rect class="bar" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) +
      '" height="' + Math.max(h, 0.6).toFixed(1) + '" rx="' + (barW > 8 ? 3 : 0) + '" role="button" tabindex="0" data-year="' + d.key + '" aria-label="Browse ' + esc(d.label) + '"><title>' +
      esc(d.label) + ": " + d.n + (d.n === 1 ? " item" : " items") + "</title></rect>");
  });

  // Selective labels only — never one per bar.
  var every = Math.ceil(data.length / Math.max(2, Math.floor(innerW / 46)));
  data.forEach(function (d, i) {
    if (i % every !== 0 && i !== data.length - 1) return;
    parts.push('<text class="axis" x="' + (PAD_L + i * step + barW / 2).toFixed(1) + '" y="' + (H - 8) +
      '" text-anchor="middle">' + esc(d.label) + "</text>");
  });
  parts.push("</svg>");

  var current = (payload.filters || {}).filters || {};
  var subject = { name: "subject", kind: "suggest", current: current.subject };
  var project = { name: "project_id", kind: "select", any: "All projects", maxlength: 256,
    current: current.project_id == null ? "" : String(current.project_id).replace(/^project:/i, "") };
  var subjectList = pickerNow("subjects"), projectList = pickerNow("projects");
  var range = payload.year_range ? " spanning " + payload.year_range.min + "–" + payload.year_range.max : "";
  root.innerHTML =
    "<h1>AMIRA — research items per " + unit + "</h1>" +
    '<p class="sub">' + payload.dated_items + " dated items" + range +
    (payload.undated_items ? " · " + payload.undated_items + " undated" : "") + "</p>" +
    '<div class="chart">' + parts.join("") + "</div>" +
    '<p class="note">An item whose content date is a range counts toward every ' + unit +
    " it spans, so the bars can sum to more than the item total. Showing " + rows.length + " of " + payload.total_matches + " buckets.</p>" +
    '<form id="timeline-filter"><div class="controls"><label>Subject' + pickerField(subject, subjectList) + '</label><label>Project' + pickerField(project, projectList) + '</label></div><div class="controls"><label for="brush-from">From year <output id="from-label"></output><input type="range" id="brush-from" name="from" min="' + data[0].key + '" max="' + (data[data.length-1].key+(isDecade?9:0)) + '" value="' + data[0].key + '"></label><label for="brush-to">To year <output id="to-label"></output><input type="range" id="brush-to" name="to" min="' + data[0].key + '" max="' + (data[data.length-1].key+(isDecade?9:0)) + '" value="' + (data[data.length-1].key+(isDecade?9:0)) + '"></label><button>Apply range</button></div></form>' +
    '<button id="reset-range">Clear filters</button><details><summary>Counts by ' + unit + '</summary><table><thead><tr><th>Period</th><th>Items</th></tr></thead><tbody>' + data.map(function(r){return '<tr><td><button data-year="' + r.key + '">' + esc(r.label) + '</button></td><td>' + r.n + '</td></tr>';}).join('') + '</tbody></table></details>' +
    (payload.has_more ? '<button id="next-buckets">Next buckets</button>' : '') + '<section id="timeline-evidence" class="evidence" aria-live="polite"></section>';
  pickerMount(subject, subjects(), subjectList); pickerMount(project, projects(), projectList);
  var from=document.getElementById('brush-from'),to=document.getElementById('brush-to');
  document.getElementById('reset-range').onclick=reset;
  function rangeLabels(){document.getElementById('from-label').textContent=from.value;document.getElementById('to-label').textContent=to.value;}
  from.oninput=to.oninput=rangeLabels;rangeLabels();
  var baseFilters=Object.assign({},(payload.filters||{}).filters||{});
  async function evidence(lo,hi,offset){
    try{
      var args=Object.assign({},baseFilters,{year_from:Math.max(lo,baseFilters.year_from||0),year_to:Math.min(hi,baseFilters.year_to||2200),offset:offset||0,limit:20});
      var d=await api.callTool('search_research_items',args);
      document.getElementById('timeline-evidence').innerHTML='<h2 tabindex="-1">' + lo + '–' + hi + ' · ' + d.total_matches + ' matching records</h2><ol start="' + (d.offset+1) + '">' + d.results.map(function(r){return '<li><a data-citation href="' + esc(r.amira_url) + '">' + esc(r.title) + '</a></li>';}).join('') + '</ol>' + (d.has_more?'<button id="next-evidence">Next records</button>':'');
      document.querySelector('#timeline-evidence h2').focus();
      var next=document.getElementById('next-evidence');if(next)next.onclick=function(){evidence(lo,hi,d.next_offset);};
    }catch(_) {}
  }
  root.onclick=function(event){var el=event.target.closest('[data-year]');if(el)evidence(Number(el.dataset.year),Number(el.dataset.year)+(isDecade?9:0));};
  root.onkeydown=function(event){if((event.key==='Enter'||event.key===' ')&&event.target.matches('rect[data-year]')){event.preventDefault();event.target.dispatchEvent(new MouseEvent('click',{bubbles:true}));}};
  document.getElementById('timeline-filter').onsubmit=async function(event){
    event.preventDefault();if(Number(from.value)>Number(to.value)){api.status('From year must precede to year.');return;}
    var form=new FormData(event.target);baseFilters.subject=form.get('subject')||undefined;baseFilters.project_id=form.get('project_id')||undefined;
    try{render(await api.callTool('list_years',{bucket:payload.bucket,from:Number(from.value),to:Number(to.value),filters:baseFilters,limit:200}));}catch(_) {}
  };
  var nextBuckets=document.getElementById('next-buckets');if(nextBuckets)nextBuckets.onclick=async function(){try{render(await api.callTool('list_years',Object.assign({},payload.filters||{},{bucket:payload.bucket,offset:payload.next_offset,limit:200})));}catch(_) {}};
}

async function reset(){try{render(await api.callTool('list_years',{bucket:'decade',limit:200}));}catch(_) {}}

window.amiraApp.onResult(render);
`;

export const TIMELINE_HTML = page("AMIRA — coverage over time", CSS, PICKER_JS + SCRIPT);
