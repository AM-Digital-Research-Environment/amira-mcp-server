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
  filtersEcho,
  itemSummary,
  pageOf,
  refLabels,
  textResult,
  yearLabel,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

function matchUniversity(item: ResearchItemRec, val: string): boolean {
  return item.university === val.trim().toLowerCase() || containsCI(UNIVERSITY_LABELS[item.university], val);
}

/** Place match across each place's full ancestor chain (city → country). */
function placeMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => store.placeChain(p).some((label) => containsCI(label, needle)));
}

/** Country = the topmost ancestor of a place chain (or the place itself). */
function countryMatches(store: DataStore, item: ResearchItemRec, needle: string): boolean {
  return item.places.some((p) => {
    const chain = store.placeChain(p);
    return containsCI(chain[chain.length - 1] ?? null, needle);
  });
}

function yearsOverlap(item: ResearchItemRec, from?: number, to?: number): boolean {
  if (item.year_min == null) return false;
  const lo = item.year_min;
  const hi = item.year_max ?? item.year_min;
  return lo <= (to ?? Infinity) && hi >= (from ?? -Infinity);
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
        "  - keyword: case-insensitive match across titles, description, abstract, table of contents and " +
        "identifiers\n" +
        "  - subject: subject heading, partial match (e.g. 'Architecture', 'Islam'). Subjects include the " +
        "former free-form tags — there is no separate tag filter\n" +
        "  - location: any place, matched through the place hierarchy (city, region or country)\n" +
        "  - country: match the top-level place only\n" +
        "  - contributor: a person/organisation name in the credits (either name order works)\n" +
        "  - project_id: e.g. 'UBT_ArtWorld2019', 'Ext_ILAM'\n" +
        "  - research_section: e.g. 'Arts & Aesthetics', 'Mobilities'\n" +
        "  - university: ubt | unilag | ujkz | ufba | external (code or name)\n" +
        "  - resource_type: e.g. 'Image', 'Text', 'Audio', 'Moving image'\n" +
        "  - genre: format/genre descriptor, partial (e.g. 'interview', 'letter', 'photograph')\n" +
        "  - language: name or ISO code — 'French', 'fr', 'fra' and the legacy 'fre' all match\n" +
        "  - year_from / year_to: keep items whose content dates overlap the range\n" +
        "  - limit (default 20, max 100), offset (pagination)\n\n" +
        "Returns a paginated envelope { count, total_matches, offset, has_more, next_offset?, results[] }; " +
        "each result carries a citable `amira_url`. Use get_research_item with a dre_id for full detail.",
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

      const project = args.project_id ? store.getProject(args.project_id) : undefined;

      const filtered = store.items.filter((it) => {
        if (args.keyword) {
          const k = args.keyword;
          const hit =
            containsCI(it.title, k) ||
            anyContainsCI(it.alt_titles, k) ||
            containsCI(it.description, k) ||
            containsCI(it.abstract, k) ||
            containsCI(it.toc, k) ||
            anyContainsCI(it.identifiers, k) ||
            equalsCI(it.dre_id, k);
          if (!hit) return false;
        }
        if (args.subject && !it.subjects.some((s) => containsCI(s.label, args.subject!))) return false;
        if (args.location && !placeMatches(store, it, args.location)) return false;
        if (args.country && !countryMatches(store, it, args.country)) return false;
        if (
          args.contributor &&
          !it.contributors.some(
            (c) => nameMatchesQuery(c.name, args.contributor!) || containsCI(c.name, args.contributor!),
          )
        )
          return false;
        if (args.project_id && (project ? it.project?.o_id !== project.o_id : !equalsCI(it.project?.label, args.project_id)))
          return false;
        if (args.research_section && !store.sectionsOfItem(it).some((s) => equalsCI(s, args.research_section!)))
          return false;
        if (args.university && !matchUniversity(it, args.university)) return false;
        if (args.resource_type && !equalsCI(it.type, args.resource_type)) return false;
        if (
          args.genre &&
          !(anyContainsCI(refLabels(it.formats), args.genre) || anyContainsCI(it.format_notes, args.genre))
        )
          return false;
        if (args.language && !store.languageIndex.matches(it.languages, args.language)) return false;
        if ((args.year_from !== undefined || args.year_to !== undefined) && !yearsOverlap(it, args.year_from, args.year_to))
          return false;
        return true;
      });

      return textResult(
        pageOf(filtered, offset, limit, (it) => itemSummary(it, store), filtersEcho(args)),
      );
    },
  );

  // === get_research_item ====================================================
  server.registerTool(
    "get_research_item",
    {
      title: "Get research item detail",
      description:
        "Full metadata for one research item by `dre_id` (e.g. 'abg-99-0000'; the numeric Omeka o:id also " +
        "works). Returns titles, typed content dates (created/collected/issued/…), contributors with " +
        "roles, subjects, places (with their region/country chain), project + research sections + " +
        "university, description, abstract, table of contents, formats and physical notes, sponsors, " +
        "provenance (holding source), access rights, license, identifiers, DOI, external URLs, related " +
        "items (with their own amira_url), languages, audiences, whether digitised media is attached, and " +
        "the citable `amira_url`. Long text fields are truncated at 25,000 characters. Returns { error } " +
        "if the id is unknown.",
      annotations: annotate("Get research item detail"),
      inputSchema: {
        dre_id: z.string().describe("The item's DRE identifier, e.g. 'abg-99-0000' (or its Omeka o:id)"),
      },
    },
    async ({ dre_id }) => {
      const store = await ensureStore();
      const it = store.getItem(dre_id);
      if (!it) {
        return textResult({
          error: `No research item with id '${dre_id}'. Use search_research_items to find valid ids.`,
        });
      }
      const project = store.projectOf(it);
      const description = it.description ? capText(it.description) : null;
      const abstract = it.abstract ? capText(it.abstract) : null;
      const toc = it.toc ? capText(it.toc) : null;

      return textResult({
        dre_id: it.dre_id,
        title: it.title,
        alternative_titles: it.alt_titles,
        type: it.type,
        university: UNIVERSITY_LABELS[it.university],
        project: project ? { id: project.dre_id, name: project.name, amira_url: itemUrl(project.o_id) } : null,
        research_sections: store.sectionsOfItem(it),
        dates: it.dates,
        date: yearLabel(it),
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
        access_rights: it.access_rights,
        license: it.license,
        identifiers: it.identifiers,
        doi: it.doi,
        external_urls: it.urls,
        collection_url: it.collection_url,
        wisski_url: it.wisski_url,
        related_items: it.related.map((r) => ({
          relation: r.relation,
          title: r.ref.label,
          amira_url: itemUrlOrNull(r.ref.o_id),
        })),
        citation: it.citation,
        description: description?.text ?? null,
        description_truncated: description?.truncated || undefined,
        abstract: abstract?.text ?? null,
        abstract_truncated: abstract?.truncated || undefined,
        table_of_contents: toc?.text ?? null,
        has_media: it.has_media,
        amira_url: itemUrl(it.o_id),
      });
    },
  );
}
