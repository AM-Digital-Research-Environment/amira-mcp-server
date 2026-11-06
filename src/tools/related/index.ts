// find_related: subjects, people, places and projects connected through shared
// records. One module per pivot: the catalogue pivots below (subject, location,
// person, project), the full-text pivot (./fulltext.ts) and the pivot by
// meaning (./meaning.ts). All count what their matched records share through
// RelatedLists (./lists.ts).
import { z } from "zod";
import { ensureStore, type DataStore } from "../../data.js";
import { resolveEntities } from "../../entityGraph.js";
import { allowDescriptive, allowStructured } from "../../exposure.js";
import { personMatches, samePerson } from "../../names.js";
import { recordLinks } from "../../recordLinks.js";
import { placeMatcher } from "../../researchItemQuery.js";
import { stripTypedId } from "../../typedIds.js";
import type { LinkedRef, PublicationRec, ResearchItemRec } from "../../types.js";
import { itemUrl } from "../../urls.js";
import {
  READ_ONLY, capLimit, containsCI, equalsCI, errorResult, exposureRestrictedResult, itemRef, limitEcho, textResult, type Server,
} from "../_shared.js";
import { APP_UI_META } from "../apps.js";
import type { ToolMap } from "../policy.js";
import { relatedByFullText } from "./fulltext.js";
import { RelatedLists } from "./lists.js";
import { MATCHING, type EntityType } from "./matching.js";
import { relatedByMeaning } from "./meaning.js";

export function registerRelatedTools(server: Server, tools: ToolMap): void {
  tools.find_related = server.registerTool(
    "find_related",
    {
      title: "Find related entities",
      // Renders as a radial co-occurrence hub in MCP Apps hosts; plain JSON elsewhere.
      _meta: APP_UI_META,
      description: "Subjects, people, places and projects connected through shared records. Per-corpus counts deduplicate each record; subject/person seeds also include publications. Returns ambiguity and cited samples.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        entity_type: z
          .enum(["subject", "location", "person", "project", "research_item", "record"])
          .describe("What the value denotes. Tags are merged into subjects. research_item: an ILAM African Music article, by full text. " +
            "record: any embedded record, by meaning"),
        value: z
          .string().max(1000)
          .describe(
            "The entity to pivot on. subject: substring of a heading ('Islam'). location: any level of " +
              "the city→country hierarchy ('Nigeria' includes Lagos items). person: a name in either " +
              "order, accent-insensitive ('Beier, Ulli'). project: an Omeka id ('37700'), a legacy key, " +
              "or a substring of the project label. record: an omeka_id or typed id ('publication:29919')",
          ),
        limit: z.number().int().min(1).optional().describe("Per-list cap, default 20, max 50"),
      }),
    },
    async (args) => {
      if (!allowStructured()) return exposureRestrictedResult("structured", "find_related");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 50);
      const type = args.entity_type as EntityType;
      if (type === "research_item") {
        if (!allowDescriptive()) return exposureRestrictedResult("descriptive", "find_related by full text");
        return relatedByFullText(store, stripTypedId(args.value, ["research_item"]), limit, args.limit);
      }
      if (type === "record") return relatedByMeaning(store, args.value, limit, args.limit);
      return relatedByEntity(store, type, type === "project" ? stripTypedId(args.value, ["project"]) : args.value, limit, args.limit);
    },
  );
}

/** The catalogue pivots: research items (and, for subjects and people, publications) matching the value. */
function relatedByEntity(store: DataStore, type: "subject" | "location" | "person" | "project", value: string, limit: number,
  requested: number | undefined) {
  // A person pivot needs one person: "Vierke" used to pool Clarissa and Ulf
  // Vierke into one set of counts. Several authority matches are named and
  // refused; one is matched by id (by full name on unlinked credits); a name
  // with no authority record keeps the old name match.
  const personSeeds = type === "person" ? resolveEntities(store, value, "person") : [];
  if (personSeeds.length > 1) {
    return errorResult("ambiguous_entity", `${personSeeds.length} people match '${value}'; pass a full name or a person:<id>.`, {
      suggested_tool: "resolve_entity",
      available_values: personSeeds.slice(0, 10).map((e) => `${e.label} (${e.id})`),
      terse: "Several people match; pass a full name or a person id.",
    });
  }
  const seedPerson = personSeeds[0];
  const matchesPerson = (name: string, oId: number | null = null): boolean =>
    !seedPerson ? personMatches(name, value)
      : oId != null && seedPerson.omeka_id != null ? oId === seedPerson.omeka_id
        : samePerson(name, seedPerson.label);
  const matchesPlace = type === "location" ? placeMatcher(store, value, "any") : () => false;

  const matches = (it: ResearchItemRec): boolean => {
    switch (type) {
      case "subject":
        return it.subjects.some((s) => containsCI(s.label, value));
      case "location":
        return it.places.some(matchesPlace);
      case "person":
        return it.contributors.some((c) => matchesPerson(c.name, c.o_id));
      case "project": {
        // Never String(undefined): "undefined" must not match every item without a project.
        const p = store.projectOf(it);
        return (p != null && (String(p.o_id) === value || equalsCI(p.dre_id, value))) || containsCI(it.project?.label, value);
      }
    }
  };
  const seed = store.items.filter(matches);

  // Publications join the pivot for subject/person seeds (they carry
  // subjects and authors/editors; they have no place or project links).
  const matchedPubs: PublicationRec[] =
    type === "subject" ? store.publications.filter((p) => p.subjects.some((s) => containsCI(s.label, value)))
      : type === "person" ? store.publications.filter((p) => [...p.authors, ...p.editors].some((r) => matchesPerson(r.label, r.o_id)))
        : [];

  // The pivot's own subject or person would top every list: leave it out.
  const skip = {
    ...(type === "subject" ? { subjects: (s: LinkedRef) => containsCI(s.label, value) } : {}),
    ...(type === "person" ? { people: (r: LinkedRef) => matchesPerson(r.label, r.o_id) } : {}),
  };
  const lists = new RelatedLists();
  for (const it of seed) lists.add("research_item", recordLinks(store, "research_item", it.o_id), skip);
  for (const p of matchedPubs) lists.add("publication", recordLinks(store, "publication", p.o_id), skip);

  const candidates = type === "person" ? personSeeds : resolveEntities(store, value, type);
  return textResult({
    entity_type: type,
    value,
    matching: MATCHING[type],
    amira_url: candidates.length === 1 ? candidates[0]!.amira_url : null,
    seed_candidates: candidates.slice(0, 20), seed_candidate_count: candidates.length, ambiguous: candidates.length > 1,
    ...limitEcho(requested, 50, limit),
    matched_items: seed.length,
    ...(type === "subject" || type === "person" ? { matched_publications: matchedPubs.length } : {}),
    ...lists.toResponse(limit),
    sample_items: seed.slice(0, 10).map(itemRef),
    ...(matchedPubs.length
      ? { related_publications: matchedPubs.slice(0, 10).map((p) => ({ title: p.title, year: p.year, amira_url: itemUrl(p.o_id) })) }
      : {}),
  });
}
