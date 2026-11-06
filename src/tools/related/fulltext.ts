// find_related entity_type=research_item: the seed article's neighbours on the
// ILAM full-text map (DRE Visualizations) stand in for the matched items.
import type { DataStore } from "../../data.js";
import { fulltextIndex, groupLabelNote, inMappedCollection, neighboursNote, sourceRef } from "../../fulltextMaps.js";
import { recordLinks } from "../../recordLinks.js";
import { itemUrl } from "../../urls.js";
import { errorResult, limitEcho, textResult, yearLabel } from "../_shared.js";
import { RelatedLists } from "./lists.js";
import { MATCHING } from "./matching.js";

export function relatedByFullText(store: DataStore, value: string, limit: number, requested: number | undefined) {
  const index = fulltextIndex(store);
  if (!index) return errorResult("fulltext_map_unavailable", "This snapshot carries no full-text map.");
  const item = store.getItem(value);
  if (!item) return errorResult("not_found", `No research item with id '${value}'.`, { suggested_tool: "search_research_items" });
  const article = index.articles.get(item.o_id);
  if (!article) {
    return errorResult("not_on_fulltext_map", inMappedCollection(index, item)
      ? `'${item.title}' is not on the full-text map (no full text, or excluded as shared section text, journal furniture or under 300 words).`
      : "Only articles of the ILAM journal African Music (collection 27724) are on the full-text map.", {
      suggested_tool: "search_research_items",
    });
  }
  // fulltextIndex keeps only neighbours present in the snapshot; pair each with
  // its item rather than trust that no lookup misses.
  const seed = article.neighbours.flatMap((n) => {
    const it = store.getItem(String(n.id));
    return it ? [{ it, score: n.score }] : [];
  });
  const lists = new RelatedLists();
  for (const { it } of seed) lists.add("research_item", recordLinks(store, "research_item", it.o_id));
  const group = index.groups.get(article.group);
  return textResult({
    entity_type: "research_item",
    value,
    seed_label: item.title,
    matching: MATCHING.research_item,
    amira_url: itemUrl(item.o_id),
    ...limitEcho(requested, 50, limit),
    matched_items: seed.length,
    content_group: group ? { id: group.id, label: group.label, label_ai_generated: true, note: groupLabelNote(index) } : null,
    closest_in_content: seed.map(({ it, score }) => ({ title: it.title, date: yearLabel(it), score, omeka_id: it.o_id,
      amira_url: itemUrl(it.o_id), ...(index.articles.get(it.o_id)?.group === article.group && group ? { same_group: true } : {}) })),
    neighbours_note: neighboursNote(index),
    source: sourceRef(index),
    ...lists.toResponse(limit),
  });
}
