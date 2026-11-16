// The router, last in the views script (src/ui/page.ts viewsScript): it hands
// each result the bridge receives to the view that renders it. A classic
// script, like ./_shared.js; `amiraViews` and `amiraViewOfTool` are written by
// the page assembler just before it (declared in ./globals.d.ts).
var amiraRoot = document.getElementById("root");
/** The view for a result: the host's toolInfo first, else the result's shape.
 * @param {any} payload
 * @returns {string | null} */
function amiraViewFor(payload) {
  var named = amiraViewOfTool[window.amiraApp.toolName() || ""];
  if (named) return named;
  var d = payload || {};
  if (Array.isArray(d.nodes) && Array.isArray(d.edges)) return "graph";
  if ("entity_type" in d && "matched_items" in d) return "related";
  if (d.counts && typeof d.counts === "object" && !("results" in d)) return "overview";
  if ("bucket" in d && "dated_items" in d) return "timeline";
  if ("items_without_place" in d) return "map";
  if (Array.isArray(d.results) && "total_matches" in d) return "bibliography";
  if (Array.isArray(d.results)) return "sections";
  return null;
}
window.amiraApp.onResult(function (payload) {
  var name = amiraViewFor(payload), view = name && amiraViews[name];
  if (!view) {
    amiraRoot.removeAttribute("data-view");
    amiraRoot.innerHTML = '<p class="empty">This result has no AMIRA view. Update the AMIRA extension to see it here; the answer in the conversation is unaffected.</p>';
    return;
  }
  if (amiraRoot.dataset.view !== name) {
    amiraRoot.onclick = amiraRoot.onkeydown = amiraRoot.onchange = null;
    amiraRoot.dataset.view = name;
    document.title = view.title;
  }
  view.render(payload);
});
