import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec, ResearchItemRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  containsCI,
  equalsCI,
  exposureRestrictedResult,
  itemRef,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { personMatches } from "../names.js";
import { placeMatcher } from "../researchItemQuery.js";
import { stripTypedId } from "../typedIds.js";
import { RELATED_UI_META } from "./apps.js";
import { resolveEntities } from "../entityGraph.js";
import { fold } from "../text.js";
import { limitEcho } from "./_shared.js";

type EntityType = "subject" | "location" | "person" | "project";

/** How `value` is matched for each pivot — surfaced in the response and the tool
 * description so the (sometimes surprising) counts are self-explaining (report §8). */
const MATCHING: Record<EntityType, string> = {
  subject:
    "Items whose subject label CONTAINS the value (substring, case-insensitive; subjects include the former free-form tags). " +
    "This is why matched_items can exceed an exact-heading count — and differ from list_subjects, which lists distinct headings, not items.",
  location:
    "Items whose place matches the value exactly (or by a common alias) at ANY level of the city→country hierarchy, so 'Nigeria' " +
    "also matches Lagos items but 'Niger' does not match Nigeria. An unknown name falls back to word prefixes ('Ibad' → Ibadan).",
  person:
    "Items crediting a contributor whose name matches the value in either order and accent-insensitively (e.g. 'Ulli Beier' = 'Beier, Ulli').",
  project: "Items in the project whose Omeka id or legacy project key equals the value, or whose project label contains it.",
};

interface Count { name: string; omeka_id: number | null; count: number; research_item_count: number; publication_count: number; amira_url: string | null }
const topN = (map: Map<string, Count>, n: number) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
function countRecord(map: Map<string, Count>, refs: { label: string; o_id: number | null }[], corpus: "research_item_count" | "publication_count") {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = ref.o_id == null ? `label:${fold(ref.label)}` : `id:${ref.o_id}`;
    if (!ref.label || seen.has(key)) continue;
    seen.add(key);
    const row = map.get(key) ?? { name: ref.label, omeka_id: ref.o_id, count: 0, research_item_count: 0, publication_count: 0, amira_url: itemUrlOrNull(ref.o_id) };
    row[corpus]++; row.count++; map.set(key, row);
  }
}

export function registerRelatedTools(server: Server, tools: ToolMap): void {
  tools.find_related = server.registerTool(
    "find_related",
    {
      title: "Find related entities",
      // Renders as a radial co-occurrence hub in MCP Apps hosts; plain JSON elsewhere.
      _meta: RELATED_UI_META,
      description: "Subjects, people, places and projects connected through shared records. Per-corpus counts deduplicate each record; subject/person seeds also include publications. Returns ambiguity and cited samples.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        entity_type: z
          .enum(["subject", "location", "person", "project"])
          .describe("What the value denotes. Tags are merged into subjects — there is no tag pivot"),
        value: z
          .string().max(1000)
          .describe(
            "The entity to pivot on. subject: substring of a heading ('Islam'). location: any level of " +
              "the city→country hierarchy ('Nigeria' includes Lagos items). person: a name in either " +
              "order, accent-insensitive ('Beier, Ulli'). project: an Omeka id ('37700'), a legacy key, " +
              "or a substring of the project label",
          ),
        limit: z.number().int().min(1).optional().describe("Per-list cap, default 20, max 50"),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "find_related");
      const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
      const type = args.entity_type as EntityType;
      const value = type === "project" ? stripTypedId(args.value, ["project"]) : args.value;

      const matchesPerson = (name: string): boolean => personMatches(name, value);
      const matchesPlace = type === "location" ? placeMatcher(store, value, "any") : () => false;

      const matches = (it: ResearchItemRec): boolean => {
        switch (type) {
          case "subject":
            return it.subjects.some((s) => containsCI(s.label, value));
          case "location":
            return it.places.some(matchesPlace);
          case "person":
            return it.contributors.some((c) => matchesPerson(c.name));
          case "project":
            return equalsCI(String(store.projectOf(it)?.o_id), value) || equalsCI(store.projectOf(it)?.dre_id, value) || containsCI(it.project?.label, value);
        }
      };

      const seed = store.items.filter(matches);

      const projects = new Map<string, Count>();
      const sections = new Map<string, Count>();
      const subjects = new Map<string, Count>();
      const people = new Map<string, Count>();
      const countries = new Map<string, Count>();
      const formats = new Map<string, Count>();

      for (const it of seed) {
        countRecord(projects, it.project ? [it.project] : [], "research_item_count");
        countRecord(sections, store.projectOf(it)?.sections ?? [], "research_item_count");
        countRecord(subjects, it.subjects.filter((s) => !(type === "subject" && containsCI(s.label, value))), "research_item_count");
        countRecord(people, it.contributors.filter((c) => !(type === "person" && matchesPerson(c.name))).map((c) => ({ label: c.name, o_id: c.o_id })), "research_item_count");
        countRecord(countries, it.places.map((p) => store.placeChainRefs(p).at(-1)!), "research_item_count");
        countRecord(formats, it.formats, "research_item_count");
      }

      // Publications join the pivot for subject/person seeds (they carry
      // subjects and authors/editors; they have no place or project links).
      const matchedPubs: PublicationRec[] =
        type === "subject"
          ? store.publications.filter((p) => p.subjects.some((s) => containsCI(s.label, value)))
          : type === "person"
            ? store.publications.filter((p) =>
                [...p.authors, ...p.editors].some((r) => matchesPerson(r.label)),
              )
            : [];
      for (const p of matchedPubs) {
        countRecord(subjects, p.subjects.filter((s) => !(type === "subject" && containsCI(s.label, value))), "publication_count");
        countRecord(people, [...p.authors, ...p.editors].filter((s) => !(type === "person" && matchesPerson(s.label))), "publication_count");
      }

      const candidates = resolveEntities(store, value, type);
      return textResult({
        entity_type: type,
        value,
        matching: MATCHING[type],
        amira_url: candidates.length === 1 ? candidates[0]!.amira_url : null,
        seed_candidates: candidates.slice(0, 20), seed_candidate_count: candidates.length, ambiguous: candidates.length > 1,
        ...limitEcho(args.limit, 50, limit),
        matched_items: seed.length,
        ...(type === "subject" || type === "person" ? { matched_publications: matchedPubs.length } : {}),
        related_projects: topN(projects, limit),
        related_research_sections: topN(sections, limit),
        related_subjects: topN(subjects, limit),
        related_people: topN(people, limit),
        related_countries: topN(countries, limit),
        related_formats: topN(formats, limit),
        sample_items: seed.slice(0, 10).map(itemRef),
        ...(matchedPubs.length
          ? {
              related_publications: matchedPubs.slice(0, 10).map((p) => ({
                title: p.title,
                year: p.year,
                amira_url: itemUrl(p.o_id),
              })),
            }
          : {}),
      });
    },
  );
}
