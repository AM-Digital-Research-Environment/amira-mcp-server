import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  capText,
  containsCI,
  equalsCI,
  filtersEcho,
  pageOf,
  publicationSummary,
  refLabels,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

const BIBTEX_ENTRY: Record<string, string> = {
  article: "article",
  book: "book",
  chapter: "incollection",
  conference: "inproceedings",
  doctoral_thesis: "phdthesis",
  working_paper: "techreport",
  journal_issue: "misc",
  book_review: "article",
  online_post: "misc",
  research_data: "misc",
};

/** Minimal BibTeX from the structured fields (Omeka carries no raw BibTeX). */
function toBibtex(p: PublicationRec): string {
  const entry = BIBTEX_ENTRY[p.type] ?? "misc";
  const esc = (s: string) => s.replace(/[{}]/g, "");
  const lines: string[] = [];
  const add = (k: string, v: string | null | undefined) => {
    if (v) lines.push(`  ${k} = {${esc(v)}}`);
  };
  add("author", refLabels(p.authors).join(" and "));
  add("editor", refLabels(p.editors).join(" and "));
  add("title", p.title);
  if (p.type === "article" || p.type === "book_review") add("journal", p.venue);
  else if (p.type === "chapter" || p.type === "conference") add("booktitle", p.venue);
  else add("series", p.venue);
  add("year", p.year != null ? String(p.year) : null);
  add("volume", p.volume);
  add("number", p.issue);
  add("pages", p.pages);
  add("publisher", p.publisher);
  add("doi", p.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  add("isbn", p.isbn);
  add("issn", p.issn);
  add("url", p.doi ?? p.urls[0]);
  return `@${entry}{${p.pub_id},\n${lines.join(",\n")}\n}`;
}

export function registerPublicationTools(server: Server): void {
  // === search_publications ==================================================
  server.registerTool(
    "search_publications",
    {
      title: "Search publications",
      description:
        "Search the cluster bibliography (~250 academic publications harvested from ERef/EPub Bayreuth " +
        "into the collection: journal articles, books, chapters, theses, conference papers, working " +
        "papers, etc.). Filters (optional, AND-combined):\n" +
        "  - keyword: match title, abstract, venue or subjects\n" +
        "  - author: a contributor name (either order works)\n" +
        "  - type: article | book | chapter | conference | doctoral_thesis | working_paper | " +
        "journal_issue | book_review | online_post | research_data\n" +
        "  - year_from / year_to: publication-year range\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Results are newest-first. Each has id, title, type, year, authors, venue, doi, `url` (the " +
        "publication's own DOI/permalink — the primary citation) and its `amira_url`. Use " +
        "get_publication for full metadata and BibTeX.",
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
          if (
            !(
              containsCI(p.title, k) ||
              containsCI(p.abstract, k) ||
              containsCI(p.venue, k) ||
              anyContainsCI(refLabels(p.subjects), k)
            )
          )
            return false;
        }
        if (
          args.author &&
          !refLabels(p.authors)
            .concat(refLabels(p.editors))
            .some((n) => nameMatchesQuery(n, args.author!) || containsCI(n, args.author!))
        )
          return false;
        if (args.type && !equalsCI(p.type, args.type)) return false;
        if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
        return true;
      });

      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

      return textResult(pageOf(filtered, offset, limit, publicationSummary, filtersEcho(args)));
    },
  );

  // === get_publication ======================================================
  server.registerTool(
    "get_publication",
    {
      title: "Get publication detail",
      description:
        "Full metadata for one publication by `id` (e.g. 'eref-94882'; the numeric Omeka o:id also " +
        "works). Returns title, type, authors, editors, year, venue (journal/book/series), volume, " +
        "issue, pages, publisher, DOI, ISBN/ISSN, abstract (truncated at 25,000 chars), subjects, " +
        "language, repository links (ERef/EPub), BibTeX generated from the structured fields, and the " +
        "citable `amira_url`. Cite the `url` (DOI or repository permalink) as the primary reference. " +
        "Returns { error } if the id is unknown.",
      annotations: annotate("Get publication detail"),
      inputSchema: { id: z.string().describe("Publication id, e.g. 'eref-94882'") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const p = store.getPublication(id);
      if (!p) {
        return textResult({
          error: `No publication with id '${id}'. Use search_publications to find valid ids.`,
        });
      }
      return textResult({
        id: p.pub_id,
        title: p.title,
        type: p.type,
        year: p.year,
        date: p.date,
        authors: refLabels(p.authors),
        editors: refLabels(p.editors),
        venue: p.venue,
        volume: p.volume,
        issue: p.issue,
        pages: p.pages,
        publisher: p.publisher,
        doi: p.doi,
        isbn: p.isbn,
        issn: p.issn,
        subjects: refLabels(p.subjects),
        language: p.language,
        abstract: p.abstract ? capText(p.abstract).text : null,
        url: p.doi ?? p.urls[0] ?? null,
        repository_urls: p.urls,
        bibtex: toBibtex(p),
        amira_url: itemUrl(p.o_id),
      });
    },
  );
}
