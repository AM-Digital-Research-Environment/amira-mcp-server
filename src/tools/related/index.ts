// find_related: subjects, people, places and projects connected through shared
// records. One module per pivot: the catalogue pivots below (subject, location,
// person, project), the full-text pivot (./fulltext.ts) and the pivot by
// meaning (./meaning.ts). All count what their matched records share through
// RelatedLists (./lists.ts).
import { schemaOnce } from "../schemaOnce.js";
import { z } from "zod";
import type { DataStore } from "../../data.js";
import { callStore } from "../callStore.js";
import { resolveEntities } from "../../entityGraph.js";
import { allowDescriptive, allowStructured } from "../../exposure.js";
import { guidanceEnabled } from "../../guidance.js";
import { personMatches, samePerson } from "../../names.js";
import { collaborativeRole } from "../../personCredits.js";
import { recordLinks } from "../../recordLinks.js";
import { placeMatcher } from "../../researchItemQuery.js";
import { fold } from "../../text.js";
import { stripTypedId } from "../../typedIds.js";
import type { LinkedRef, ProjectRec, PublicationRec, ResearchItemRec } from "../../types.js";
import { itemUrl } from "../../urls.js";
import {
  READ_ONLY, capLimit, containsCI, equalsCI, errorResult, exposureRestrictedResult, itemRef, limitEcho, textResult, type Server,
} from "../_shared.js";
import { APP_UI_META } from "../apps.js";
import type { ToolMap } from "../policy.js";
import { relatedByFullText } from "./fulltext.js";
import { RelatedLists } from "./lists.js";
import { MATCHING, SAMPLE_CAP, type EntityType } from "./matching.js";
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
      inputSchema: schemaOnce("find_related:in", () => z.strictObject({
        entity_type: z
          .enum(["subject", "location", "person", "project", "research_item", "record"])
          .describe("What the value denotes. Tags are merged into subjects. research_item: the id of an ILAM African Music " +
            "article, related by full text. record: any embedded record, related by meaning"),
        value: z
          .string().max(1000)
          .describe(
            "The entity to pivot on. subject: substring of a heading ('Islam'). location: any level of " +
              "the city→country hierarchy ('Nigeria' includes Lagos items). person: a name in either " +
              "order, accent-insensitive ('Beier, Ulli'). project: an Omeka id ('37700'), a legacy key, " +
              "or the project name or whole words of it. research_item: an item id ('27733' or 'research_item:27733'), " +
              "not a text query. record: an omeka_id or typed id ('publication:29919')",
          ),
        limit: z.number().int().min(1).optional().describe(`Cap on each related_* list, default 20, max 50; sample lists show at most ${SAMPLE_CAP}`),
      })),
    },
    async (args) => {
      if (!allowStructured()) return exposureRestrictedResult("structured", "find_related");
      const store = callStore();
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

const words = (s: string): string[] => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The one project `value` names: an Omeka id or legacy key, the exact name or
 * a recorded variant, else the only project whose name holds every word of
 * the value as a whole word. A substring used to pool every project it
 * occurred in: "Art" matched ten ("Participation", "Start-up") and returned
 * their items as one set of counts.
 */
function resolveProject(store: DataStore, value: string): { project: ProjectRec } | { error: ReturnType<typeof errorResult> } {
  const byKey = store.getProject(value);
  if (byKey) return { project: byKey };
  const q = fold(value).trim();
  const exact = store.projects.filter((p) => [p.name, ...(p.alt_names ?? [])].some((n) => fold(n).trim() === q));
  const qw = words(value);
  const found = exact.length ? exact
    : qw.length ? store.projects.filter((p) => [p.name, ...(p.alt_names ?? [])].some((n) => { const have = new Set(words(n)); return qw.every((w) => have.has(w)); }))
      : [];
  if (found.length === 1) return { project: found[0]! };
  if (found.length > 1) {
    return { error: errorResult("ambiguous_entity", `${found.length} projects match '${value}'; pass a project id or its full name.`, {
      suggested_tool: "search_projects",
      available_values: found.slice(0, 10).map((p) => `${p.name} (project:${p.o_id})`),
      terse: "Several projects match; pass a project id or its full name.",
    }) };
  }
  const message = `No project with the id, key or name '${value}'.`;
  return { error: errorResult("not_found", `${message} Find one with search_projects.`, { suggested_tool: "search_projects", terse: message }) };
}

/** Distinct values that matched a substring or place pivot, most frequent first: what the counts pool. */
function pooledValues(refs: Iterable<LinkedRef>): { name: string; count: number }[] {
  const tally = new Map<string, { name: string; count: number }>();
  for (const r of refs) {
    const key = r.o_id != null ? `id:${r.o_id}` : `name:${fold(r.label)}`;
    const row = tally.get(key) ?? { name: r.label, count: 0 };
    row.count++;
    tally.set(key, row);
  }
  return [...tally.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
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
  // A project pivot needs one project, refused like a person when several match.
  let project: ProjectRec | undefined;
  if (type === "project") {
    const resolved = resolveProject(store, value);
    if ("error" in resolved) return resolved.error;
    project = resolved.project;
  }
  const seedPerson = personSeeds[0];
  const matchesPerson = (name: string, oId: number | null = null): boolean =>
    !seedPerson ? personMatches(name, value)
      : oId != null && seedPerson.omeka_id != null ? oId === seedPerson.omeka_id
        : samePerson(name, seedPerson.label);
  const matchesPlace = type === "location" ? placeMatcher(store, value, "any") : () => false;
  const matchesSubject = (s: LinkedRef) => containsCI(s.label, value);

  const matches = (it: ResearchItemRec): boolean => {
    switch (type) {
      case "subject":
        return it.subjects.some(matchesSubject);
      case "location":
        return it.places.some(matchesPlace);
      case "person":
        return it.contributors.some((c) => matchesPerson(c.name, c.o_id));
      case "project":
        return it.project?.o_id != null ? it.project.o_id === project!.o_id : equalsCI(it.project?.label, project!.name);
    }
  };
  const seed = store.items.filter(matches);

  // Publications join the pivot for subject/person seeds (they carry
  // subjects and authors/editors; they have no place or project links).
  const matchedPubs: PublicationRec[] =
    type === "subject" ? store.publications.filter((p) => p.subjects.some(matchesSubject))
      : type === "person" ? store.publications.filter((p) => [...p.authors, ...p.editors].some((r) => matchesPerson(r.label, r.o_id)))
        : [];

  // The pivot's own subject or person would top every list: leave it out.
  const skip = {
    ...(type === "subject" ? { subjects: matchesSubject } : {}),
    ...(type === "person" ? { people: (r: LinkedRef) => matchesPerson(r.label, r.o_id) } : {}),
  };
  const lists = new RelatedLists();
  for (const it of seed) {
    // Credited only as crew or custodian (sound engineer, repository…), the
    // person shares no work with the item's other people: get_person does not
    // count them as collaborators either.
    const crewOnly = type === "person" && !it.contributors.some((c) => matchesPerson(c.name, c.o_id) && collaborativeRole(c.role));
    lists.add("research_item", recordLinks(store, "research_item", it.o_id), crewOnly ? { ...skip, people: () => true } : skip);
  }
  for (const p of matchedPubs) lists.add("publication", recordLinks(store, "publication", p.o_id), skip);

  // A substring (subject) or a place at any level (location) pools several
  // values into one set of counts: say which.
  const pooled = type === "subject"
    ? pooledValues([...seed.flatMap((it) => it.subjects.filter(matchesSubject)), ...matchedPubs.flatMap((p) => p.subjects.filter(matchesSubject))])
    : type === "location" ? pooledValues(seed.flatMap((it) => it.places.filter(matchesPlace))) : null;

  const candidates = type === "person" ? personSeeds
    : type === "project" ? resolveEntities(store, `project:${project!.o_id}`, "project")
      : resolveEntities(store, value, type);
  const sampleCap = Math.min(limit, SAMPLE_CAP);
  const empty = !seed.length && !matchedPubs.length && guidanceEnabled()
    ? { hint: type === "subject" ? `No subject heading contains '${value}'. Check the spelling, or browse headings with list_subjects.`
      : type === "location" ? `No place matches '${value}'. Check the spelling, or browse places with list_locations.`
        : type === "person" ? `No record credits '${value}'. Check the name with search_persons.`
          : "This project has no research items." }
    : {};
  return textResult({
    entity_type: type,
    value,
    matching: MATCHING[type],
    amira_url: candidates.length === 1 ? candidates[0]!.amira_url : null,
    seed_candidates: candidates.slice(0, 20), seed_candidate_count: candidates.length, ambiguous: candidates.length > 1,
    ...limitEcho(requested, 50, limit),
    matched_items: seed.length,
    ...(type === "subject" || type === "person" ? { matched_publications: matchedPubs.length } : {}),
    ...(pooled ? { matched_value_count: pooled.length, matched_values: pooled.slice(0, limit) } : {}),
    ...empty,
    ...lists.toResponse(limit),
    sample_items: seed.slice(0, sampleCap).map(itemRef),
    ...(matchedPubs.length
      ? { related_publications: matchedPubs.slice(0, sampleCap)
        .map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, title: p.title, year: p.year, amira_url: itemUrl(p.o_id) })) }
      : {}),
  });
}
