// The router, last in the views script (src/ui/page.ts viewsScript): it hands
// each result the bridge receives to the view that renders it. A classic
// script, like ./_shared.js; `amiraViews` and `amiraViewOfTool` are written by
// the page assembler just before it (declared in ./globals.d.ts).
const amiraRoot = document.getElementById("root");
/** The view for a result: the host's toolInfo first, else the result's shape.
 * @param {Record<string, unknown>} payload
 * @returns {string | null} */
function amiraViewFor(payload) {
  const named = amiraViewOfTool[window.amiraApp.toolName() || ""];
  if (named) return named;
  const d = payload || {};
  if (Array.isArray(d.nodes) && Array.isArray(d.edges)) return "graph";
  // get_entity_graph with edge_id: one link's evidence, a page of records without nodes.
  if (typeof d.seed === "string" && "snapshot_id" in d && Array.isArray(d.results) && !("nodes" in d)) return "graph";
  // A record pivot (entity_type "record") counts matched_records instead.
  if ("entity_type" in d && ("matched_items" in d || "matched_records" in d)) return "related";
  // search_publications with `export`: a file link, not rows.
  const file = /** @type {Record<string, unknown> | undefined} */ (d.export);
  if (file && typeof file === "object" && file.corpus === "publications") return "bibliography";
  if (d.counts && typeof d.counts === "object" && !("results" in d)) return "overview";
  if ("bucket" in d && "dated_items" in d) return "timeline";
  if ("items_without_place" in d) return "map";
  if (Array.isArray(d.results) && "total_matches" in d) return "bibliography";
  if (Array.isArray(d.results)) return "sections";
  return null;
}
window.amiraApp.onResult(function (payload) {
  // Every request still loading now answers for a view no longer on screen
  // (_shared.js, request order), whichever view this result opens.
  nextGeneration();
  const name = amiraViewFor(payload),
    view = name && amiraViews[name];
  if (!view) {
    // The previous view's handlers must not act on this message.
    amiraRoot.onclick = amiraRoot.onkeydown = amiraRoot.onchange = null;
    amiraRoot.removeAttribute("data-view");
    amiraRoot.innerHTML =
      '<p class="empty">This result has no AMIRA view. Update the AMIRA extension to see it here; the answer in the conversation is unaffected.</p>';
    return;
  }
  if (amiraRoot.dataset.view !== name) {
    amiraRoot.onclick = amiraRoot.onkeydown = amiraRoot.onchange = null;
    amiraRoot.dataset.view = name;
    document.title = view.title;
  }
  view.render(payload);
});
