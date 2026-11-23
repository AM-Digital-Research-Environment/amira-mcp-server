import { schemaOnce } from "./schemaOnce.js";
import { recordArg } from "./records.js";
import type { ToolMap } from "./policy.js";
// The cluster bibliography (ERef/EPub harvest) + the Journal venue authority.
// Open-access publications carry extracted PDF full text (bibo:content):
// searchable here (with a match snippet), never included in summaries, and
// opt-in + windowable in get_publication — the same discipline as transcripts.
import { z } from "zod";
import { includeSimilarSchema, similarBlock } from "./similar.js";
import { callStore } from "./callStore.js";
import type { LinkedRef, PublicationRec } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  capOffset,
  capText,
  emptyExportHint,
  emptySearchHint,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  fulltextWindowParams,
  idParam,
  limitParam,
  matchSnippet,
  offsetParam,
  pageOf,
  publicationAbstractFields,
  publicationSummary,
  refLabels,
  restrictedTextFlag,
  textAccessDisabledResult,
  textParam,
  textResult,
  textWindowFields,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { publicationCitation } from "../publicationCitation.js";
import { publicationExportPage } from "./publicationExport.js";
import { languagesOf, publicationDidYouMean, publicationFilters, publicationFilterError, selectPublications } from "../publicationQuery.js";
import { keywordPredicate } from "../matching.js";
import { guidanceEnabled } from "../guidance.js";
import { queryErrorResult } from "./responses.js";
import { exportLink, EXPORT_FORMATS } from "../resources.js";
import { fold } from "../text.js";
import { APP_UI_META } from "./apps.js";

const LIMITS = {
  search_publications: limitParam(25, 100, "Default 25; max 100 summaries or 25 citation_format rows, also byte-bounded. export ignores it"),
  /** search_publications with citation_format: the same argument, capped lower. */
  citation_rows: limitParam(25, 25, null),
  list_publication_facets: limitParam(25, 100),
  list_journals: limitParam(50, 200),
};

