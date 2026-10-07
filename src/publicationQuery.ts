// Shared publication selection for search, facets and the export resource.
// Counts always describe the complete filtered corpus, before pagination or
// summary formatting. Returns data and typed errors; the tools render them.
import { z } from "zod";
import type { DataStore } from "./data.js";
import type { PublicationRec } from "./types.js";
import { allowDescriptive, allowFullText, allowStructured, exposureLevel } from "./exposure.js";
import { personMatches } from "./names.js";
import { anyContainsCI, containsCI, emptyKeyword, equalsCI, keywordMatchesFolded, parseKeyword, refLabels } from "./matching.js";
import { fold, foldCached } from "./text.js";
import { invalidDate, isoDate, sinceMatches, type QueryError } from "./researchItemQuery.js";

export const publicationFilters = {
  keyword: z.string().max(1000).optional().describe("Title, abstracts, venue, subjects or full text; every word must match, quote a phrase"),
  author: z.string().max(1000).optional().describe("Author/editor name, either name order"),
  type: z.string().max(1000).optional().describe("Exact type; discover values with list_publication_facets"),
  venue: z.string().max(1000).optional().describe("Journal/book title, partial"),
  subject: z.string().max(1000).optional().describe("Subject heading, partial"),
  language: z.string().max(1000).optional().describe("Language name or ISO code"),
  has_fulltext: z.boolean().optional().describe("Filter by extracted full-text availability"),
  year_from: z.number().int().min(0).max(2200).optional(),
  year_to: z.number().int().min(0).max(2200).optional(),
  added_since: isoDate.optional().describe("Added to AMIRA on or after this ISO date"),
};
export type PublicationFilters = z.infer<z.ZodObject<typeof publicationFilters>>;

export function publicationFilterError(args: PublicationFilters): QueryError | null {
  if (args.year_from !== undefined && args.year_to !== undefined && args.year_from > args.year_to) {
    return { code: "invalid_range", message: "`year_from` must be less than or equal to `year_to`." };
  }
  if (invalidDate(args.added_since)) return { code: "invalid_date", message: "`added_since` must be an ISO date such as 2026-09-01." };
  for (const key of ["author", "venue", "subject", "language"] as const) {
    if (args[key] && !allowStructured()) return { code: "exposure_restricted", needs: "structured", message: `The \`${key}\` filter is not available` };
  }
  return null;
}

/** Every abstract (all languages) — only the first used to be searchable. */
export function abstractsOf(p: PublicationRec): string[] {
  return p.abstracts?.length ? p.abstracts.map((a) => a.text) : p.abstract ? [p.abstract] : [];
}

/** Every catalogued language of a publication. */
export function languagesOf(p: PublicationRec): string[] {
  return p.languages?.length ? p.languages : p.language ? [p.language] : [];
}

/** Folded metadata fields per publication at the current exposure level, built once
 * per snapshot: title, then abstracts (descriptive), then venue and subjects. */
function foldedMeta(store: DataStore): Map<number, string[]> {
  return store.cached(`publication-meta:${exposureLevel()}`, () => new Map(store.publications.map((p) => [p.o_id,
    [p.title, ...(allowDescriptive() ? abstractsOf(p) : []), ...(allowStructured() ? [p.venue, ...refLabels(p.subjects)] : [])]
      .filter((s): s is string => !!s).map(fold)])));
}

export function selectPublications(store: DataStore, args: PublicationFilters) {
  const fulltextOnly = new Set<number>();
  const parsed = args.keyword ? parseKeyword(args.keyword) : null;
  const keyword = parsed && !emptyKeyword(parsed) ? parsed : null;
  const meta = keyword ? foldedMeta(store) : null;
  const records = store.publications.filter((p) => {
    if (args.type && !equalsCI(p.type, args.type)) return false;
    if (args.venue && !containsCI(p.venue, args.venue)) return false;
    if (args.subject && !anyContainsCI(refLabels(p.subjects), args.subject)) return false;
    if (args.language && !store.languageIndex.matches(languagesOf(p).map((label) => ({ label, o_id: null })), args.language)) return false;
    if (args.has_fulltext !== undefined && !!p.fulltext !== args.has_fulltext) return false;
    if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
    if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
    if (args.added_since && !sinceMatches(p.created, args.added_since)) return false;
    if (args.author && ![...p.authors, ...p.editors].some((r) => personMatches(r.label, args.author!))) return false;
    if (keyword && meta) {
      const fields = meta.get(p.o_id) ?? [fold(p.title)];
      if (!keywordMatchesFolded(keyword, fields)) {
        if (!allowFullText() || !p.fulltext || !keywordMatchesFolded(keyword, [...fields, foldCached(p.fulltext)])) return false;
        fulltextOnly.add(p.o_id);
      }
    }
    return true;
  });
  return { records, fulltextOnly };
}
