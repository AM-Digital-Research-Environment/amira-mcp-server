import { z } from "zod";
import { DataStore, UNIVERSITY_LABELS } from "./data.js";
import type { ResearchItemRec } from "./types.js";
import { containsCI, anyContainsCI, equalsCI, refLabels } from "./tools/_shared.js";
import { nameMatchesQuery } from "./names.js";
import { allowDescriptive } from "./exposure.js";
import { fold } from "./text.js";
const query = z.string().max(1000).optional();
export const researchFilters = z.strictObject({
  keyword: query, subject: query, location: query, country: query, contributor: query,
  location_id: z.number().int().positive().optional(),
  project_id: z.union([z.string().max(256), z.number().int().positive()]).optional(),
  research_section: query, university: query, resource_type: query, genre: query,
  collection: query, language: query,
  year_from: z.number().int().min(0).max(2200).optional(),
  year_to: z.number().int().min(0).max(2200).optional(),
});
export type ResearchFilters = z.infer<typeof researchFilters>;
function matchUniversity(item: ResearchItemRec, val: string): boolean {
  return item.university === val.trim().toLowerCase() || containsCI(UNIVERSITY_LABELS[item.university], val);
}

/** Place match across each place's full ancestor chain (city → country) — so
 * `location` covers any level: a country or a city alike. */
function placeMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => store.placeChain(p).some((label) => containsCI(label, needle)));
}

/** Country match: the value matches the COUNTRY (chain root, store.countryOf) of
 * any of the item's places — narrower than `location`, which matches any level.
 * An item tagged only with a city whose country ancestor is missing won't match
 * (the same gap `location` has). v1.4.1 restored this as a real, advertised
 * filter — v1.4.0 dropped it from the schema and tried to route a stray
 * `country` arg into `location`, but validation strips unknown keys before the
 * handler runs, so `country` was silently ignored (the reported regression). */
function countryMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => containsCI(store.countryOf(p), needle));
}

function yearsOverlap(item: ResearchItemRec, from?: number, to?: number): boolean {
  if (item.year_min == null) return false;
  const lo = item.year_min;
  const hi = item.year_max ?? item.year_min;
  return lo <= (to ?? Infinity) && hi >= (from ?? -Infinity);
}

export function invalidYearRange(from?: number, to?: number): boolean {
  return from !== undefined && to !== undefined && from > to;
}

export function selectResearchItems(store: DataStore, args: ResearchFilters) {
  const project = args.project_id != null ? store.getProject(String(args.project_id)) : undefined;

  // One predicate per active filter, so a zero-result set can be probed by
  // dropping each filter in turn (relaxation hints).
  const preds: Record<string, (it: ResearchItemRec) => boolean> = {};
  if (args.keyword) {
    const key = allowDescriptive() ? "research:descriptive" : "research:titles";
    const index = store.cached(key, () => new Map(store.items.map((it) => [it.o_id,
      [it.title, ...it.alt_titles, ...(allowDescriptive() ? [it.description, it.abstract, it.toc, ...it.identifiers] : [])]
        .filter((s): s is string => !!s).map(fold)])));
    const needle = fold(args.keyword);
    preds.keyword = (it) => index.get(it.o_id)!.some((text) => text.includes(needle)) || (allowDescriptive() && equalsCI(it.dre_id, args.keyword!));
  }
  if (args.subject) preds.subject = (it) => it.subjects.some((s) => containsCI(s.label, args.subject!));
  if (args.location) preds.location = (it) => placeMatches(store, it, args.location!);
  if (args.location_id != null) preds.location_id = (it) => it.places.some((ref) => store.placeChainRefs(ref).some((p) => p.o_id === args.location_id));
  if (args.country) preds.country = (it) => countryMatches(store, it, args.country!);
  if (args.contributor)
    preds.contributor = (it) =>
      it.contributors.some(
        (c) => nameMatchesQuery(c.name, args.contributor!) || containsCI(c.name, args.contributor!),
      );
  if (args.project_id != null)
    preds.project_id = (it) =>
      project ? it.project?.o_id === project.o_id : equalsCI(it.project?.label, String(args.project_id));
  if (args.research_section)
    preds.research_section = (it) => store.sectionsOfItem(it).some((s) => equalsCI(s, args.research_section!));
  if (args.university) preds.university = (it) => matchUniversity(it, args.university!);
  if (args.resource_type) preds.resource_type = (it) => equalsCI(it.type, args.resource_type!);
  if (args.genre)
    preds.genre = (it) =>
      anyContainsCI(refLabels(it.formats), args.genre!) || anyContainsCI(it.format_notes, args.genre!);
  if (args.collection) {
    const q = args.collection.trim();
    const asId = Number(q);
    preds.collection = (it) => it.item_sets.some((id) => id === asId || containsCI(store.getItemSet(id)?.title, q));
  }
  if (args.language) preds.language = (it) => store.languageIndex.matches(it.languages, args.language!);
  if (args.year_from !== undefined || args.year_to !== undefined)
    preds.year = (it) => yearsOverlap(it, args.year_from, args.year_to);


  const keys = Object.keys(preds);
  const filtered: ResearchItemRec[] = [];
  const near = new Map<string, number>();
  // Each predicate is evaluated at most once per record, including relaxation hints.
  for (const item of store.items) {
    let failed: string | undefined;
    let failures = 0;
    for (const key of keys) if (!preds[key]!(item)) {
      failed = key;
      if (++failures > 1) break;
    }
    if (!failures) filtered.push(item);
    else if (failures === 1 && failed) near.set(failed, (near.get(failed) ?? 0) + 1);
  }
  const suggestions = !filtered.length && keys.length >= 2
    ? [...near].map(([remove_filter, would_match]) => ({ remove_filter, would_match }))
      .sort((a, b) => b.would_match - a.would_match) : [];
  return { filtered, suggestions: suggestions.length ? suggestions : undefined };
}
