import { PICKER_JS, page } from "./shell.js";
export const BIBLIOGRAPHY_URI = "ui://amira/bibliography";
const SCRIPT = String.raw`
var api=window.amiraApp,esc=api.esc,active,selected=new Map(),filters={},lastLanguages=null;
// Languages are counted for the current search without its own language filter,
// so the other languages stay selectable. Authors are the whole bibliography.
var LANGUAGE_SCOPE=['keyword','author','type','venue','subject','has_fulltext','year_from','year_to','added_since'];
function languageKey(scope){return 'languages:'+JSON.stringify(scope);}
function languages(scope){return pickerLoad(languageKey(scope),'list_publication_facets',Object.assign({facet:'language',limit:100},scope),function(r){return {value:r.value,label:r.value+' ('+r.publication_count+')'};}).then(function(list){if(list)lastLanguages=list;return list;});}
function authors(){return pickerLoad('authors','list_publication_facets',{facet:'author',limit:100},function(r){return {value:r.value};});}
async function search(offset){try{render(await api.callTool('search_publications',Object.assign({},filters,{offset:offset||0,limit:20})));}catch(_) {}}
async function exportSelection(){
  if(!selected.size) return;
  var button=document.getElementById('export-selected');button.disabled=true;
  var format=document.getElementById('export-format').value;
  try{
    var entries=[];
    // Selected entries are capped at 25; two requests at a time avoid a burst against the host.
    var ids=Array.from(selected.keys());
    for(var i=0;i<ids.length;i+=2){
      var batch=await Promise.all(ids.slice(i,i+2).map(function(id){return api.callTool('get_publication',{id:id,citation_format:format});}));
      batch.forEach(function(p){entries.push(format==='csl-json'?p.csl_json:p[format]);});
    }
    var text=format==='csl-json'?JSON.stringify(entries,null,2):entries.join('\n\n');
    var how=await api.download(text,format==='bibtex'?'bib':format==='ris'?'ris':'json');
    api.status(how==='shown' ? 'This host cannot save files: the ' + entries.length + ' citations are shown below to copy.' : 'Exported ' + entries.length + ' selected publications.');
  }catch(error){api.status(error.message);}finally{button.disabled=selected.size===0;}
}
function selection(){var count=document.getElementById('selection-count');count.textContent=selected.size + ' selected (maximum 25)';document.getElementById('export-selected').disabled=!selected.size;}
function render(d){
  active=d;filters=Object.assign({},d.filters || {});delete filters.citation_format;
  var rows=d.results||[],scope={};
  LANGUAGE_SCOPE.forEach(function(k){if(filters[k]!==undefined)scope[k]=filters[k];});
  var author={name:'author',kind:'suggest',current:filters.author},language={name:'language',kind:'select',any:'Any language',current:filters.language};
  var authorList=pickerNow('authors'),languageList=pickerNow(languageKey(scope))||lastLanguages;
  document.getElementById('root').innerHTML='<h1>Cluster bibliography</h1><p class="sub">' + d.total_matches + ' matching publications · ' + (rows.length ? 'showing ' + (d.offset+1) + '–' + (d.offset+rows.length) : 'no results') + '</p>' +
    '<form id="publication-search"><div class="controls"><label>Keyword<input name="keyword" maxlength="1000" value="' + esc(filters.keyword || '') + '"></label><label>Author' + pickerField(author,authorList) + '</label><label>Language' + pickerField(language,languageList) + '</label></div><div class="controls"><label>From year<input type="number" min="0" max="2200" name="year_from" value="' + esc(filters.year_from || '') + '"></label><label>To year<input type="number" min="0" max="2200" name="year_to" value="' + esc(filters.year_to || '') + '"></label><button>Search bibliography</button><button type="button" id="clear-filters">Clear filters</button></div></form>' +
    '<div class="controls"><span id="selection-count"></span><label>Export format<select id="export-format"><option value="bibtex">BibTeX</option><option value="ris">RIS</option><option value="csl-json">CSL-JSON</option></select></label><button id="export-selected">Download selection</button><button id="clear-selection">Clear selection</button></div>' +
    (rows.length?'<table><thead><tr><th>Select</th><th>Publication</th><th>Year</th></tr></thead><tbody>' + rows.map(function(p){var id=String(p.omeka_id||p.id);return '<tr><td><input type="checkbox" data-id="' + esc(id) + '" aria-label="Select ' + esc(p.title) + '" ' + (selected.has(id)?'checked':'') + '></td><td><a data-citation href="' + esc(p.amira_url) + '">' + esc(p.title) + '</a><br><span class="note">' + esc((p.authors||[]).join('; ')) + (p.has_fulltext?' · Full text available':'') + '</span></td><td>' + esc(p.year || 'Undated') + '</td></tr>';}).join('')+'</tbody></table>':'<p class="empty">No publications match these filters. Try removing a filter.</p>')+
    '<div class="controls">' + (d.offset?'<button id="previous">Previous page</button>':'') + (d.has_more?'<button id="next">Next page</button>':'') + '</div><p class="note">Selections persist across pages. Citation exports contain the selected records; open a title to read its source catalogue entry.</p>';
  selection();
  pickerMount(author,authors(),authorList);pickerMount(language,languages(scope),languageList);
  document.getElementById('publication-search').onsubmit=function(event){event.preventDefault();var values=new FormData(event.target);var next=Object.assign({},filters);for(var entry of values){if(entry[1])next[entry[0]]=entry[0].startsWith('year_')?Number(entry[1]):entry[1];else delete next[entry[0]];}filters=next;search();};
  document.getElementById('clear-filters').onclick=function(){filters={};search();};
  document.getElementById('root').onchange=function(event){var box=event.target;if(!box.dataset.id)return;if(box.checked){if(selected.size>=25){box.checked=false;api.status('Select up to 25 publications per export.');return;}selected.set(box.dataset.id,true);}else selected.delete(box.dataset.id);selection();};
  document.getElementById('export-selected').onclick=exportSelection;
  document.getElementById('clear-selection').onclick=function(){selected.clear();render(active);};
  var next=document.getElementById('next');if(next)next.onclick=function(){search(d.next_offset);};
  var prev=document.getElementById('previous');if(prev)prev.onclick=function(){search(Math.max(0,d.offset-20));};
}
api.onResult(render);
`;
export const BIBLIOGRAPHY_HTML = page("AMIRA — cluster bibliography", "input[type=checkbox] { accent-color: var(--bar); min-height: 24px; width: 24px; } th:first-child { width: 50px; } th:last-child { width: 52px; } td:last-child, th { white-space: nowrap; }", PICKER_JS + SCRIPT);
