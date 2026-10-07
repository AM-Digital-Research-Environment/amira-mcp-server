// Shared research-item selection: search_research_items, list_years,
// list_locations, compare_collections, the map app and the export resource all
// filter through `selectResearchItems`, so a filter can never mean different
// things in different tools. Returns data and typed errors; tools render them.
import { z } from "zod";
import { DataStore, UNIVERSITY_LABELS } from "./data.js";
import type { LinkedRef, ResearchItemRec, University } from "./types.js";
import {
  anyContainsCI, containsCI, emptyKeyword, equalsCI, keywordMatchesFolded, parseKeyword, placeAliases, refLabels, wordPrefixMatch,
} from "./matching.js";
import { personMatches } from "./names.js";
import { allowDescriptive, allowStructured } from "./exposure.js";
import { fold } from "./text.js";
import { stripTypedId } from "./typedIds.js";

const query = z.string().max(1000).optional();
/** An ISO date or date-time ("2026-09-01"). Checked at run time by
 * `invalidDate`: a regex here would be repeated in every tool's schema. */
export const isoDate = z.string().max(40);
export const invalidDate = (value: string | undefined): boolean =>
  value !== undefined && !(/^\d{4}(-\d{2}){0,2}([T ].*)?$/.test(value.trim()) && Number.isFinite(Date.parse(value)));
export const researchFilters = z.strictObject({
  keyword: query, subject: query, location: query, country: query, contributor: query,
  location_id: z.number().int().positive().optional(),
  project_id: z.union([z.string().max(256), z.number().int().positive()]).optional(),
  research_section: query, university: query, resource_type: query, genre: query,
  collection: query, language: query,
  year_from: z.number().int().min(0).max(2200).optional(),
  year_to: z.number().int().min(0).max(2200).optional(),
  has_media: z.boolean().optional(),
  added_since: isoDate.optional(),
  modified_since: isoDate.optional(),
});
export type ResearchFilters = z.infer<typeof researchFilters>;

/** Filters that reveal relational (structured-level) metadata. */
const STRUCTURED_FILTERS = ["subject", "location", "location_id", "country", "contributor", "project_id", "research_section",
  "university", "genre", "collection", "language"] as const;

export interface QueryError { code: string; message: string; needs?: "structured" | "descriptive" | "full" }

/**
 * One exposure and range gate for every caller of `selectResearchItems`. Before
 * 1.19 list_years refused any `filters` object below `structured` while
 * search_research_items allowed keyword and year filters at the same level.
 */
