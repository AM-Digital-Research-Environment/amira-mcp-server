import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { CollectionItem } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  capText,
  containsCI,
  equalsCI,
  itemContributors,
  itemSubjects,
  itemSummary,
  mainTitle,
  paginate,
  primaryPlace,
  textResult,
  type Server,
} from "./_shared.js";
import { researchItemUrl } from "../urls.js";
import { languageMatches } from "../languages.js";
import { nameMatchesQuery } from "../names.js";

function itemYears(item: CollectionItem): number[] {
  const ys: number[] = [];
  for (const dr of Object.values(item.dateInfo ?? {})) {
    for (const v of [dr?.start, dr?.end]) {
      const m = v ? /(\d{4})/.exec(String(v)) : null;
      if (m) ys.push(Number(m[1]));
    }
  }
  return ys;
}

function matchUniversity(item: CollectionItem, val: string): boolean {
  const v = val.trim().toLowerCase();
  return item.university === v || containsCI(UNIVERSITY_LABELS[item.university], val);
}

function placeMatches(item: CollectionItem, needle: string): boolean {
  return (item.location?.origin ?? []).some(
    (o) => containsCI(o.l1, needle) || containsCI(o.l2, needle) || containsCI(o.l3, needle),
  );
}

export function registerResearchItemTools(server: Server): void {
  // === search_research_items ================================================
  server.registerTool(
    "search_research_items",
    {
      title: "Search research items",
      description:
        "Search the ~4,000 research items (digitised artefacts: images, texts, audio, video, etc.) across " +
        "all Africa Multiple project collections. Every filter is optional and AND-combined; omit all to " +
        "browse. This is the main discovery tool, including for 'items about subject X' or 'items from " +
        "location Y'.\n\n" +
        "Filters:\n" +
        "  - keyword: case-insensitive match across title, abstract, note, tags and identifiers\n" +
        "  - subject: LCSH subject heading (partial match, e.g. 'Architecture', 'Islam')\n" +
        "  - location: any place level — country, region or city (e.g. 'Nigeria', 'Lagos')\n" +
        "  - country: match the origin country specifically\n" +
        "  - contributor: a person/institution/group name in the item's credits (person names match in " +
        "either order — 'Oliver Baumann' or 'Baumann, Oliver')\n" +
        "  - project_id: e.g. 'UBT_ArtWorld2019', 'Ext_ILAM'\n" +
        "  - research_section: e.g. 'Arts & Aesthetics', 'Mobilities'\n" +
        "  - university: ubt | unilag | ujkz | ufba | external (code or name)\n" +
        "  - resource_type: e.g. 'Image', 'Text', 'Audio', 'Moving Image'\n" +
        "  - genre (partial, e.g. 'interview', 'letter')\n" +
        "  - language: a language name or ISO code — 'French' or 'fr'/'fra'/'fre' all match every French\n" +
        "    item (the data splits some languages across ISO 639-2 B/T codes; this filter unifies them)\n" +
        "  - tag\n" +
        "  - year_from / year_to: keep items with a content date in the range\n" +
        "  - limit (default 20, max 100), offset (pagination)\n\n" +
        "Returns a paginated envelope: { count, total_matches, offset, has_more, next_offset?, results[] }. " +
        "Each result has dre_id, title, type_of_resource, project, university, contributors, subjects, " +
        "place, tags and a `dashboard_url`. Use get_research_item with a dre_id for full detail.",
      annotations: annotate("Search research items"),
      inputSchema: {
        keyword: z.string().optional(),
        subject: z.string().optional(),
        location: z.string().optional(),
        country: z.string().optional(),
        contributor: z.string().optional(),
        project_id: z.string().optional(),
        research_section: z.string().optional(),
        university: z.string().optional(),
        resource_type: z.string().optional(),
        genre: z.string().optional(),
        language: z.string().optional(),
        tag: z.string().optional(),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const sectionByProject = new Map(store.projects.map((p) => [p.id, p.researchSection ?? []]));

      const filtered = store.items.filter((it) => {
        if (args.keyword) {
          const k = args.keyword;
          const hay =
            containsCI(mainTitle(it), k) ||
            (it.titleInfo ?? []).some((t) => containsCI(t.title, k)) ||
            containsCI(it.abstract, k) ||
            containsCI(it.note, k) ||
            anyContainsCI(it.tags, k) ||
            (it.identifier ?? []).some((id) => containsCI(id.identifier, k)) ||
            equalsCI(it.dre_id, k);
          if (!hay) return false;
        }
        if (args.subject && !itemSubjects(it).some((s) => containsCI(s, args.subject!))) return false;
        if (args.location && !placeMatches(it, args.location)) return false;
        if (args.country && !(it.location?.origin ?? []).some((o) => containsCI(o.l1, args.country!)))
          return false;
        if (
          args.contributor &&
          !itemContributors(it).some(
            (c) => containsCI(c.name, args.contributor!) || nameMatchesQuery(c.name, args.contributor!),
          )
        )
          return false;
        if (args.project_id && !equalsCI(it.project?.id, args.project_id)) return false;
        if (args.research_section) {
          const secs = sectionByProject.get(it.project?.id) ?? [];
          if (!secs.some((s) => equalsCI(s, args.research_section!))) return false;
        }
        if (args.university && !matchUniversity(it, args.university)) return false;
        if (args.resource_type && !equalsCI(it.typeOfResource, args.resource_type)) return false;
        if (args.genre && !anyContainsCI(it.genre?.marc, args.genre)) return false;
        if (args.language && !languageMatches(it.language, args.language)) return false;
        if (args.tag && !anyContainsCI(it.tags, args.tag)) return false;
        if (args.year_from !== undefined || args.year_to !== undefined) {
          const ys = itemYears(it);
          const from = args.year_from ?? -Infinity;
          const to = args.year_to ?? Infinity;
          if (!ys.some((y) => y >= from && y <= to)) return false;
        }
        return true;
      });

      const filters = {
        keyword: args.keyword ?? null,
        subject: args.subject ?? null,
        location: args.location ?? null,
        country: args.country ?? null,
        contributor: args.contributor ?? null,
        project_id: args.project_id ?? null,
        research_section: args.research_section ?? null,
        university: args.university ?? null,
        resource_type: args.resource_type ?? null,
        genre: args.genre ?? null,
        language: args.language ?? null,
        tag: args.tag ?? null,
        year_from: args.year_from ?? null,
        year_to: args.year_to ?? null,
      };

      return textResult(paginate(filtered.map(itemSummary), offset, limit, { filters }));
    },
  );

  // === get_research_item ====================================================
  server.registerTool(
    "get_research_item",
    {
      title: "Get research item detail",
      description:
        "Full metadata for one research item identified by its `dre_id` (e.g. 'abg-99-0000'). Returns " +
        "titles (main + translated), all contributors with roles and affiliations, LCSH subjects with " +
        "URIs, every origin location, parent project + research sections + university, abstract, note, " +
        "table of contents, identifiers, language, genre, resource type, tags, target audience, access " +
        "conditions, any external URLs on the record, and a citable `dashboard_url`. Long text fields are " +
        "truncated at 25,000 characters. Returns { error } if the dre_id is unknown.",
      annotations: annotate("Get research item detail"),
      inputSchema: {
        dre_id: z.string().describe("The item's DRE identifier, e.g. 'abg-99-0000'"),
      },
    },
    async ({ dre_id }) => {
      const store = await ensureStore();
      const it = store.getItem(dre_id);
      if (!it) {
        return textResult({
          error: `No research item with dre_id '${dre_id}'. Use search_research_items to find valid ids.`,
        });
      }
      const project = store.getProject(it.project?.id ?? "");
      const abstract = it.abstract ? capText(it.abstract) : null;
      const toc = it.tableOfContents ? capText(it.tableOfContents) : null;

      return textResult({
        dre_id: it.dre_id,
        titles: (it.titleInfo ?? []).map((t) => ({ title: t.title, type: t.title_type })),
        title: mainTitle(it),
        type_of_resource: it.typeOfResource || null,
        university: UNIVERSITY_LABELS[it.university],
        project: it.project ? { id: it.project.id, name: it.project.name } : null,
        research_sections: project?.researchSection ?? [],
        contributors: (it.name ?? []).map((n) => ({
          name: n.name?.label,
          qualifier: n.name?.qualifier,
          role: n.role || null,
          affiliations: n.affl ?? [],
        })),
        subjects: (it.subject ?? []).map((s) => ({ label: s.authLabel || s.origLabel, uri: s.uri })),
        locations: (it.location?.origin ?? []).map((o) => ({ country: o.l1, region: o.l2, city: o.l3 })),
        current_location: it.location?.current ?? [],
        place: primaryPlace(it),
        language: it.language ?? [],
        genre: it.genre?.marc ?? [],
        tags: it.tags ?? [],
        target_audience: it.targetAudience ?? [],
        identifiers: (it.identifier ?? []).map((id) => ({ value: id.identifier, type: id.identifier_type })),
        abstract: abstract?.text ?? null,
        abstract_truncated: abstract?.truncated ?? false,
        note: it.note || null,
        table_of_contents: toc?.text ?? null,
        access_condition: it.accessCondition ?? null,
        citation: it.citation ?? [],
        external_urls: it.url ?? [],
        dashboard_url: researchItemUrl(it.dre_id),
      });
    },
  );
}
