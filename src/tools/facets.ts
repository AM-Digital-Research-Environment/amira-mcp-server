import { z } from "zod";
import { ensureStore } from "../data.js";
import type { DataStore } from "../data.js";
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

interface RefCount {
  label: string;
  o_id: number | null;
  count: number;
}

/** Count linked refs across items, deduping per item by label. */
function countRefs(items: ResearchItemRec[], pick: (it: ResearchItemRec) => LinkedRef[]): RefCount[] {
  const counts = new Map<string, RefCount>();
  for (const it of items) {
    const seen = new Set<string>();
    for (const ref of pick(it)) {
      const key = ref.label.toLowerCase();
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
      description:
        "List the subject headings used across research items, ranked by how many items carry each. " +
        "Subjects include the former free-form tags (merged — there is no separate tag facet). Optional " +
        "`keyword` filters subjects by substring; `limit` (default 50, max 300) and `offset` paginate. " +
        "Each result: subject, item_count, `amira_url` (the subject's own authority page). Feed the value " +
        "into the `subject` filter of search_research_items to retrieve the items.",
      annotations: annotate("List subjects"),
      inputSchema: {
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 300"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_subjects");
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);
      let ranked = countRefs(store.items, (it) => it.subjects);
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
      description:
        "List every place the research items come from, ranked by item count — countries and cities in " +
        "one flat list (there is no city/region/country level to choose). The place hierarchy is rolled " +
        "up, so an item from Lagos counts toward both Lagos and Nigeria, and both appear.\n" +
        "Parameters:\n" +
        "  - country: narrow to places within one country (the country itself plus its cities/regions)\n" +
        "  - keyword: substring filter on the place name\n" +
        "  - limit (default 50, max 300), offset\n\n" +
        "Each result: name, country (the parent country, omitted when the place is itself a country), " +
        "item_count, latitude/longitude when known, and the place's `amira_url`. Feed the name straight " +
        "into the `location` filter of search_research_items.",
      annotations: annotate("List locations"),
      inputSchema: {
        country: z.string().optional(),
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 300"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_locations");
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);

      interface PlaceCount extends RefCount {
        country: string | null;
      }
      const counts = new Map<string, PlaceCount>();
      for (const it of store.items) {
        const seen = new Set<string>();
        for (const ref of it.places) {
          // The place plus its ancestors — each distinct name counts once per item.
          const chain = store.placeChain(ref); // [self, parent, ..., root]
          const root = chain[chain.length - 1]!;
          for (let i = 0; i < chain.length; i++) {
            const label = chain[i]!;
            const isCountry = i === chain.length - 1;
            const key = label.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            // country filter keeps the country itself and any place under it.
            if (args.country && !(containsCI(label, args.country) || containsCI(root, args.country))) continue;
            const oId = i === 0 ? ref.o_id : (store.getLocationByName(label)?.o_id ?? null);
            const rec = counts.get(key) ?? { label, o_id: oId, count: 0, country: isCountry ? null : root };
            rec.count += 1;
            if (rec.o_id == null && oId != null) rec.o_id = oId;
            counts.set(key, rec);
          }
        }
      }

      let ranked = [...counts.values()].sort((a, b) => b.count - a.count);
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
              ...(r.country ? { country: r.country } : {}),
              item_count: r.count,
              latitude: loc?.latitude ?? null,
              longitude: loc?.longitude ?? null,
              amira_url: itemUrlOrNull(r.o_id),
            };
          },
          {
            distinct_places: ranked.length,
            ...limitEcho(args.limit, 300, limit),
            ...filtersEcho({ country: args.country, keyword: args.keyword }),
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
      description:
        "List the collections (Omeka item sets) that research items belong to — per-project collections, " +
        "external archives (e.g. the ILAM collection), and curated sets — ranked by how many research " +
        "items each contains. Optional `keyword` filters by title; `limit` (default 50, max 200) and " +
        "`offset` paginate. Each result: collection, item_count, `amira_url` (the browsable collection " +
        "page). Feed the title or id into the `collection` filter of search_research_items.",
      annotations: annotate("List collections"),
      inputSchema: {
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 200"),
        offset: z.number().int().optional(),
      },
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
      description:
        "List the distinct values of one categorical facet across research items, ranked by item count. " +
        "Parameters:\n" +
        "  - category (required): 'formats' (genre/format descriptors; 'genres' is accepted as an alias) " +
        "| 'languages' | 'resource_types'. The former 'tags' facet is merged into subjects — use " +
        "list_subjects.\n" +
        "  - keyword: substring filter on the value\n" +
        "  - limit (default 100, max 500), offset\n\n" +
        "Each result: value, item_count, `amira_url` of the authority record when linked. Languages also " +
        "include the ISO `code`. Feed values back into the matching search_research_items filter " +
        "(`genre` for formats, `language`, `resource_type`).",
      annotations: annotate("List category facet"),
      inputSchema: {
        category: z.enum(["formats", "genres", "languages", "resource_types"]),
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 100, max 500"),
        offset: z.number().int().optional(),
      },
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
      description:
        "Date histogram of the research items: how many items fall in each year (or decade) of their " +
        "content dates — for coverage-over-time and most-covered-year/decade questions.\n" +
        "Parameters:\n" +
        "  - bucket: 'year' (default) or 'decade'\n" +
        "  - from / to: restrict to a year range (inclusive)\n" +
        "  - sort: 'chronological' (default, oldest first) or 'count' (most items first)\n" +
        "  - limit (default 200, max 500), offset\n\n" +
        "Each result: year (or decade label + from/to span) and item_count. The envelope adds " +
        "dated_items, undated_items, distinct_buckets and the observed year_range. An item whose content " +
        "date is a RANGE counts toward every year it spans, so bucket counts can sum to more than " +
        "dated_items — this mirrors the year_from/year_to filter of search_research_items, into which you " +
        "can feed a year back. Years have no authority page, so results carry no amira_url.",
      annotations: annotate("List years"),
      inputSchema: {
        bucket: z.enum(["year", "decade"]).optional().describe("Default 'year'"),
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        sort: z.enum(["chronological", "count"]).optional().describe("Default 'chronological'"),
        limit: z.number().int().optional().describe("Default 200, max 500"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const bucket = args.bucket ?? "year";
      const sort = args.sort ?? "chronological";
      const limit = capLimit(args.limit, 200, 500);
      const offset = capOffset(args.offset);
      const { from, to } = args;
      if (from !== undefined && to !== undefined && from > to) {
        return errorResult("invalid_range", "`from` must be less than or equal to `to`.");
      }

      const counts = new Map<number, number>(); // key = year, or decade-start year
      let datedItems = 0;
      let undatedItems = 0;
      let yearRange: { min: number; max: number } | null = null;

      for (const it of store.items) {
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
            ...filtersEcho({ from, to }),
          },
        ),
      );
    },
  );
}
