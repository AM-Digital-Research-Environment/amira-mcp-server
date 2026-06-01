import { z } from "zod";
import { ensureStore } from "../data.js";
import type { Publication } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  capText,
  containsCI,
  equalsCI,
  paginate,
  publicationSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { publicationsUrl } from "../urls.js";

function contributorNames(p: Publication): string[] {
  return [...(p.authors ?? []), ...(p.editors ?? []), ...(p.book_editors ?? [])].map(
    (c) => c.normalized || c.raw,
  );
}

export function registerPublicationTools(server: Server): void {
  // === search_publications ==================================================
  server.registerTool(
    "search_publications",
    {
      title: "Search publications",
      description:
        "Search the cluster bibliography (~260 academic publications harvested from ERef + EPub Bayreuth: " +
        "journal articles, books, chapters, theses, conference papers, etc.). Filters (optional, " +
        "AND-combined):\n" +
        "  - keyword: match title, abstract or keywords\n" +
        "  - author: a contributor name (author/editor)\n" +
        "  - type: article | book | chapter | conference | doctoral_thesis | working_paper | report | ...\n" +
        "  - year_from / year_to: publication-year range\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Results are newest-first. Each has id, title, type, year, authors, venue, doi, `url` (the " +
        "publication's own DOI/permalink — the primary citation) and a `dashboard_url` to the publications " +
        "page. Use get_publication for full metadata and BibTeX.",
      annotations: annotate("Search publications"),
      inputSchema: {
        keyword: z.string().optional(),
        author: z.string().optional(),
        type: z.string().optional(),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        limit: z.number().int().optional().describe("Default 25, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);

      const filtered = store.publications.filter((p) => {
        if (args.keyword) {
          const k = args.keyword;
          if (!(containsCI(p.title, k) || containsCI(p.abstract, k) || anyContainsCI(p.keywords, k)))
            return false;
        }
        if (args.author && !anyContainsCI(contributorNames(p), args.author)) return false;
        if (args.type && !equalsCI(p.type, args.type)) return false;
        if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
        return true;
      });

      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

      return textResult(
        paginate(filtered.map(publicationSummary), offset, limit, {
          filters: {
            keyword: args.keyword ?? null,
            author: args.author ?? null,
            type: args.type ?? null,
            year_from: args.year_from ?? null,
            year_to: args.year_to ?? null,
          },
        }),
      );
    },
  );

  // === get_publication ======================================================
  server.registerTool(
    "get_publication",
    {
      title: "Get publication detail",
      description:
        "Full metadata for one publication by `id` (e.g. 'eref-95983', 'epub-12345'). Returns title, type, " +
        "authors, editors, book editors, year, venue fields (journal/booktitle/series/volume/issue/pages), " +
        "publisher, DOI, ISBN/ISSN, keywords, abstract (truncated at 25,000 chars), language, the canonical " +
        "`url`, source repository links (eref_url/epub_url), ready-to-use BibTeX, and a `dashboard_url`. " +
        "Returns { error } if the id is unknown.",
      annotations: annotate("Get publication detail"),
      inputSchema: { id: z.string().describe("Publication id, e.g. 'eref-95983'") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const p = store.publications.find((x) => x.id === id);
      if (!p) {
        return textResult({
          error: `No publication with id '${id}'. Use search_publications to find valid ids.`,
        });
      }
      const names = (list?: Publication["authors"]) => (list ?? []).map((c) => c.normalized || c.raw);
      return textResult({
        id: p.id,
        title: p.title,
        type: p.type,
        year: p.year ?? null,
        authors: names(p.authors),
        editors: names(p.editors),
        book_editors: names(p.book_editors),
        journal: p.journal ?? null,
        booktitle: p.booktitle ?? null,
        series: p.series ?? null,
        volume: p.volume ?? null,
        issue: p.issue ?? null,
        pages: p.pages ?? null,
        publisher: p.publisher ?? null,
        address: p.address ?? null,
        event_location: p.event_location ?? null,
        event_dates: p.event_dates ?? null,
        doi: p.doi ?? null,
        isbn: p.isbn ?? null,
        issn: p.issn ?? null,
        keywords: p.keywords ?? [],
        language: p.language ?? null,
        abstract: p.abstract ? capText(p.abstract).text : null,
        url: p.url ?? null,
        eref_url: p.eref_url ?? null,
        epub_url: p.epub_url ?? null,
        bibtex: p.bibtex_raw ?? null,
        dashboard_url: publicationsUrl(),
      });
    },
  );
}
