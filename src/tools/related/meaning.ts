// find_related entity_type=record (#12, phase 2): the seed's closest records
// by meaning stand in for the matched records, across every embedded type,
// and the related_* lists count what they share.
import type { DataStore } from "../../data.js";
import { recordLinks } from "../../recordLinks.js";
import { semanticIndex, semanticRef, semanticSpace } from "../../semantic.js";
import { itemUrl } from "../../urls.js";
import { errorResult, limitEcho, textResult } from "../_shared.js";
import { noNeighboursReason, resolveSemanticSeed, semanticUnavailable } from "../similar.js";
import { RelatedLists } from "./lists.js";
import { MATCHING } from "./matching.js";

/** Records the `record` pivot counts: the seed's closest by meaning, of any type. */
const PIVOT_RECORDS = 20;

export function relatedByMeaning(store: DataStore, value: string, limit: number, requested: number | undefined) {
  const index = semanticIndex(store);
  if (!index) return semanticUnavailable("semantic neighbours", "find_related");
  const seed = resolveSemanticSeed(store, value, "find_related");
  if ("error" in seed) return seed.error;
  const { record } = seed;
  const reason = noNeighboursReason(index, record.o_id);
  if (reason) return errorResult("no_neighbours", reason, { suggested_tool: "find_related" });
  // The closest overall, not the stored ten of EVERY type: those would add the
  // few sections and podcasts however weakly they match, at equal weight. Taken
  // from the stored lists, so one type still contributes at most ten.
  const neighbours = (index.neighbours.get(record.o_id) ?? []).slice(0, PIVOT_RECORDS);

  const lists = new RelatedLists();
  const byType: Record<string, number> = {};
  for (const { record: n } of neighbours) {
    byType[n.kind] = (byType[n.kind] ?? 0) + 1;
    // A section's whole membership would swamp the people counts: a section
    // adds itself, not its dozens of members.
    lists.add(n.kind, recordLinks(store, n.kind, n.o_id), n.kind === "section" ? { people: () => true } : {});
  }
  return textResult({
    entity_type: "record",
    value,
    seed_label: record.title,
    seed: semanticRef(record),
    matching: MATCHING.record,
    amira_url: itemUrl(record.o_id),
    space: semanticSpace(index),
    ...limitEcho(requested, 50, limit),
    matched_records: neighbours.length,
    matched_by_type: byType,
    closest: neighbours.slice(0, 10).map(({ record: n, score }) => ({ ...semanticRef(n), score })),
    ...lists.toResponse(limit),
  });
}