export function registerPublicationTools(server: Server, tools: ToolMap): void {
  // === search_publications ==================================================
  tools.search_publications = server.registerTool(
    "search_publications",
    {
      title: "Search publications",
      description: "AND-filtered bibliography, newest first. Keyword includes PDF text and returns match snippets. citation_format returns citations per page; export links every match as one file. Cite amira_url.",
      annotations: READ_ONLY,
      _meta: APP_UI_META,
      inputSchema: schemaOnce("search_publications:in", () => z.strictObject({
        ...publicationFilters,
        citation_format: z.enum(["bibtex", "ris", "csl-json"]).optional().describe("Omit for summaries; pages carry bibtex, ris or csl_json"),
        include_abstract: z.boolean().optional().describe("Add abstract (first 1,200 chars) and subjects to each summary"),
        export: z.enum(EXPORT_FORMATS.publications).optional().describe("Return a file link instead of rows"),
        limit: LIMITS.search_publications.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      const { limit, echo } = (args.citation_format ? LIMITS.citation_rows : LIMITS.search_publications).resolve(args.limit);
      const offset = capOffset(args.offset);
      const { citation_format, include_abstract, export: format, limit: _l, offset: _o, ...filters } = args;
      const summary = (p: PublicationRec) =>
        include_abstract ? { ...publicationSummary(p), ...publicationAbstractFields(p) } : publicationSummary(p);
      const invalid = publicationFilterError(filters);
      if (invalid) return queryErrorResult(invalid);
      const { records: filtered, fulltextOnly, restrictedOnly } = selectPublications(store, filters);
      if (format) return emptyExportHint(exportLink("publications", format, filters, filtered.length), filtered.length);

      filtered.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title) || a.o_id - b.o_id);
      const didYouMean = !filtered.length && guidanceEnabled() ? publicationDidYouMean(store, filters) : [];
      const extra = { ...echo, ...filtersEcho(filters), ...(didYouMean.length ? { did_you_mean: didYouMean } : {}) };
      const hint = emptySearchHint(filtered.length, filters);
      if (citation_format) return publicationExportPage(filtered, offset, limit, citation_format, extra, hint);

      return textResult({
        ...pageOf(
          filtered,
          offset,
          limit,
          (p) =>
            fulltextOnly.has(p.o_id)
              ? { ...summary(p), matched_in: "fulltext", fulltext_snippet: matchSnippet(p.fulltext, args.keyword!) }
              : restrictedOnly.has(p.o_id)
                ? { ...summary(p), matched_in: "restricted_fulltext", fulltext_snippet: matchSnippet(p.restricted?.fulltext, args.keyword!) }
                : summary(p),
          extra,
        ),
        ...hint,
      });
    },
  );

  // === get_publication ======================================================
  tools.get_publication = server.registerTool(
    "get_publication",
    {
      title: "Get publication detail",
      description: "Publication metadata and citation export (BibTeX default). Full text is opt-in and paginated. Cite amira_url; DOI/repository links are additional sources.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("get_publication:in", () => z.strictObject({
        id: idParam(1000).describe("Publication Omeka id or typed id publication:29919"),
        citation_format: z.enum(["bibtex", "ris", "csl-json"]).optional().describe("Default bibtex; selects bibtex, ris or csl_json field"),
        include_fulltext: z.boolean().optional().describe("Default false — set true to include the extracted full text"),
        ...fulltextWindowParams,
        include_similar: includeSimilarSchema,
      })),
    },
    async ({ id, citation_format, include_fulltext, fulltext_offset, fulltext_max_chars, include_similar }) => {
      const store = callStore();
      const found = recordArg(store, id, "publication",
        () => errorResult("not_found", `No publication with id '${id}'.`, { suggested_tool: "search_publications" }));
      if ("error" in found) return found.error;
      const p = found.record;
      if (include_fulltext && !allowFullText()) return textAccessDisabledResult("fulltext");
      const window = textWindowFields("fulltext", p.fulltext, {
        include: include_fulltext,
        offset: fulltext_offset,
        maxChars: fulltext_max_chars,
      });
      // A later full-text page: a compact header with the window. The metadata
      // and abstract (~5 KB) came with the first page and are not re-sent.
      if (include_fulltext && (fulltext_offset ?? 0) > 0) {
        return textResult({
          id: String(p.o_id), omeka_id: p.o_id, title: p.title, year: p.year, doi: p.doi,
          ...window,
          ...restrictedTextFlag(p),
          amira_url: itemUrl(p.o_id),
        });
      }
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
              license: p.license ?? null,
              ...(p.license_url ? { license_url: p.license_url } : {}),
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
        languages: languagesOf(p),
        abstract: allowDescriptive() && p.abstract ? capText(p.abstract).text : null,
        // Every abstract with its language tag; the first alone hid 46 non-English ones.
        ...(allowDescriptive() && (p.abstracts?.length ?? 0) > 1
          ? { abstracts: p.abstracts!.map((a) => ({ lang: a.lang, text: capText(a.text).text })) }
          : {}),
        url: p.doi ?? p.urls[0] ?? null,
        repository_urls: p.urls,
        external_links: p.external_links ?? [],
        identifiers: p.identifiers ?? [p.pub_id],
        has_media: p.has_media,
        media: (p.media ?? []).map((m) => ({ type: m.type, url: m.url, size: m.size, ...(m.visibility ? { visibility: m.visibility } : {}) })),
        thumbnail: p.thumbnail,
        created: p.created ?? null,
        ...window,
        ...restrictedTextFlag(p),
        [citation.field]: citation.export,
        ...(include_similar ? { similar: similarBlock(store, "publication", p.o_id) } : {}),
        amira_url: itemUrl(p.o_id),
      });
    },
  );

  // === list_publication_facets ==============================================
  tools.list_publication_facets = server.registerTool(
    "list_publication_facets",
    {
      title: "Publication facets",
      description: "Ranked facets for the entire filtered bibliography before pagination. Uses the same selection rules as search_publications.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("list_publication_facets:in", () => z.strictObject({
        facet: z.enum(["type", "year", "language", "subject", "author", "venue"]),
        ...publicationFilters,
        limit: LIMITS.list_publication_facets.schema,
        offset: offsetParam,
      })),
      outputSchema: schemaOnce("list_publication_facets:out", () => z.object({
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
        response_limited: z.boolean().optional(),
        results: z.array(z.object({
          value: z.string(),
          publication_count: z.number(),
          amira_url: z.string().optional(),
        })),
      })),
    },
    async ({ facet, limit: rawLimit, offset: rawOffset, ...filters }) => {
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_publication_facets");
      const args = { ...filters, limit: rawLimit, offset: rawOffset };
      const invalid = publicationFilterError(filters);
      if (invalid) return queryErrorResult(invalid);
      const store = callStore();
      const { records } = selectPublications(store, filters);
      const literal = (value: string | null): LinkedRef[] => value ? [{ label: value, o_id: null }] : [];
      const refsOf = (p: (typeof records)[number]): LinkedRef[] => facet === "author" ? [...p.authors, ...p.editors]
        : facet === "subject" ? p.subjects
        : facet === "venue" ? p.venue_ref ? [p.venue_ref] : literal(p.venue)
        : facet === "year" ? literal(p.year == null ? null : String(p.year))
        : facet === "language" ? languagesOf(p).map((label) => ({ label, o_id: null }))
        : literal(p[facet]);
      // Buckets are keyed by the linked record, so two authorities with one
      // label keep their own counts and ids (#53). An unlinked label joins the
      // linked bucket of that label when exactly one exists.
      const linkedByLabel = new Map<string, Set<number>>();
      for (const p of records) {
        for (const ref of refsOf(p)) {
          if (ref.o_id == null) continue;
          const label = fold(ref.label.trim());
          if (!linkedByLabel.has(label)) linkedByLabel.set(label, new Set());
          linkedByLabel.get(label)!.add(ref.o_id);
        }
      }
      const keyOf = (ref: LinkedRef, label: string): string => {
        if (ref.o_id != null) return `id:${ref.o_id}`;
        const linked = linkedByLabel.get(label);
        return linked?.size === 1 ? `id:${[...linked][0]}` : `label:${label}`;
      };
      const buckets = new Map<string, { value: string; publication_count: number; amira_url?: string }>();
      let missing = 0;
      for (const p of records) {
        const seen = new Set<string>();
        for (const ref of refsOf(p)) {
          const label = fold(ref.label.trim());
          if (!label) continue;
          const key = keyOf(ref, label);
          if (seen.has(key)) continue;
          seen.add(key);
          const bucket = buckets.get(key) ?? { value: ref.label, publication_count: 0 };
          bucket.publication_count++;
          if (key.startsWith("id:")) bucket.amira_url ??= itemUrl(Number(key.slice(3)));
          buckets.set(key, bucket);
        }
        if (!seen.size) missing++;
      }
      const ranked = [...buckets.values()].sort((a, b) => b.publication_count - a.publication_count || a.value.localeCompare(b.value));
      const { limit, echo } = LIMITS.list_publication_facets.resolve(args.limit);
      return textResult(pageOf(ranked, capOffset(args.offset), limit, (r) => r, {
        facet, total_publications: records.length, missing_values: missing,
        ...echo, ...filtersEcho(filters),
      }));
    },
  );

  // === list_journals ========================================================
  tools.list_journals = server.registerTool(
    "list_journals",
    {
      title: "List journals",
      description: "Publication venues ranked by linked bibliography records, with ISSN and catalogue links.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("list_journals:in", () => z.strictObject({
        keyword: textParam().optional().describe("Filter on the journal title; every word must match, quote a phrase"),
        limit: LIMITS.list_journals.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_journals");
      const { limit, echo } = LIMITS.list_journals.resolve(args.limit);
      const offset = capOffset(args.offset);

      const pubCounts = new Map<number, number>();
      for (const p of store.publications) {
        if (p.venue_ref?.o_id != null) pubCounts.set(p.venue_ref.o_id, (pubCounts.get(p.venue_ref.o_id) ?? 0) + 1);
      }

      let ranked = store.journals
        .map((j) => ({ j, count: pubCounts.get(j.o_id) ?? 0 }))
        .sort((a, b) => b.count - a.count || a.j.title.localeCompare(b.j.title));
      if (args.keyword) {
        const matches = keywordPredicate(args.keyword);
        ranked = ranked.filter((r) => matches([r.j.title]));
      }

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
          { distinct_journals: ranked.length, ...echo, ...filtersEcho(args) },
        ),
      );
    },
  );
}