export function researchFilterError(args: ResearchFilters): QueryError | null {
  if (invalidYearRange(args.year_from, args.year_to)) {
    return { code: "invalid_range", message: "`year_from` must be less than or equal to `year_to`." };
  }
  for (const key of ["added_since", "modified_since"] as const) {
    if (invalidDate(args[key])) return { code: "invalid_date", message: `\`${key}\` must be an ISO date such as 2026-09-01.` };
  }
  if (!allowStructured()) {
    const used = STRUCTURED_FILTERS.filter((key) => args[key] != null);
    if (used.length) {
      return { code: "exposure_restricted", needs: "structured",
        message: `The ${used.map((u) => `\`${u}\``).join(", ")} filter${used.length > 1 ? "s are" : " is"} not available` };
    }
  }
  return null;
}

export function invalidYearRange(from?: number, to?: number): boolean {
  return from !== undefined && to !== undefined && from > to;
}

/** University code or (partial) label: "ujkz" or "Joseph Ki-Zerbo". */
export function matchesUniversity(code: University, query: string): boolean {
  return code === query.trim().toLowerCase() || containsCI(UNIVERSITY_LABELS[code], query);
}

/** Folded labels of every known place (authorities and literal item places). */
function knownPlaceLabels(store: DataStore): Set<string> {
  return store.cached("places:labels", () => {
    const labels = new Set(store.locations.map((l) => fold(l.name)));
    for (const it of store.items) for (const p of it.places) for (const label of store.placeChain(p)) labels.add(fold(label));
    return labels;
  });
}

/**
 * A place predicate over an item's places.
 *
 * `country` compares the chain ROOT exactly (with aliases): "Niger" used to be
 * a substring of "Nigeria" and returned 390 items, 304 of them Nigerian.
 * `any` matches every level exactly when the query names a known place,
 * otherwise falls back to word prefixes ("Ibad" → Ibadan) — never mid-word.
 */
export function placeMatcher(store: DataStore, query: string, level: "any" | "country"): (ref: LinkedRef) => boolean {
  const names = placeAliases(query);
  const chains = foldedChains(store);
  const chainOf = (ref: LinkedRef): string[] => {
    const key = ref.o_id != null ? `id:${ref.o_id}` : `label:${ref.label}`;
    let chain = chains.get(key);
    if (!chain) chains.set(key, chain = store.placeChain(ref).map(fold));
    return chain;
  };
  if (level === "country") return (ref) => names.has(chainOf(ref).at(-1)!);
  const known = knownPlaceLabels(store);
  const exact = [...names].some((n) => known.has(n));
  return exact
    ? (ref) => chainOf(ref).some((label) => names.has(label))
    : (ref) => store.placeChain(ref).some((label) => wordPrefixMatch(label, query));
}

/** Folded place chains (self → country) per place reference, memoised per snapshot. */
function foldedChains(store: DataStore): Map<string, string[]> {
  return store.cached("places:folded-chains", () => new Map<string, string[]>());
}

/** Up to five known place names close to a query that matched nothing. */
export function placeSuggestions(store: DataStore, query: string, level: "any" | "country"): string[] {
  const q = fold(query.trim());
  if (!q) return [];
  const labels = new Map<string, string>();
  for (const l of store.locations) {
    if (level === "country" && l.parent) continue;
    labels.set(fold(l.name), l.name);
  }
  const scored: [string, number][] = [];
  for (const [folded, label] of labels) {
    const score = folded.includes(q) || q.includes(folded) ? 2 : folded.startsWith(q.slice(0, 3)) ? 1 : 0;
    if (score) scored.push([label, score]);
  }
  return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([label]) => label);
}

function yearsOverlap(item: ResearchItemRec, from?: number, to?: number): boolean {
  if (item.year_min == null) return false;
  const lo = item.year_min;
  const hi = item.year_max ?? item.year_min;
  return lo <= (to ?? Infinity) && hi >= (from ?? -Infinity);
}

/** Record timestamp at or after an ISO date (records without one never match). */
export function sinceMatches(stamp: string | null | undefined, since: string): boolean {
  const t = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(t) && t >= Date.parse(since);
}

/** Names of the API parameters behind a predicate, for relaxation hints. */
const HINT_NAMES: Record<string, string> = { year: "year_from/year_to" };

export function selectResearchItems(store: DataStore, args: ResearchFilters) {
  const projectKey = args.project_id != null ? stripTypedId(String(args.project_id), ["project"]) : undefined;
  const project = projectKey != null ? store.getProject(projectKey) : undefined;

  // One predicate per active filter, so a zero-result set can be probed by
  // dropping each filter in turn (relaxation hints).
  const preds: Record<string, (it: ResearchItemRec) => boolean> = {};
  if (args.keyword) {
    const parsed = parseKeyword(args.keyword);
    if (!emptyKeyword(parsed)) {
      const desc = allowDescriptive();
      const index = store.cached(desc ? "research:descriptive" : "research:titles", () => new Map(store.items.map((it) => [it.o_id,
        [it.title, ...it.alt_titles, ...(desc ? [it.description, it.abstract, it.toc, ...it.identifiers] : [])]
          .filter((s): s is string => !!s).map(fold)])));
      const keyword = args.keyword;
      preds.keyword = (it) => keywordMatchesFolded(parsed, index.get(it.o_id)!) || (desc && equalsCI(it.dre_id, keyword));
    }
  }
  if (args.subject) preds.subject = (it) => it.subjects.some((s) => containsCI(s.label, args.subject!));
  if (args.location) {
    const match = placeMatcher(store, args.location, "any");
    preds.location = (it) => it.places.some(match);
  }
  if (args.location_id != null) preds.location_id = (it) => it.places.some((ref) => store.placeChainRefs(ref).some((p) => p.o_id === args.location_id));
  if (args.country) {
    const match = placeMatcher(store, args.country, "country");
    preds.country = (it) => it.places.some(match);
  }
  if (args.contributor) preds.contributor = (it) => it.contributors.some((c) => personMatches(c.name, args.contributor!));
  if (args.project_id != null)
    preds.project_id = (it) =>
      project ? it.project?.o_id === project.o_id : equalsCI(it.project?.label, String(args.project_id));
  if (args.research_section) {
    const section = store.getSection(args.research_section) ?? store.getSectionByOId(Number(stripTypedId(args.research_section, ["section"])));
    preds.research_section = (it) => section
      ? store.sectionRefsOfItem(it).some((s) => s.o_id === section.o_id || equalsCI(s.label, section.name))
      : store.sectionRefsOfItem(it).some((s) => equalsCI(s.label, args.research_section!));
  }
  if (args.university) preds.university = (it) => matchesUniversity(it.university, args.university!);
  if (args.resource_type) preds.resource_type = (it) => equalsCI(it.type, args.resource_type!);
  if (args.genre)
    preds.genre = (it) =>
      anyContainsCI(refLabels(it.formats), args.genre!) || anyContainsCI(it.format_notes, args.genre!);
  if (args.collection) {
    const q = stripTypedId(args.collection.trim(), ["collection"]);
    const asId = Number(q);
    preds.collection = (it) => it.item_sets.some((id) => id === asId || containsCI(store.getItemSet(id)?.title, q));
  }
  if (args.language) preds.language = (it) => store.languageIndex.matches(it.languages, args.language!);
  if (args.year_from !== undefined || args.year_to !== undefined)
    preds.year = (it) => yearsOverlap(it, args.year_from, args.year_to);
  if (args.has_media !== undefined) preds.has_media = (it) => it.has_media === args.has_media;
  if (args.added_since) preds.added_since = (it) => sinceMatches(it.created, args.added_since!);
  if (args.modified_since) preds.modified_since = (it) => sinceMatches(it.modified, args.modified_since!);

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
    ? [...near].map(([key, would_match]) => ({ remove_filter: HINT_NAMES[key] ?? key, would_match }))
      .sort((a, b) => b.would_match - a.would_match) : [];
  // A place that matched nothing at all is most often a spelling the authority
  // does not use; name the closest stored ones.
  const didYouMean: { filter: string; values: string[] }[] = [];
  if (!filtered.length) {
    for (const [filter, level] of [["location", "any"], ["country", "country"]] as const) {
      const value = args[filter];
      const matcher = value ? placeMatcher(store, value, level) : null;
      if (value && matcher && !store.items.some((it) => it.places.some(matcher))) {
        const values = placeSuggestions(store, value, level);
        if (values.length) didYouMean.push({ filter, values });
      }
    }
  }
  return {
    filtered,
    suggestions: suggestions.length ? suggestions : undefined,
    did_you_mean: didYouMean.length ? didYouMean : undefined,
  };
}
