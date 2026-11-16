import { schemaOnce } from "./schemaOnce.js";
import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { callStore } from "./callStore.js";
import type { LinkedRef, ResearchItemRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  capOffset,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitParam,
  offsetParam,
  pageOf,
  subjectEntry,
  textParam,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrlOrNull } from "../urls.js";
import { allCollections, collectionFields, itemsOfCollection } from "../collections.js";
import { APP_UI_META } from "./apps.js";
import { researchFilterError, researchFilters, selectResearchItems } from "../researchItemQuery.js";
import { keywordPredicate, placeAliases, RefTally, refKey, type TallyRow } from "../matching.js";
import { fold } from "../text.js";
import { queryErrorResult } from "./responses.js";
import { timelineSchema } from "./outputSchemas.js";

const LIMITS = {
  list_subjects: limitParam(50, 300),
  list_locations: limitParam(50, 300),
  list_collections: limitParam(50, 200),
  list_categories: limitParam(100, 500),
  list_years: limitParam(200, 500),
};

/** Count linked refs across items, each item once per value (src/matching.ts refKey). */
function countRefs(items: ResearchItemRec[], pick: (it: ResearchItemRec) => LinkedRef[]): TallyRow[] {
  const tally = new RefTally();
  for (const it of items) tally.add(pick(it));
  return tally.rows().sort((a, b) => b.count - a.count);
}

/** A row filter on `label` with the search tools' keyword semantics (src/matching.ts keywordPredicate). */
function byLabel(keyword: string): (r: { label: string }) => boolean {
  const matches = keywordPredicate(keyword);
  return (r) => matches([r.label]);
}

/** The first problem with a `near` or `bbox` argument, or null. */
export function geoArgError(near?: { latitude: number; longitude: number; km: number }, bbox?: number[]): string | null {
  const lat = (v: number) => v >= -90 && v <= 90;
  const lon = (v: number) => v >= -180 && v <= 180;
  if (near && (!lat(near.latitude) || !lon(near.longitude))) {
    return "`near` needs latitude in -90..90 and longitude in -180..180.";
  }
  if (bbox) {
    const [west, south, east, north] = bbox as [number, number, number, number];
    if (!lon(west) || !lon(east) || !lat(south) || !lat(north)) {
      return "`bbox` is [west, south, east, north]: longitudes in -180..180, latitudes in -90..90.";
    }
    // west > east is a box across the antimeridian; south > north is no box at all.
    if (south > north) return "`bbox` south must be less than or equal to north ([west, south, east, north]).";
  }
  return null;
}

/** "Library of Congress Subject Headings" → "lcsh", "Tag" → "tag". */
function subjectVocabulary(label: string | null | undefined): string | null {
  if (!label) return null;
  const f = fold(label);
  return f.includes("library of congress") || f === "lcsh" ? "lcsh" : f === "tag" ? "tag" : f;
}

