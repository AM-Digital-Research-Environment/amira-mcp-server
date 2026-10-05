// Shared publication selection for search and facets. Counts always describe
// the complete filtered corpus, before pagination or summary formatting.
import { z } from "zod";
import type { DataStore } from "./data.js";
import { allowDescriptive, allowFullText, allowStructured } from "./exposure.js";
import { nameMatchesQuery } from "./names.js";
import {
  anyContainsCI, containsCI, equalsCI, errorResult, exposureRestrictedResult, refLabels,
} from "./tools/_shared.js";

export const publicationFilters = {
  keyword: z.string().max(1000).optional().describe("Title, abstract, venue, subjects or full text; substring match"),
  author: z.string().max(1000).optional().describe("Author/editor name, either name order"),
  type: z.string().max(1000).optional().describe("Exact type; discover values with list_publication_facets"),
  venue: z.string().max(1000).optional().describe("Journal/book title, partial"),
  subject: z.string().max(1000).optional().describe("Subject heading, partial"),
  language: z.string().max(1000).optional().describe("Language name or ISO code"),
  has_fulltext: z.boolean().optional().describe("Filter by extracted full-text availability"),
  year_from: z.number().int().min(0).max(2200).optional(),
  year_to: z.number().int().min(0).max(2200).optional(),
};
export type PublicationFilters = z.infer<z.ZodObject<typeof publicationFilters>>;

export function publicationFilterError(args: PublicationFilters) {
  if (args.year_from !== undefined && args.year_to !== undefined && args.year_from > args.year_to) {
    return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
  }
  for (const key of ["author", "venue", "subject", "language"] as const) {
    if (args[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
  }
  return null;
}

export function selectPublications(store: DataStore, args: PublicationFilters) {
  const fulltextOnly = new Set<number>();
  const records = store.publications.filter((p) => {
    if (args.type && !equalsCI(p.type, args.type)) return false;
    if (args.venue && !containsCI(p.venue, args.venue)) return false;
    if (args.subject && !anyContainsCI(refLabels(p.subjects), args.subject)) return false;
    if (args.language && !store.languageIndex.matches(p.language ? [{ label: p.language, o_id: null }] : [], args.language)) return false;
    if (args.has_fulltext !== undefined && !!p.fulltext !== args.has_fulltext) return false;
    if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
    if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
    if (args.author && ![...p.authors, ...p.editors].some((r) => nameMatchesQuery(r.label, args.author!) || containsCI(r.label, args.author!))) return false;
    if (args.keyword) {
      const k = args.keyword;
      const inMeta = containsCI(p.title, k) ||
        (allowDescriptive() && containsCI(p.abstract, k)) ||
        (allowStructured() && (containsCI(p.venue, k) || anyContainsCI(refLabels(p.subjects), k)));
      if (!inMeta) {
        if (!allowFullText() || !containsCI(p.fulltext, k)) return false;
        fulltextOnly.add(p.o_id);
      }
    }
    return true;
  });
  return { records, fulltextOnly };
}
