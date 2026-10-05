import { selectResearchItems, invalidYearRange } from "../researchItemQuery.js";
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import {
  annotate,
  capLimit,
  capOffset,
  capText,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  itemSummary,
  limitEcho,
  pageOf,
  refLabels,
  textResult,
  yearLabel,
  type Server,
} from "./_shared.js";
import { itemSetUrl, itemUrl, itemUrlOrNull } from "../urls.js";
import { allowDescriptive, allowStructured } from "../exposure.js";
import { generateItemCitation } from "../citation.js";

export function registerResearchItemTools(server: Server): void {
  // === search_research_items ================================================
  server.registerTool(
    "search_research_items",
    {
      title: "Search research items",
      description: "Search digitised research items. Optional filters are AND-combined; empty results suggest a single filter to relax. Use get_research_item for detail and citations.",
      annotations: annotate("Search research items"),
      inputSchema: z.strictObject({
        keyword: z
          .string().max(1000)
          .optional()
          .describe("Matches titles, description, abstract, table of contents and identifiers. Accent- and case-insensitive"),
        subject: z
          .string().max(1000)
          .optional()
          .describe("Subject heading, partial (e.g. 'Architecture'). Subjects absorb the former free-form tags — there is no tag filter"),
        location: z
          .string().max(1000)
          .optional()
          .describe("A place at ANY level of the city→country hierarchy: 'Nigeria' finds Lagos items, 'Lagos' finds only Lagos"),
        location_id: z.number().int().positive().optional().describe("Exact location authority ID, including descendants; avoids homonym matches"),
        country: z
          .string().max(1000)
          .optional()
          .describe("Only the country level of the hierarchy. Use `location` to match a city or any level"),
        contributor: z.string().max(1000).optional().describe("A person/organisation credited on the item; either name order works"),
        project_id: z.union([z.string().max(1000), z.number()]).optional().describe("Project Omeka o:id (legacy project keys also work)"),
        research_section: z.string().max(1000).optional().describe("e.g. 'Arts & Aesthetics', 'Mobilities'"),
        university: z.string().max(1000).optional().describe("ubt | unilag | ujkz | ufba | external — code or full name"),
        resource_type: z.string().max(1000).optional().describe("e.g. 'Image', 'Text', 'Audio', 'Moving image'"),
        genre: z.string().max(1000).optional().describe("Format/genre descriptor, partial (e.g. 'interview', 'letter', 'photograph')"),
        collection: z.string().max(1000).optional().describe("Item-set title (partial) or id from list_collections"),
        language: z.string().max(1000).optional().describe("Name or ISO code — 'French', 'fr', 'fra' and legacy 'fre' all match"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap from this year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap up to this year"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      if (invalidYearRange(args.year_from, args.year_to)) {
        return errorResult("invalid_range", "`year_from` must be less than or equal to `year_to`.");
      }
      // Structured-metadata filters are refused under restricted exposure, so a
      // benchmark model cannot narrow by fields it is not allowed to see.
      if (!allowStructured()) {
        const gated = ["subject", "location", "location_id", "country", "contributor", "project_id", "research_section", "university", "genre", "collection", "language"] as const;
        const used = gated.filter((g) => (args as Record<string, unknown>)[g] != null);
        if (used.length) return exposureRestrictedResult("structured", `The ${used.map((u) => `\`${u}\``).join(", ")} filter${used.length > 1 ? "s" : ""}`);
      }

      const { filtered, suggestions } = selectResearchItems(store, args);

      return textResult(
        pageOf(filtered, offset, limit, (it) => itemSummary(it, store), {
          ...limitEcho(args.limit, 100, limit),
          ...filtersEcho(args),
          ...(suggestions ? { suggestions } : {}),
        }),
      );
    },
  );

  // === get_research_item ====================================================
  server.registerTool(
    "get_research_item",
    {
      title: "Get research item detail",
      description: "Research-item metadata, linked entities, rights, media and a generated citation (BibTeX/RIS/CSL-JSON). Long fields cap at 25,000 characters. Unknown ID returns an error.",
      annotations: annotate("Get research item detail"),
      inputSchema: z.strictObject({
        id: z
          .union([z.string().max(1000), z.number()])
          .describe("The item's Omeka o:id — the number ending its amira_url, e.g. 7392. Legacy DRE keys also work"),
        citation_format: z
          .enum(["bibtex", "ris", "csl-json"])
          .optional()
          .describe("Export format for the generated citation: bibtex (default) → `bibtex`, ris → `ris`, csl-json → `csl_json`"),
      }),
    },
    async ({ id, citation_format }) => {
      const store = await ensureStore();
      const key = String(id);
      const it = store.getItem(key);
      if (!it) {
        return errorResult("not_found", `No research item with id '${key}'.`, {
          suggested_tool: "search_research_items",
        });
      }
      const project = store.projectOf(it);
      // The citation names the collection the item is filed under — the real
      // item-set title only, never the `Collection <id>` placeholder below.
      const cite = generateItemCitation(
        it,
        {
          collection: it.item_sets.map((setId) => store.getItemSet(setId)?.title).find(Boolean) ?? null,
          project: project?.name ?? null,
        },
        citation_format ?? "bibtex",
      );
      const description = allowDescriptive() && it.description ? capText(it.description) : null;
      const abstract = allowDescriptive() && it.abstract ? capText(it.abstract) : null;
      const toc = allowDescriptive() && it.toc ? capText(it.toc) : null;

      return textResult({
        id: String(it.o_id),
        omeka_id: it.o_id,
        title: it.title,
        alternative_titles: it.alt_titles,
        type: it.type,
        dates: it.dates,
        date: yearLabel(it),
        ...(allowStructured()
          ? {
              university: UNIVERSITY_LABELS[it.university],
              project: project ? { id: String(project.o_id), omeka_id: project.o_id, name: project.name, amira_url: itemUrl(project.o_id) } : null,
              research_sections: store.sectionsOfItem(it),
              contributors: it.contributors.map((c) => ({ name: c.name, role: c.role })),
              subjects: it.subjects.map((s) => ({ label: s.label, amira_url: itemUrlOrNull(s.o_id) })),
              places: it.places.map((p) => ({
                name: p.label,
                within: store.locationAncestors(p.o_id),
                amira_url: itemUrlOrNull(p.o_id),
              })),
              languages: refLabels(it.languages),
              formats: refLabels(it.formats),
              physical_notes: it.format_notes,
              audiences: it.audiences,
              sponsors: it.sponsors,
              provenance: it.provenance,
              related_items: it.related.map((r) => ({
                relation: r.relation,
                title: r.ref.label,
                amira_url: itemUrlOrNull(r.ref.o_id),
              })),
              collections: it.item_sets.map((id) => ({
                title: store.getItemSet(id)?.title ?? `Collection ${id}`,
                amira_url: itemSetUrl(id),
              })),
            }
          : {}),
        access_rights: it.access_rights,
        license: it.license,
        identifiers: it.identifiers,
        doi: it.doi,
        external_urls: it.urls,
        collection_url: it.collection_url,
        wisski_url: it.wisski_url,
        ...(allowDescriptive() ? { citation: it.citation } : {}),
        generated_citation: cite.citation,
        [cite.field]: cite.export,
        description: description?.text ?? null,
        description_truncated: description?.truncated || undefined,
        abstract: abstract?.text ?? null,
        abstract_truncated: abstract?.truncated || undefined,
        table_of_contents: toc?.text ?? null,
        has_media: it.has_media,
        thumbnail: it.thumbnail,
        amira_url: itemUrl(it.o_id),
      });
    },
  );
}
