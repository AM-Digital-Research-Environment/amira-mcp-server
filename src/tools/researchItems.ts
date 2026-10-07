import type { ToolMap } from "./policy.js";
import { isoDate, researchFilterError, selectResearchItems } from "../researchItemQuery.js";
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import {
  READ_ONLY,
  capLimit,
  capOffset,
  capText,
  errorResult,
  filtersEcho,
  itemSummary,
  limitEcho,
  pageOf,
  queryErrorResult,
  refLabels,
  textResult,
  yearLabel,
  type Server,
} from "./_shared.js";
import { iiifManifestUrl, itemSetUrl, itemUrl, itemUrlOrNull } from "../urls.js";
import { allowDescriptive, allowStructured } from "../exposure.js";
import { generateItemCitation } from "../citation.js";
import { stripTypedId } from "../typedIds.js";
import { exportLink, EXPORT_FORMATS } from "../resources.js";

export function registerResearchItemTools(server: Server, tools: ToolMap): void {
  // === search_research_items ================================================
  tools.search_research_items = server.registerTool(
    "search_research_items",
    {
      title: "Search research items",
      description: "Search digitised research items. Filters are AND-combined; empty results suggest a filter to relax or a stored place name. export links all matches as a file.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional()
          .describe("Every word must occur in the title, description, abstract, contents or identifiers; quote a phrase to match it exactly"),
        subject: z.string().max(1000).optional()
          .describe("Subject heading, partial (e.g. 'Architecture'). Subjects absorb the former free-form tags — there is no tag filter"),
        location: z.string().max(1000).optional()
          .describe("A place at ANY level of the city→country hierarchy: 'Nigeria' finds Lagos items, 'Lagos' finds only Lagos"),
        location_id: z.number().int().positive().optional().describe("Exact location authority ID, including descendants; avoids homonym matches"),
        country: z.string().max(1000).optional()
          .describe("Country only, exact name or common alias ('Côte d'Ivoire' = 'Ivory Coast'). Use `location` for cities"),
        contributor: z.string().max(1000).optional().describe("A person/organisation credited on the item; either name order works"),
        project_id: z.union([z.string().max(1000), z.number()]).optional().describe("Project Omeka id"),
        research_section: z.string().max(1000).optional().describe("e.g. 'Arts & Aesthetics', 'Mobilities'"),
        university: z.string().max(1000).optional().describe("ubt | unilag | ujkz | ufba | external — code or full name"),
        resource_type: z.string().max(1000).optional().describe("e.g. 'Image', 'Text', 'Audio', 'Moving image'"),
        genre: z.string().max(1000).optional().describe("Format/genre descriptor, partial (e.g. 'interview', 'letter', 'photograph')"),
        collection: z.string().max(1000).optional().describe("Item-set title (partial) or id from list_collections"),
        language: z.string().max(1000).optional().describe("Name or ISO code — 'French', 'fr', 'fra' and legacy 'fre' all match"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap from this year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap up to this year"),
        has_media: z.boolean().optional().describe("true: only items with digitised files"),
        added_since: isoDate.optional().describe("Added to AMIRA on or after this ISO date"),
        modified_since: isoDate.optional().describe("Changed on or after this ISO date"),
        export: z.enum(EXPORT_FORMATS.research_items).optional().describe("Return a file link instead of rows"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      const { export: format, limit: _l, offset: _o, ...filters } = args;
      // Structured-metadata filters are refused under restricted exposure, so a
      // benchmark model cannot narrow by fields it is not allowed to see.
      const refused = researchFilterError(filters);
      if (refused) return queryErrorResult(refused);

      const { filtered, suggestions, did_you_mean } = selectResearchItems(store, filters);
      if (format) return exportLink("research_items", format, filters, filtered.length);

      return textResult(
        pageOf(filtered, offset, limit, (it) => itemSummary(it, store), {
          ...limitEcho(args.limit, 100, limit),
          ...filtersEcho(filters),
          ...(suggestions ? { suggestions } : {}),
          ...(did_you_mean ? { did_you_mean } : {}),
        }),
      );
    },
  );

  // === get_research_item ====================================================
  tools.get_research_item = server.registerTool(
    "get_research_item",
    {
      title: "Get research item detail",
      description: "Research-item metadata, linked entities, rights, media files, IIIF manifest and a generated citation (BibTeX/RIS/CSL-JSON). Long fields cap at 25,000 characters.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        id: z
          .union([z.string().max(1000), z.number()])
          .describe("Omeka id (the number ending its amira_url, e.g. 7392) or a typed id such as research_item:7392"),
        citation_format: z
          .enum(["bibtex", "ris", "csl-json"])
          .optional()
          .describe("Export format for the generated citation: bibtex (default) → `bibtex`, ris → `ris`, csl-json → `csl_json`"),
      }),
    },
    async ({ id, citation_format }) => {
      const store = await ensureStore();
      const key = stripTypedId(String(id), ["research_item"]);
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
      const provenance = it.provenance_refs?.length ? it.provenance_refs : it.provenance.map((label) => ({ label, o_id: null }));

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
              contributors: it.contributors.map((c) => ({
                name: c.name,
                role: c.role,
                ...(c.o_id != null ? { amira_url: itemUrl(c.o_id) } : {}),
                // The affiliation recorded for this credit, which can differ from today's.
                ...(c.affiliation ? { affiliation_at_time: c.affiliation.label, affiliation_amira_url: itemUrlOrNull(c.affiliation.o_id) } : {}),
              })),
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
              provenance: provenance.map((p) => ({ name: p.label, amira_url: itemUrlOrNull(p.o_id) })),
              related_items: it.related.map((r) => ({
                relation: r.relation,
                title: r.ref.label,
                amira_url: itemUrlOrNull(r.ref.o_id),
              })),
              collections: it.item_sets.map((setId) => ({
                title: store.getItemSet(setId)?.title ?? `Collection ${setId}`,
                id: String(setId),
                omeka_id: setId,
                amira_url: itemSetUrl(setId),
              })),
            }
          : {}),
        access_rights: it.access_rights,
        license: it.license,
        identifiers: it.typed_identifiers?.length ? it.typed_identifiers : it.identifiers.map((value) => ({ value, type: null })),
        doi: it.doi,
        external_urls: it.urls,
        collection_url: it.collection_url,
        wisski_url: it.wisski_url,
        rdspace_handle: it.rdspace_handle ?? null,
        extent: it.extent ?? null,
        ...(allowDescriptive() ? { citation: it.citation } : {}),
        generated_citation: cite.citation,
        [cite.field]: cite.export,
        description: description?.text ?? null,
        description_truncated: description?.truncated || undefined,
        abstract: abstract?.text ?? null,
        abstract_truncated: abstract?.truncated || undefined,
        table_of_contents: toc?.text ?? null,
        table_of_contents_truncated: toc?.truncated || undefined,
        has_media: it.has_media,
        media: (it.media ?? []).map((m) => ({ type: m.type, url: m.url, source: m.source, size: m.size })),
        iiif_manifest: it.has_media ? iiifManifestUrl(it.o_id) : null,
        thumbnail: it.thumbnail,
        created: it.created ?? null,
        modified: it.modified ?? null,
        amira_url: itemUrl(it.o_id),
      });
    },
  );
}
