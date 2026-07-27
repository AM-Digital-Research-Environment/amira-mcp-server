import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { DataStore } from "../data.js";
import type { ResearchItemRec } from "../types.js";
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
  itemSummary,
  limitEcho,
  pageOf,
  refLabels,
  textResult,
  yearLabel,
  type Server,
} from "./_shared.js";
import { itemSetUrl, itemUrl, itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery } from "../names.js";
import { allowDescriptive, allowStructured } from "../exposure.js";

function matchUniversity(item: ResearchItemRec, val: string): boolean {
  return item.university === val.trim().toLowerCase() || containsCI(UNIVERSITY_LABELS[item.university], val);
}

/** Place match across each place's full ancestor chain (city → country) — so
 * `location` covers any level: a country or a city alike. */
function placeMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => store.placeChain(p).some((label) => containsCI(label, needle)));
}

/** Country match: the value matches the COUNTRY (chain root, store.countryOf) of
 * any of the item's places — narrower than `location`, which matches any level.
 * An item tagged only with a city whose country ancestor is missing won't match
 * (the same gap `location` has). v1.4.1 restored this as a real, advertised
 * filter — v1.4.0 dropped it from the schema and tried to route a stray
 * `country` arg into `location`, but validation strips unknown keys before the
 * handler runs, so `country` was silently ignored (the reported regression). */
function countryMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => containsCI(store.countryOf(p), needle));
}

function yearsOverlap(item: ResearchItemRec, from?: number, to?: number): boolean {
  if (item.year_min == null) return false;
  const lo = item.year_min;
  const hi = item.year_max ?? item.year_min;
  return lo <= (to ?? Infinity) && hi >= (from ?? -Infinity);
}

function invalidYearRange(from?: number, to?: number): boolean {
  return from !== undefined && to !== undefined && from > to;
}

