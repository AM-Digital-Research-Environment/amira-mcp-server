import { z } from "zod";
import { ensureStore } from "../data.js";
import type { CollectionItem } from "../types.js";
import {
  annotate,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  itemSubjects,
  paginate,
  subjectEntry,
  textResult,
  type Server,
} from "./_shared.js";
import { genreUrl, languageUrl, locationUrl, resourceTypeUrl, tagUrl } from "../urls.js";
import { languageLabel } from "../languages.js";

function rankCounts(map: Map<string, number>): { key: string; count: number }[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }));
}

export function registerFacetTools(server: Server): void {
  // === list_subjects ========================================================
  server.registerTool(
    "list_subjects",
    {
      title: "List subjects",
      description:
        "List the LCSH subject headings used across research items, ranked by how many items carry each. " +
        "Optional `keyword` filters subjects by substring; `limit` (default 50, max 300) and `offset` " +
        "paginate. Each result: subject, item_count, `dashboard_url`. Use the subject value as the " +
        "`subject` filter of search_research_items to retrieve the items themselves.",
      annotations: annotate("List subjects"),
      inputSchema: {
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 300"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);
      const counts = new Map<string, number>();
      for (const it of store.items)
        for (const s of itemSubjects(it)) counts.set(s, (counts.get(s) ?? 0) + 1);
      let ranked = rankCounts(counts);
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.key, args.keyword!));
      const results = ranked.map((r) => subjectEntry(r.key, r.count));
      return textResult(
        paginate(results, offset, limit, {
          distinct_subjects: ranked.length,
          filters: { keyword: args.keyword ?? null },
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
        "List the places where research items originate, ranked by item count, at a chosen level. " +
        "Parameters:\n" +
        "  - level: 'country' (default), 'region' or 'city'\n" +
        "  - country: when listing regions/cities, restrict to this origin country\n" +
        "  - keyword: substring filter on the place name\n" +
        "  - limit (default 50, max 300), offset\n\n" +
        "Each result: name, level, country (for region/city), item_count, latitude/longitude when known, " +
        "and a `dashboard_url`. Use the name as the `location`/`country` filter of search_research_items.",
      annotations: annotate("List locations"),
      inputSchema: {
        level: z.enum(["country", "region", "city"]).optional().describe("Default 'country'"),
        country: z.string().optional(),
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 300"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const level = args.level ?? "country";
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);

      // Count distinct (place, country) pairs per item (dedupe within an item).
      const counts = new Map<string, { name: string; country: string; count: number }>();
      const pick = (it: CollectionItem) => {
        const seen = new Set<string>();
        for (const o of it.location?.origin ?? []) {
          const name = level === "country" ? o.l1 : level === "region" ? o.l2 : o.l3;
          if (!name) continue;
          if (args.country && level !== "country" && !equalsCI(o.l1, args.country)) continue;
          if (args.country && level === "country" && !equalsCI(o.l1, args.country)) continue;
          const country = o.l1 || "";
          const key = `${name}|${country}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const rec = counts.get(key) ?? { name, country, count: 0 };
          rec.count += 1;
          counts.set(key, rec);
        }
      };
      for (const it of store.items) pick(it);

      let ranked = [...counts.values()].sort((a, b) => b.count - a.count);
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.name, args.keyword!));

      const results = ranked.map((r) => {
        const coords = store.coordsFor(r.name, level, r.country);
        return {
          name: r.name,
          level,
          ...(level === "country" ? {} : { country: r.country }),
          item_count: r.count,
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
          dashboard_url: locationUrl(r.name),
        };
      });

      return textResult(
        paginate(results, offset, limit, {
          level,
          distinct_places: ranked.length,
          filters: { country: args.country ?? null, keyword: args.keyword ?? null },
        }),
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
        "  - category (required): 'tags' | 'genres' | 'languages' | 'resource_types'\n" +
        "  - keyword: substring filter on the value\n" +
        "  - limit (default 100, max 500), offset\n\n" +
        "Each result: value, item_count, `dashboard_url`. Languages also include a human-readable `label` " +
        "and are raw ISO 639-2 codes (e.g. 'eng', 'yor'); note some languages span two codes (French is " +
        "both 'fre' and 'fra') — pass a name like 'French' to search_research_items `language` to match " +
        "all of them at once. Feed any value back into the matching filter of search_research_items.",
      annotations: annotate("List category facet"),
      inputSchema: {
        category: z.enum(["tags", "genres", "languages", "resource_types"]),
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 100, max 500"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 100, 500);
      const offset = capOffset(args.offset);

      const valuesOf = (it: CollectionItem): string[] => {
        switch (args.category) {
          case "tags":
            return it.tags ?? [];
          case "genres":
            return it.genre?.marc ?? [];
          case "languages":
            return it.language ?? [];
          case "resource_types":
            return it.typeOfResource ? [it.typeOfResource] : [];
        }
      };
      const urlFor = (v: string): string => {
        switch (args.category) {
          case "tags":
            return tagUrl(v);
          case "genres":
            return genreUrl(v);
          case "languages":
            return languageUrl(v);
          case "resource_types":
            return resourceTypeUrl(v);
        }
      };

      const counts = new Map<string, number>();
      for (const it of store.items) {
        const seen = new Set<string>();
        for (const v of valuesOf(it)) {
          if (!v || seen.has(v)) continue;
          seen.add(v);
          counts.set(v, (counts.get(v) ?? 0) + 1);
        }
      }
      let ranked = rankCounts(counts);
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.key, args.keyword!));
      const results = ranked.map((r) => ({
        value: r.key,
        ...(args.category === "languages" ? { label: languageLabel(r.key) } : {}),
        item_count: r.count,
        dashboard_url: urlFor(r.key),
      }));

      return textResult(
        paginate(results, offset, limit, {
          category: args.category,
          distinct_values: ranked.length,
          filters: { keyword: args.keyword ?? null },
        }),
      );
    },
  );
}
