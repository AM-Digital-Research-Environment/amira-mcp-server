// The cluster bibliography (ERef/EPub harvest) + the Journal venue authority.
// Open-access publications carry extracted PDF full text (bibo:content):
// searchable here (with a match snippet), never included in summaries, and
// opt-in + windowable in get_publication — the same discipline as transcripts.
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  capText,
  containsCI,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitEcho,
  matchSnippet,
  pageOf,
  publicationSummary,
  refLabels,
  textAccessDisabledResult,
  textResult,
  textWindowFields,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
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
        "Search the cluster bibliography (~280 publications harvested from ERef/EPub Bayreuth: journal " +
        "articles, books, chapters, theses, conference and working papers). Open-access ones carry the " +
        "extracted FULL TEXT of their PDF and keyword search reaches into it — such a hit is flagged " +
        "`matched_in: 'fulltext'` with a `fulltext_snippet` around the match. Filters are optional and " +
        "AND-combined; results are newest-first. Cite each result's `url` (its DOI or repository " +
        "permalink) alongside the `amira_url`. Use get_publication for full metadata, BibTeX and the full " +
        "text (opt-in there).",
      annotations: annotate("Search publications"),
      inputSchema: z.object({
        keyword: z.string().optional().describe("Matches title, abstract, venue, subjects — and the full text where one exists"),
        author: z.string().optional().describe("A contributor name; either name order works"),
        type: z
          .string()
          .optional()
          .describe("article | book | chapter | conference | doctoral_thesis | working_paper | journal_issue | book_review | online_post | research_data"),
        venue: z.string().optional().describe("Journal/book/series title, partial. Journal titles come from list_journals"),
        has_fulltext: z.boolean().optional().describe("true → only publications with extracted, searchable full text"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Earliest publication year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Latest publication year"),
        limit: z.number().int().min(1).optional().describe("Default 25, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);
      if (args.author && !allowStructured()) return exposureRestrictedResult("structured", "The `author` filter");
      if (args.venue && !allowStructured()) return exposureRestrictedResult("structured", "The `venue` filter");

      const fulltextOnly = new Set<number>();
      const filtered = store.publications.filter((p) => {
        if (args.keyword) {
          const k = args.keyword;
          const inMeta =
            containsCI(p.title, k) ||
            (allowDescriptive() && containsCI(p.abstract, k)) ||
            (allowStructured() && (containsCI(p.venue, k) || anyContainsCI(refLabels(p.subjects), k)));
          const inFulltext = !inMeta && allowFullText() && containsCI(p.fulltext, k);
          if (!inMeta && !inFulltext) return false;
          if (inFulltext) fulltextOnly.add(p.o_id);
        }
        if (
          args.author &&
          !refLabels(p.authors)
            .concat(refLabels(p.editors))
            .some((n) => nameMatchesQuery(n, args.author!) || containsCI(n, args.author!))
        )
          return false;
        if (args.type && !equalsCI(p.type, args.type)) return false;
        if (args.venue && !containsCI(p.venue, args.venue)) return false;
        if (args.has_fulltext !== undefined && !!p.fulltext !== args.has_fulltext) return false;
        if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
        return true;
      });

      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title));

      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (p) =>
            fulltextOnly.has(p.o_id)
              ? { ...publicationSummary(p), matched_in: "fulltext", fulltext_snippet: matchSnippet(p.fulltext, args.keyword!) }
              : publicationSummary(p),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) },
        ),
      );
    },
  );

  // === get_publication ======================================================
  server.registerTool(
    "get_publication",
    {
      title: "Get publication detail",
      description:
        "Full metadata for one publication: authors, editors, venue (with the journal's own `amira_url` " +
        "and ISSN when it is a Journal authority record), volume/issue/pages, publisher, DOI, ISBN/ISSN, " +
        "peer-review status, funders, places of publication, abstract, subjects, language, ERef/EPub " +
        "links, and BibTeX generated from the structured fields. The extracted FULL TEXT is OMITTED by " +
        "default (only has_fulltext + fulltext_length are shown) — pass include_fulltext=true and page a " +
        "long one. Cite the `url` (DOI or repository permalink) as the primary reference. Returns " +
        "{ error } if the id is unknown.",
      annotations: annotate("Get publication detail"),
      inputSchema: z.object({
        id: z.union([z.string(), z.number()]).describe("Publication Omeka o:id (legacy publication keys also work)"),
        include_fulltext: z.boolean().optional().describe("Default false — set true to include the extracted full text"),
        fulltext_offset: z.number().int().min(0).optional().describe("Start offset into the full text (chars), with include_fulltext"),
        fulltext_max_chars: z.number().int().min(1).optional().describe("Max full-text characters to return (default/max 25000)"),
      }),
    },
    async ({ id, include_fulltext, fulltext_offset, fulltext_max_chars }) => {
      const store = await ensureStore();
      const p = store.getPublication(String(id));
      if (!p) {
        return errorResult("not_found", `No publication with id '${id}'.`, { suggested_tool: "search_publications" });
      }
      if (include_fulltext && !allowFullText()) return textAccessDisabledResult("fulltext");
      const journal = p.venue_ref?.o_id != null ? store.getJournal(p.venue_ref.o_id) : undefined;

      return textResult({
        id: String(p.o_id),
        omeka_id: p.o_id,
        title: p.title,
        type: p.type,
        year: p.year,
        date: p.date,
        ...(allowStructured()
          ? {
              authors: refLabels(p.authors),
              editors: refLabels(p.editors),
              venue: p.venue,
              ...(p.venue_ref?.o_id != null
                ? {
                    venue_omeka_id: p.venue_ref.o_id,
                    venue_amira_url: itemUrl(p.venue_ref.o_id),
                    ...(journal?.issn ? { venue_issn: journal.issn } : {}),
                  }
                : {}),
              subjects: refLabels(p.subjects),
              funders: refLabels(p.funders),
              places_of_publication: refLabels(p.places_of_publication),
              relations: p.relations,
            }
          : {}),
        volume: p.volume,
        issue: p.issue,
        pages: p.pages,
        publisher: p.publisher,
        doi: p.doi,
        isbn: p.isbn,
        issn: p.issn,
        status: p.status,
        language: p.language,
        abstract: allowDescriptive() && p.abstract ? capText(p.abstract).text : null,
        url: p.doi ?? p.urls[0] ?? null,
        repository_urls: p.urls,
        has_media: p.has_media,
        thumbnail: p.thumbnail,
        ...textWindowFields("fulltext", p.fulltext, {
          include: include_fulltext,
          offset: fulltext_offset,
          maxChars: fulltext_max_chars,
        }),
        bibtex: toBibtex(p),
        amira_url: itemUrl(p.o_id),
      });
    },
  );

  // === list_journals ========================================================
  server.registerTool(
    "list_journals",
    {
      title: "List journals",
      description:
        "List the journals the cluster publishes in (the Journal venue authority), ranked by how many " +
        "publications appeared in each, with ISSN, country of publication and website. Feed a title into " +
        "the `venue` filter of search_publications to retrieve its articles.",
      annotations: annotate("List journals"),
      inputSchema: z.object({
        keyword: z.string().optional().describe("Substring filter on the journal title"),
        limit: z.number().int().min(1).optional().describe("Default 50, max 200"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_journals");
      const limit = capLimit(args.limit, 50, 200);
      const offset = capOffset(args.offset);

      const pubCounts = new Map<number, number>();
      for (const p of store.publications) {
        if (p.venue_ref?.o_id != null) pubCounts.set(p.venue_ref.o_id, (pubCounts.get(p.venue_ref.o_id) ?? 0) + 1);
      }

      let ranked = store.journals
        .map((j) => ({ j, count: pubCounts.get(j.o_id) ?? 0 }))
        .sort((a, b) => b.count - a.count || a.j.title.localeCompare(b.j.title));
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.j.title, args.keyword!));

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) => ({
            journal: r.j.title,
            id: String(r.j.o_id),
            omeka_id: r.j.o_id,
            issn: r.j.issn,
            country: r.j.country?.label ?? null,
            country_amira_url: itemUrlOrNull(r.j.country?.o_id),
            publication_count: r.count,
            website: r.j.url,
            amira_url: itemUrl(r.j.o_id),
          }),
          { distinct_journals: ranked.length, ...limitEcho(args.limit, 200, limit), ...filtersEcho(args) },
        ),
      );
    },
  );
}
