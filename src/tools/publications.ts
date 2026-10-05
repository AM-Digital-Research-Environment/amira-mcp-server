// The cluster bibliography (ERef/EPub harvest) + the Journal venue authority.
// Open-access publications carry extracted PDF full text (bibo:content):
// searchable here (with a match snippet), never included in summaries, and
// opt-in + windowable in get_publication — the same discipline as transcripts.
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { LinkedRef } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  annotate,
  capLimit,
  capOffset,
  capText,
  containsCI,
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
import { publicationCitation } from "../publicationCitation.js";
import { publicationExportPage } from "../publicationExport.js";
import { publicationFilters, publicationFilterError, selectPublications } from "../publicationQuery.js";
import { fold } from "../text.js";

export function registerPublicationTools(server: Server): void {
  // === search_publications ==================================================
  server.registerTool(
    "search_publications",
    {
      title: "Search publications",
      description: "AND-filtered bibliography, newest first. Keyword includes PDF text and returns match snippets. citation_format exports whole records (max 25 per page); follow next_offset. Cite amira_url.",
      annotations: annotate("Search publications"),
      _meta: { ui: { resourceUri: "ui://amira/bibliography", visibility: ["model", "app"] } },
      inputSchema: z.strictObject({
        ...publicationFilters,
        citation_format: z.enum(["bibtex", "ris", "csl-json"]).optional().describe("Omit for summaries; export results contain bibtex, ris or csl_json"),
        limit: z.number().int().min(1).optional().describe("Default 25; max 100 summaries or 25 exports, also byte-bounded"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const maxLimit = args.citation_format ? 25 : 100;
      const limit = capLimit(args.limit, 25, maxLimit);
      const offset = capOffset(args.offset);
      const invalid = publicationFilterError(args);
      if (invalid) return invalid;
      const { records: filtered, fulltextOnly } = selectPublications(store, args);

      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title) || a.o_id - b.o_id);
      const { citation_format, ...filters } = args;
      const extra = { ...limitEcho(args.limit, maxLimit, limit), ...filtersEcho(filters) };
      if (citation_format) return publicationExportPage(filtered, offset, limit, citation_format, extra);

      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (p) =>
            fulltextOnly.has(p.o_id)
              ? { ...publicationSummary(p), matched_in: "fulltext", fulltext_snippet: matchSnippet(p.fulltext, args.keyword!) }
              : publicationSummary(p),
          extra,
        ),
      );
    },
  );

  // === get_publication ======================================================
  server.registerTool(
    "get_publication",
    {
      title: "Get publication detail",
      description: "Publication metadata and citation export (BibTeX default). Full text is opt-in and paginated. Cite amira_url; DOI/repository links are additional sources.",
      annotations: annotate("Get publication detail"),
      inputSchema: z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Publication Omeka o:id (legacy publication keys also work)"),
        citation_format: z.enum(["bibtex", "ris", "csl-json"]).optional().describe("Default bibtex; selects bibtex, ris or csl_json field"),
        include_fulltext: z.boolean().optional().describe("Default false — set true to include the extracted full text"),
        fulltext_offset: z.number().int().min(0).optional().describe("Start offset into the full text (chars), with include_fulltext"),
        fulltext_max_chars: z.number().int().min(1).optional().describe("Max full-text characters to return (default/max 25000)"),
      }),
    },
    async ({ id, citation_format, include_fulltext, fulltext_offset, fulltext_max_chars }) => {
      const store = await ensureStore();
      const p = store.getPublication(String(id));
      if (!p) {
        return errorResult("not_found", `No publication with id '${id}'.`, { suggested_tool: "search_publications" });
      }
      if (include_fulltext && !allowFullText()) return textAccessDisabledResult("fulltext");
      const journal = p.venue_ref?.o_id != null ? store.getJournal(p.venue_ref.o_id) : undefined;
      const citation = publicationCitation(p, citation_format);
      const linkedDetail = (ref: LinkedRef) => ({
        label: ref.label, omeka_id: ref.o_id, amira_url: itemUrlOrNull(ref.o_id),
      });

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
              author_refs: p.authors.map(linkedDetail),
              editor_refs: p.editors.map(linkedDetail),
              publisher_ref: p.publisher_ref ? linkedDetail(p.publisher_ref) : null,
              advisers: (p.advisers ?? []).map(linkedDetail),
              degree_granting_institutions: (p.degree_granting_institutions ?? []).map(linkedDetail),
              conference_details: p.conference_details ?? [],
              access_rights: p.access_rights ?? [],
              rights: p.rights ?? [],
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
              series: p.series ?? [],
            }
          : {}),
        volume: p.volume,
        issue: p.issue,
        pages: p.pages,
        num_pages: p.num_pages ?? null,
        publisher: p.publisher,
        doi: p.doi,
        isbn: p.isbn,
        issn: p.issn,
        status: p.status,
        language: p.language,
        abstract: allowDescriptive() && p.abstract ? capText(p.abstract).text : null,
        url: p.doi ?? p.urls[0] ?? null,
        repository_urls: p.urls,
        external_links: p.external_links ?? [],
        identifiers: p.identifiers ?? [p.pub_id],
        has_media: p.has_media,
        thumbnail: p.thumbnail,
        ...textWindowFields("fulltext", p.fulltext, {
          include: include_fulltext,
          offset: fulltext_offset,
          maxChars: fulltext_max_chars,
        }),
        [citation.field]: citation.export,
        amira_url: itemUrl(p.o_id),
      });
    },
  );

  // === list_publication_facets ==============================================
  server.registerTool(
    "list_publication_facets",
    {
      title: "Publication facets",
      description: "Ranked facets for the entire filtered bibliography before pagination. Uses the same selection rules as search_publications.",
      annotations: annotate("Publication facets"),
      inputSchema: z.strictObject({
        facet: z.enum(["type", "year", "language", "subject", "author", "venue"]),
        ...publicationFilters,
        limit: z.number().int().min(1).optional().describe("Default 25, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
      outputSchema: z.object({
        facet: z.string(),
        total_publications: z.number(),
        missing_values: z.number(),
        count: z.number(),
        total_matches: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        next_offset: z.number().optional(),
        filters: z.record(z.string(), z.unknown()).optional(),
        requested_limit: z.number().optional(),
        effective_limit: z.number().optional(),
        results: z.array(z.object({
          value: z.string(),
          publication_count: z.number(),
          amira_url: z.string().optional(),
        })),
      }),
    },
    async ({ facet, ...args }) => {
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_publication_facets");
      const invalid = publicationFilterError(args);
      if (invalid) return invalid;
      const store = await ensureStore();
      const { records } = selectPublications(store, args);
      const buckets = new Map<string, { value: string; publication_count: number; amira_url?: string }>();
      let missing = 0;
      for (const p of records) {
        const literal = (value: string | null): LinkedRef[] => value ? [{ label: value, o_id: null }] : [];
        const refs = facet === "author" ? [...p.authors, ...p.editors]
          : facet === "subject" ? p.subjects
          : facet === "venue" ? p.venue_ref ? [p.venue_ref] : literal(p.venue)
          : facet === "year" ? literal(p.year == null ? null : String(p.year))
          : literal(p[facet]);
        const seen = new Set<string>();
        for (const ref of refs) {
          const key = fold(ref.label.trim());
          if (!key || seen.has(key)) continue;
          seen.add(key);
          const bucket = buckets.get(key) ?? { value: ref.label, publication_count: 0 };
          bucket.publication_count++;
          if (ref.o_id != null) bucket.amira_url ??= itemUrl(ref.o_id);
          buckets.set(key, bucket);
        }
        if (!seen.size) missing++;
      }
      const ranked = [...buckets.values()].sort((a, b) => b.publication_count - a.publication_count || a.value.localeCompare(b.value));
      const limit = capLimit(args.limit, 25, 100);
      return textResult(pageOf(ranked, capOffset(args.offset), limit, (r) => r, {
        facet, total_publications: records.length, missing_values: missing,
        ...limitEcho(args.limit, 100, limit), ...filtersEcho(args),
      }));
    },
  );

  // === list_journals ========================================================
  server.registerTool(
    "list_journals",
    {
      title: "List journals",
      description: "Publication venues ranked by linked bibliography records, with ISSN and catalogue links.",
      annotations: annotate("List journals"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Substring filter on the journal title"),
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