/** Great-circle distance in kilometres. */
function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function registerFacetTools(server: Server, tools: ToolMap): void {
  // === list_subjects ========================================================
  tools.list_subjects = server.registerTool(
    "list_subjects",
    {
      title: "List subjects",
      description: "Subject headings (LCSH or free tags) ranked by distinct research-item count. Feed a heading into search_research_items.subject.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("list_subjects:in", () => z.strictObject({
        keyword: textParam().optional().describe("Filter on the heading; every word must match, quote a phrase"),
        vocabulary: z.enum(["lcsh", "tag", "unspecified"]).optional()
          .describe("lcsh, tag, or unspecified: every other heading (mostly places with no vocabulary)"),
        limit: LIMITS.list_subjects.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_subjects");
      const { limit, echo } = LIMITS.list_subjects.resolve(args.limit);
      const offset = capOffset(args.offset);
      let ranked = store.cached("facets:subjects", () => countRefs(store.items, (it) => it.subjects));
      if (args.keyword) ranked = ranked.filter(byLabel(args.keyword));
      if (args.vocabulary) {
        // Every heading falls under exactly one value: "unspecified" takes any
        // that is neither LCSH nor a tag (mostly places with no vocabulary).
        const vocabularyOf = (r: TallyRow) => subjectVocabulary(r.o_id != null ? store.getSubject(r.o_id)?.vocabulary : null);
        ranked = args.vocabulary === "unspecified"
          ? ranked.filter((r) => { const v = vocabularyOf(r); return v !== "lcsh" && v !== "tag"; })
          : ranked.filter((r) => vocabularyOf(r) === args.vocabulary);
      }
      return textResult(
        pageOf(ranked, offset, limit, (r) => {
          const authority = r.o_id != null ? store.getSubject(r.o_id) : undefined;
          return {
            ...subjectEntry(r.label, r.o_id, r.count),
            ...(authority ? { vocabulary: subjectVocabulary(authority.vocabulary), ...(authority.uri ? { authority_uri: authority.uri } : {}) } : {}),
          };
        }, {
          distinct_subjects: ranked.length,
          ...echo,
          ...filtersEcho(args),
        }),
      );
    },
  );

  // === list_locations =======================================================
  tools.list_locations = server.registerTool(
    "list_locations",
    {
      title: "List locations",
      description: "Research places with coordinates and ancestor rollups. Two tiers: level \"country\" or \"place\" (city, region or site); one item counts under both. Feed a name into search_research_items.location.",
      annotations: READ_ONLY,
      _meta: APP_UI_META,
      inputSchema: schemaOnce("list_locations:in", () => z.strictObject({
        filters: researchFilters.optional().describe("Research-item filters applied before place counts"),
        country: textParam().optional().describe("One country, exact name or alias, plus its cities"),
        keyword: textParam().optional().describe("Filter on the place name; every word must match, quote a phrase"),
        near: z.strictObject({ latitude: z.number(), longitude: z.number(), km: z.number().positive() }).optional()
          .describe("Places within km (> 0) of a point; latitude -90..90, longitude -180..180"),
        bbox: z.array(z.number()).length(4).optional().describe("[west, south, east, north]; west > east crosses the antimeridian"),
        limit: LIMITS.list_locations.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_locations");
      const refused = researchFilterError(args.filters ?? {}, store);
      if (refused) return queryErrorResult(refused);
      const geoError = geoArgError(args.near, args.bbox);
      if (geoError) return errorResult("invalid_argument", geoError);
      const { limit, echo } = LIMITS.list_locations.resolve(args.limit);
      const offset = capOffset(args.offset);

      interface PlaceCount {
        label: string;
        o_id: number | null;
        count: number;
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
            const key = refKey(chain[i]!);
            if (seen.has(key)) continue;
            seen.add(key);
            // country filter keeps the country itself and any place under it.
            const rec = counts.get(key) ?? { label, o_id: oId, count: 0, country: isCountry ? null : root.label };
            rec.count += 1;
            counts.set(key, rec);
          }
        }
      }

      return [...counts.values()].sort((a, b) => b.count - a.count);
      };
      let ranked = Object.keys(args.filters ?? {}).length ? aggregate() : store.cached("facets:locations", aggregate);
      if (args.country) {
        // Exact country (with aliases): "Niger" no longer pulls in Lagos and Ibadan.
        const names = placeAliases(args.country);
        ranked = ranked.filter((r) => names.has(fold(r.country ?? r.label)));
      }
      if (args.keyword) ranked = ranked.filter(byLabel(args.keyword));
      if (args.near || args.bbox) {
        ranked = ranked.filter((r) => {
          const loc = r.o_id != null ? store.getLocation(r.o_id) : undefined;
          if (loc?.latitude == null || loc.longitude == null) return false;
          if (args.near && haversineKm(args.near.latitude, args.near.longitude, loc.latitude, loc.longitude) > args.near.km) return false;
          if (args.bbox) {
            const [west, south, east, north] = args.bbox as [number, number, number, number];
            const inLon = west <= east ? loc.longitude >= west && loc.longitude <= east : loc.longitude >= west || loc.longitude <= east;
            if (!inLon || loc.latitude < south || loc.latitude > north) return false;
          }
          return true;
        });
      }

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          (r) => {
            const loc = r.o_id != null ? store.getLocation(r.o_id) : undefined;
            return {
              name: r.label,
              ...(r.o_id != null ? { id: String(r.o_id) } : {}),
              omeka_id: r.o_id,
              // Two tiers only: a hierarchy root is a country; everything under it
              // (city, region, province, park) is one "place" tier. Flat on purpose.
              level: r.country ? "place" : "country",
              coordinate_scope: r.country ? "place" : "hierarchy_root",
              ...(r.country ? { country: r.country } : {}),
              item_count: r.count,
              latitude: loc?.latitude ?? null,
              longitude: loc?.longitude ?? null,
              ...(loc?.wikidata ? { wikidata: loc.wikidata } : {}),
              amira_url: itemUrlOrNull(r.o_id),
            };
          },
          {
            distinct_places: ranked.length,
            matched_items: selected.length,
            items_without_place: selected.filter((it) => !it.places.length).length,
            ...echo,
            // Mirrors the arguments, so `filters.filters` is this tool's own
            // `filters` argument; the map app replays it (src/ui/views/map.js).
            ...filtersEcho({ country: args.country, keyword: args.keyword, near: args.near, bbox: args.bbox, filters: args.filters }),
          },
        ),
      );
    },
  );

  // === list_collections =====================================================
  tools.list_collections = server.registerTool(
    "list_collections",
    {
      title: "List collections",
      description: "Research collections, one per project, ranked by research-item count and cited by the project page. Feed an id or code into search_research_items.collection.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("list_collections:in", () => z.strictObject({
        keyword: textParam().optional().describe("Filter on the collection title, project name or code; every word must match"),
        limit: LIMITS.list_collections.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_collections");
      const { limit, echo } = LIMITS.list_collections.resolve(args.limit);
      const offset = capOffset(args.offset);

      let ranked = store.cached("facets:collections", () => allCollections(store)
        .map((c) => ({ c, count: itemsOfCollection(store, c).length }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count || a.c.title.localeCompare(b.c.title)));
      if (args.keyword) {
        const matches = keywordPredicate(args.keyword);
        ranked = ranked.filter(({ c }) =>
          matches([c.title, c.project?.name, c.project?.dre_id, ...c.sets.flatMap((s) => [s.title, s.code])]));
      }

      return textResult(
        pageOf(
          ranked,
          offset,
          limit,
          ({ c, count }) => ({ collection: c.title, item_count: count, ...collectionFields(c) }),
          { distinct_collections: ranked.length, ...echo, ...filtersEcho(args) },
        ),
      );
    },
  );

  // === list_categories ======================================================
  tools.list_categories = server.registerTool(
    "list_categories",
    {
      title: "List a category facet",
      description: "Ranked formats, languages or resource types used by research items. Feed values into the corresponding search filters.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("list_categories:in", () => z.strictObject({
        category: z
          .enum(["formats", "genres", "physical_notes", "languages", "resource_types"])
          .describe("'genres' = 'formats' (controlled terms); 'physical_notes' lists free-text notes. Both feed genre. Tags: use list_subjects"),
        keyword: textParam().optional().describe("Filter on the value; every word must match, quote a phrase"),
        limit: LIMITS.list_categories.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      const category = args.category === "genres" ? "formats" : args.category;
      // Resource type is minimal-level metadata; formats and languages are not.
      if (category !== "resource_types" && !allowStructured()) {
        return exposureRestrictedResult("structured", `list_categories category='${category}'`);
      }
      const { limit, echo } = LIMITS.list_categories.resolve(args.limit);
      const offset = capOffset(args.offset);

      let ranked = store.cached(`facets:category:${category}`, () => {
      let ranked: TallyRow[];
      // Controlled format terms and free-text physical notes are separate
      // facets: a sentence-long note is not a format value.
      if (category === "formats") {
        ranked = countRefs(store.items, (it) => it.formats);
      } else if (category === "physical_notes") {
        ranked = countRefs(store.items, (it) => it.format_notes.map((label) => ({ label, o_id: null })));
      } else if (category === "languages") {
        ranked = countRefs(store.items, (it) => it.languages);
      } else {
        ranked = countRefs(store.items, (it) => (it.type ? [{ label: it.type, o_id: null }] : []));
      }
      return ranked;
      });
      if (args.keyword) ranked = ranked.filter(byLabel(args.keyword));

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
            ...echo,
            ...filtersEcho({ keyword: args.keyword }),
          },
        ),
      );
    },
  );

  // === list_years ===========================================================
  tools.list_years = server.registerTool(
    "list_years",
    {
      title: "List years",
      // Renders through the MCP Apps timeline when the host supports the
      // extension; ignored (plain JSON) everywhere else.
      _meta: APP_UI_META,
      description: "Research-item year/decade histogram with dated and undated counts. A date range counts in each spanned bucket. dated_items and year_range follow from/to. Supports item filters and paging.",
      annotations: READ_ONLY,
      outputSchema: schemaOnce("list_years:out", () => timelineSchema),
      inputSchema: schemaOnce("list_years:in", () => z.strictObject({
        filters: researchFilters.optional().describe("Research-item filters applied before bucketing"),
        bucket: z.enum(["year", "decade"]).optional().describe("Default 'year'"),
        from: z.number().int().min(0).max(2200).optional().describe("Earliest year to report (inclusive)"),
        to: z.number().int().min(0).max(2200).optional().describe("Latest year to report (inclusive)"),
        sort: z.enum(["chronological", "count"]).optional().describe("Default 'chronological' (oldest first); 'count' ranks by item count"),
        limit: LIMITS.list_years.schema,
        offset: offsetParam,
      })),
    },
    async (args) => {
      const store = callStore();
      const bucket = args.bucket ?? "year";
      const sort = args.sort ?? "chronological";
      const { limit, echo } = LIMITS.list_years.resolve(args.limit);
      const offset = capOffset(args.offset);
      const { from, to } = args;
      // The same gate as search_research_items: keyword and year filters stay
      // available below `structured`, relational ones are refused.
      const refused = researchFilterError(args.filters ?? {}, store);
      if (refused) return queryErrorResult(refused);
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
        const lo = it.year_min;
        const hi = it.year_max ?? it.year_min;
        // Count the item once per distinct bucket across its (windowed) span.
        // dated_items and year_range describe the same from/to window as the buckets.
        const spanLo = Math.max(lo, from ?? lo);
        const spanHi = Math.min(hi, to ?? hi);
        if (spanLo > spanHi) continue;
        datedItems++;
        yearRange = yearRange
          ? { min: Math.min(yearRange.min, spanLo), max: Math.max(yearRange.max, spanHi) }
          : { min: spanLo, max: spanHi };
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
            ...echo,
            ...filtersEcho({ from, to, filters: args.filters }),
          },
        ),
      );
    },
  );
}
