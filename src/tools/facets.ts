import { z } from "zod";
import { ensureStore } from "../data.js";
import type { LinkedRef, ResearchItemRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
  capLimit,
  capOffset,
  containsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitEcho,
  pageOf,
  subjectEntry,
  textResult,
  type Server,
} from "./_shared.js";
import { itemSetUrl, itemUrlOrNull } from "../urls.js";
import { TIMELINE_UI_META } from "./apps.js";
import { researchFilters, selectResearchItems, invalidYearRange } from "../researchItemQuery.js";
import { timelineSchema } from "./outputSchemas.js";

interface RefCount {
  label: string;
  o_id: number | null;
  count: number;
}

/** Count linked refs across items, deduping per item by ID or literal label. */
function countRefs(items: ResearchItemRec[], pick: (it: ResearchItemRec) => LinkedRef[]): RefCount[] {
  const counts = new Map<string, RefCount>();
  for (const it of items) {
    const seen = new Set<string>();
    for (const ref of pick(it)) {
      const key = ref.o_id != null ? `id:${ref.o_id}` : `label:${ref.label.toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const rec = counts.get(key) ?? { label: ref.label, o_id: ref.o_id, count: 0 };
      rec.count += 1;
      if (rec.o_id == null && ref.o_id != null) rec.o_id = ref.o_id;
      counts.set(key, rec);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

export function registerFacetTools(server: Server): void {
  // === list_subjects ========================================================
  server.registerTool(
    "list_subjects",
    {
      title: "List subjects",
      description: "Subject headings ranked by distinct research-item count. Includes former tags. Feed a heading into search_research_items.subject.",
      annotations: annotate("List subjects"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Substring filter on the subject heading"),
        limit: z.number().int().min(1).optional().describe("Default 50, max 300"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_subjects");
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);
      let ranked = store.cached("facets:subjects", () => countRefs(store.items, (it) => it.subjects));
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.label, args.keyword!));
      return textResult(
        pageOf(ranked, offset, limit, (r) => subjectEntry(r.label, r.o_id, r.count), {
          distinct_subjects: ranked.length,
          ...limitEcho(args.limit, 300, limit),
          ...filtersEcho(args),
        }),
      );
    },
  );

  // === list_locations =======================================================
  server.registerTool(
    "list_locations",
    {
      title: "List locations",
      description: "Research places with coordinates and ancestor rollups. One item can count under both city and country. Feed a name into search_research_items.location.",
      annotations: annotate("List locations"),
      _meta: { ui: { resourceUri: "ui://amira/map", visibility: ["model", "app"] } },
      inputSchema: z.strictObject({
        filters: researchFilters.optional().describe("Research-item filters applied before place counts"),
        country: z.string().max(1000).optional().describe("Narrow to one country: the country itself plus its cities/regions"),
        keyword: z.string().max(1000).optional().describe("Substring filter on the place name"),
        limit: z.number().int().min(1).optional().describe("Default 50, max 300"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_locations");
      if (invalidYearRange(args.filters?.year_from, args.filters?.year_to)) return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);

      interface PlaceCount extends RefCount {
        country: string | null;
      }
      const selected = selectResearchItems(store, args.filters ?? {}).filtered;
      const aggregate = () => {
      const counts = new Map<string, PlaceCount>();
      for (const it of selected) {
        const seen = new Set<string>();
        for (const ref of it.places) {
          // Keep homonymous places separate and deduplicate each authority per item.
          const chain = store.placeChainRefs(ref); // [self, parent, ..., root]
          const root = chain[chain.length - 1]!;
          for (let i = 0; i < chain.length; i++) {
            const { label, o_id: oId } = chain[i]!;
            const isCountry = i === chain.length - 1;
            const key = oId == null ? `label:${label.toLowerCase()}` : `id:${oId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            // country filter keeps the country itself and any place under it.
            const rec = counts.get(key) ?? { label, o_id: oId, count: 0, country: isCountry ? null : root.label };
            rec.count += 1;
            if (rec.o_id == null && oId != null) rec.o_id = oId;
            counts.set(key, rec);
          }
        }
      }

      return [...counts.values()].sort((a, b) => b.count - a.count);
      };
      let ranked = Object.keys(args.filters ?? {}).length ? aggregate() : store.cached("facets:locations", aggregate);
      if (args.country) ranked = ranked.filter((r) => containsCI(r.label, args.country!) || containsCI(r.country, args.country!));
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.label, args.keyword!));

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) => {
            const loc = r.o_id != null ? store.getLocation(r.o_id) : undefined;
            return {
              name: r.label,
              omeka_id: r.o_id,
              coordinate_scope: r.country ? "place" : "hierarchy_root",
              ...(r.country ? { country: r.country } : {}),
              item_count: r.count,
              latitude: loc?.latitude ?? null,
              longitude: loc?.longitude ?? null,
              amira_url: itemUrlOrNull(r.o_id),
            };
          },
          {
            distinct_places: ranked.length,
            matched_items: selected.length,
            items_without_place: selected.filter((it) => !it.places.length).length,
            ...limitEcho(args.limit, 300, limit),
            ...filtersEcho({ country: args.country, keyword: args.keyword, filters: args.filters }),
          },
        ),
      );
    },
  );

  // === list_collections =====================================================
  server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "Omeka item sets ranked by research-item count, with catalogue links. Feed an ID into search_research_items.collection.",
      annotations: annotate("List collections"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Substring filter on the collection title"),
        limit: z.number().int().min(1).optional().describe("Default 50, max 200"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_collections");
      const limit = capLimit(args.limit, 50, 200);
      const offset = capOffset(args.offset);

      const counts = new Map<number, number>();
      for (const it of store.items) for (const id of it.item_sets) counts.set(id, (counts.get(id) ?? 0) + 1);

      let ranked = [...counts.entries()]
        .map(([oId, count]) => ({ oId, title: store.getItemSet(oId)?.title ?? `Collection ${oId}`, count }))
        .sort((a, b) => b.count - a.count);
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.title, args.keyword!));

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) => ({ collection: r.title, id: r.oId, item_count: r.count, amira_url: itemSetUrl(r.oId) }),
          { distinct_collections: ranked.length, ...limitEcho(args.limit, 200, limit), ...filtersEcho(args) },
        ),
      );
    },
  );

  // === list_categories ======================================================
  server.registerTool(
    "list_categories",
    {
      title: "List a category facet",
      description: "Ranked formats, languages or resource types used by research items. Feed values into the corresponding search filters.",
      annotations: annotate("List category facet"),
      inputSchema: z.strictObject({
        category: z
          .enum(["formats", "genres", "languages", "resource_types"])
          .describe("'genres' is an alias of 'formats'. The former 'tags' facet is merged into subjects — use list_subjects"),
        keyword: z.string().max(1000).optional().describe("Substring filter on the value"),
        limit: z.number().int().min(1).optional().describe("Default 100, max 500"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const category = args.category === "genres" ? "formats" : args.category;
      // Resource type is minimal-level metadata; formats and languages are not.
      if (category !== "resource_types" && !allowStructured()) {
        return exposureRestrictedResult("structured", `list_categories category='${category}'`);
      }
      const limit = capLimit(args.limit, 100, 500);
      const offset = capOffset(args.offset);

      let ranked = store.cached(`facets:category:${category}`, () => {
      let ranked: RefCount[];
      if (category === "formats") {
        ranked = countRefs(store.items, (it) => [
          ...it.formats,
          ...it.format_notes.map((label) => ({ label, o_id: null })),
        ]);
      } else if (category === "languages") {
        ranked = countRefs(store.items, (it) => it.languages);
      } else {
        ranked = countRefs(store.items, (it) => (it.type ? [{ label: it.type, o_id: null }] : []));
      }
      return ranked;
      });
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.label, args.keyword!));

      const codeOf = (label: string): string | null =>
        store.languageIndex.all.find((l) => l.name === label)?.code ?? null;

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) => ({
            value: r.label,
            ...(category === "languages" ? { code: codeOf(r.label) } : {}),
            item_count: r.count,
            amira_url: itemUrlOrNull(r.o_id),
          }),
          {
            category,
            distinct_values: ranked.length,
            ...limitEcho(args.limit, 500, limit),
            ...filtersEcho({ keyword: args.keyword }),
          },
        ),
      );
    },
  );

  // === list_years ===========================================================
  server.registerTool(
    "list_years",
    {
      title: "List years",
      // Renders through the MCP Apps timeline when the host supports the
      // extension; ignored (plain JSON) everywhere else.
      _meta: TIMELINE_UI_META,
      description: "Research-item year/decade histogram with dated and undated counts. A date range counts in each spanned bucket. Supports shared item filters and pagination.",
      annotations: annotate("List years"),
      outputSchema: timelineSchema,
      inputSchema: z.strictObject({
        filters: researchFilters.optional().describe("Research-item filters applied before bucketing"),
        bucket: z.enum(["year", "decade"]).optional().describe("Default 'year'"),
        from: z.number().int().min(0).max(2200).optional().describe("Earliest year to report (inclusive)"),
        to: z.number().int().min(0).max(2200).optional().describe("Latest year to report (inclusive)"),
        sort: z.enum(["chronological", "count"]).optional().describe("Default 'chronological' (oldest first); 'count' ranks by item count"),
        limit: z.number().int().min(1).optional().describe("Default 200, max 500"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      const bucket = args.bucket ?? "year";
      const sort = args.sort ?? "chronological";
      const limit = capLimit(args.limit, 200, 500);
      const offset = capOffset(args.offset);
      const { from, to } = args;
      if (args.filters && !allowStructured()) return exposureRestrictedResult("structured", "Timeline filters");
      if (invalidYearRange(args.filters?.year_from, args.filters?.year_to)) return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
      if (from !== undefined && to !== undefined && from > to) {
        return errorResult("invalid_range", "`from` must be less than or equal to `to`.");
      }

      const counts = new Map<number, number>(); // key = year, or decade-start year
      let datedItems = 0;
      let undatedItems = 0;
      let yearRange: { min: number; max: number } | null = null;

      for (const it of selectResearchItems(store, args.filters ?? {}).filtered) {
        if (it.year_min == null) {
          undatedItems++;
          continue;
        }
        datedItems++;
        const lo = it.year_min;
        const hi = it.year_max ?? it.year_min;
        yearRange = yearRange
          ? { min: Math.min(yearRange.min, lo), max: Math.max(yearRange.max, hi) }
          : { min: lo, max: hi };
        // Count the item once per distinct bucket across its (windowed) span.
        const spanLo = Math.max(lo, from ?? lo);
        const spanHi = Math.min(hi, to ?? hi);
        const seen = new Set<number>();
        for (let y = spanLo; y <= spanHi; y++) {
          const key = bucket === "decade" ? Math.floor(y / 10) * 10 : y;
          if (seen.has(key)) continue;
          seen.add(key);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }

      const ranked = [...counts.entries()].map(([key, count]) => ({ key, count }));
      ranked.sort(sort === "count" ? (a, b) => b.count - a.count || a.key - b.key : (a, b) => a.key - b.key);

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) =>
            bucket === "decade"
              ? { decade: `${r.key}s`, from: r.key, to: r.key + 9, item_count: r.count }
              : { year: r.key, item_count: r.count },
          {
            bucket,
            sort,
            distinct_buckets: ranked.length,
            dated_items: datedItems,
            undated_items: undatedItems,
            ...(yearRange ? { year_range: yearRange } : {}),
            ...limitEcho(args.limit, 500, limit),
            ...filtersEcho({ from, to, filters: args.filters }),
          },
        ),
      );
    },
  );
}