export function registerResearchItemTools(server: Server): void {
  // === search_research_items ================================================
  server.registerTool(
    "search_research_items",
    {
      title: "Search research items",
      description:
        "The main discovery tool: search the ~4,000 research items (digitised artefacts — images, texts, " +
        "audio, video) across all Africa Multiple project collections, including for 'items about subject " +
        "X' and 'items from location Y'. Filters are optional and AND-combined; omit all to browse. Use " +
        "get_research_item for one item's full detail. When a filter combination matches nothing, the " +
        "response adds `suggestions` naming which single filter to drop and how many items that would " +
        "surface.",
      annotations: annotate("Search research items"),
      inputSchema: {
        keyword: z
          .string()
          .optional()
          .describe("Matches titles, description, abstract, table of contents and identifiers. Accent- and case-insensitive"),
        subject: z
          .string()
          .optional()
          .describe("Subject heading, partial (e.g. 'Architecture'). Subjects absorb the former free-form tags — there is no tag filter"),
        location: z
          .string()
          .optional()
          .describe("A place at ANY level of the city→country hierarchy: 'Nigeria' finds Lagos items, 'Lagos' finds only Lagos"),
        country: z
          .string()
          .optional()
          .describe("Only the country level of the hierarchy. Use `location` to match a city or any level"),
        contributor: z.string().optional().describe("A person/organisation credited on the item; either name order works"),
        project_id: z.union([z.string(), z.number()]).optional().describe("Project Omeka o:id (legacy project keys also work)"),
        research_section: z.string().optional().describe("e.g. 'Arts & Aesthetics', 'Mobilities'"),
        university: z.string().optional().describe("ubt | unilag | ujkz | ufba | external — code or full name"),
        resource_type: z.string().optional().describe("e.g. 'Image', 'Text', 'Audio', 'Moving image'"),
        genre: z.string().optional().describe("Format/genre descriptor, partial (e.g. 'interview', 'letter', 'photograph')"),
        collection: z.string().optional().describe("Item-set title (partial) or id from list_collections"),
        language: z.string().optional().describe("Name or ISO code — 'French', 'fr', 'fra' and legacy 'fre' all match"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap from this year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Keep items whose content dates overlap up to this year"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      },
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
        const gated = ["subject", "location", "country", "contributor", "project_id", "research_section", "university", "genre", "collection", "language"] as const;
        const used = gated.filter((g) => (args as Record<string, unknown>)[g] != null);
        if (used.length) return exposureRestrictedResult("structured", `The ${used.map((u) => `\`${u}\``).join(", ")} filter${used.length > 1 ? "s" : ""}`);
      }

      const project = args.project_id != null ? store.getProject(String(args.project_id)) : undefined;

      // One predicate per active filter, so a zero-result set can be probed by
      // dropping each filter in turn (relaxation hints).
      const preds: Record<string, (it: ResearchItemRec) => boolean> = {};
      if (args.keyword) {
        const k = args.keyword;
        preds.keyword = (it) =>
          containsCI(it.title, k) ||
          anyContainsCI(it.alt_titles, k) ||
          (allowDescriptive() &&
            (containsCI(it.description, k) ||
              containsCI(it.abstract, k) ||
              containsCI(it.toc, k) ||
              anyContainsCI(it.identifiers, k) ||
              equalsCI(it.dre_id, k)));
      }
      if (args.subject) preds.subject = (it) => it.subjects.some((s) => containsCI(s.label, args.subject!));
      if (args.location) preds.location = (it) => placeMatches(store, it, args.location!);
      if (args.country) preds.country = (it) => countryMatches(store, it, args.country!);
      if (args.contributor)
        preds.contributor = (it) =>
          it.contributors.some(
            (c) => nameMatchesQuery(c.name, args.contributor!) || containsCI(c.name, args.contributor!),
          );
      if (args.project_id != null)
        preds.project_id = (it) =>
          project ? it.project?.o_id === project.o_id : equalsCI(it.project?.label, String(args.project_id));
      if (args.research_section)
        preds.research_section = (it) => store.sectionsOfItem(it).some((s) => equalsCI(s, args.research_section!));
      if (args.university) preds.university = (it) => matchUniversity(it, args.university!);
      if (args.resource_type) preds.resource_type = (it) => equalsCI(it.type, args.resource_type!);
      if (args.genre)
        preds.genre = (it) =>
          anyContainsCI(refLabels(it.formats), args.genre!) || anyContainsCI(it.format_notes, args.genre!);
      if (args.collection) {
        const q = args.collection.trim();
        const asId = Number(q);
        preds.collection = (it) => it.item_sets.some((id) => id === asId || containsCI(store.getItemSet(id)?.title, q));
      }
      if (args.language) preds.language = (it) => store.languageIndex.matches(it.languages, args.language!);
      if (args.year_from !== undefined || args.year_to !== undefined)
        preds.year = (it) => yearsOverlap(it, args.year_from, args.year_to);

      const keys = Object.keys(preds);
      const passes = (it: ResearchItemRec, except?: string): boolean =>
        keys.every((k) => k === except || preds[k]!(it));
      const filtered = store.items.filter((it) => passes(it));

      // Relaxation hints (report §3): when ≥2 filters combine to nothing, report
      // which single filter, dropped, would surface items — and how many.
      let suggestions: { remove_filter: string; would_match: number }[] | undefined;
      if (filtered.length === 0 && keys.length >= 2) {
        const probed = keys
          .map((k) => ({ remove_filter: k, would_match: store.items.filter((it) => passes(it, k)).length }))
          .filter((s) => s.would_match > 0)
          .sort((a, b) => b.would_match - a.would_match);
        if (probed.length) suggestions = probed;
      }

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
      description:
        "Full metadata for one research item: typed content dates, contributors with roles, subjects, " +
        "places with their region/country chain, project/section/university, collections, descriptive " +
        "text, formats and physical notes, sponsors, provenance, rights, identifiers, related items, " +
        "languages, a media thumbnail, and the citable `amira_url`. Long text fields are truncated at " +
        "25,000 characters. Returns { error } if the id is unknown.",
      annotations: annotate("Get research item detail"),
      inputSchema: {
        id: z
          .union([z.string(), z.number()])
          .describe("The item's Omeka o:id — the number ending its amira_url, e.g. 7392. Legacy DRE keys also work"),
      },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const key = String(id);
      const it = store.getItem(key);
      if (!it) {
        return errorResult("not_found", `No research item with id '${key}'.`, {
          suggested_tool: "search_research_items",
        });
      }
      const project = store.projectOf(it);
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
