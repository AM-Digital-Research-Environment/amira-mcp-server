import { z } from "zod";
import { ensureStore } from "../data.js";
import type { DataStore } from "../data.js";
import type { LinkedRef, ResearchItemRec } from "../types.js";
import {
  annotate,
  capLimit,
  capOffset,
  containsCI,
  filtersEcho,
  pageOf,
  subjectEntry,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrlOrNull } from "../urls.js";

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
      const limit = capLimit(args.limit, 50, 300);
      const offset = capOffset(args.offset);
      let ranked = countRefs(store.items, (it) => it.subjects);
      if (args.keyword) ranked = ranked.filter((r) => containsCI(r.label, args.keyword!));
      return textResult(
        pageOf(ranked, offset, limit, (r) => subjectEntry(r.label, r.o_id, r.count), {
          distinct_subjects: ranked.length,
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
        "List the places research items come from, ranked by item count, at a chosen level of the place " +
        "hierarchy (locations link upward city → region → country).\n" +
        "Parameters:\n" +
        "  - level: 'country' (default), 'region' or 'city'\n" +
        "  - country: restrict regions/cities to one country\n" +
        "  - keyword: substring filter on the place name\n" +
        "  - limit (default 50, max 300), offset\n\n" +
        "Each result: name, level, country (for region/city), item_count, latitude/longitude when known, " +
        "and the place's `amira_url`. Items count toward a place AND its ancestors (an item from Lagos " +
        "counts for Nigeria). Use the name as the `location`/`country` filter of search_research_items.",
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

      // Depth in the location hierarchy: 0 = country, 1 = region, 2+ = city.
      const wantedDepth = level === "country" ? 0 : level === "region" ? 1 : 2;

      interface PlaceCount extends RefCount {
        country: string | null;
      }
      const counts = new Map<string, PlaceCount>();
      for (const it of store.items) {
        const seen = new Set<string>();
        for (const ref of it.places) {
          // The place plus its ancestors, each at its own depth.
          const chain = store.placeChain(ref); // [self, parent, ..., root]
          for (let i = 0; i < chain.length; i++) {
            const depth = chain.length - 1 - i;
            const matches = level === "city" ? depth >= wantedDepth : depth === wantedDepth;
            if (!matches) continue;
            const label = chain[i]!;
            const root = chain[chain.length - 1]!;
            const key = `${label}|${root}`.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            if (args.country && !containsCI(root, args.country) && depth > 0) continue;
            if (args.country && depth === 0 && !containsCI(label, args.country)) continue;
            const oId = i === 0 ? ref.o_id : (store.getLocationByName(label)?.o_id ?? null);
            const rec = counts.get(key) ?? {
              label,
              o_id: oId,
              count: 0,
              country: depth === 0 ? null : root,
            };
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
              level,
              ...(r.country ? { country: r.country } : {}),
              item_count: r.count,
              latitude: loc?.latitude ?? null,
              longitude: loc?.longitude ?? null,
              amira_url: itemUrlOrNull(r.o_id),
            };
          },
          { level, distinct_places: ranked.length, ...filtersEcho({ country: args.country, keyword: args.keyword }) },
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
      const limit = capLimit(args.limit, 100, 500);
      const offset = capOffset(args.offset);
      const category = args.category === "genres" ? "formats" : args.category;

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
          { category, distinct_values: ranked.length, ...filtersEcho({ keyword: args.keyword }) },
        ),
      );
    },
  );
}
