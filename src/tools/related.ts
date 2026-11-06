import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec, ResearchItemRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  containsCI,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  itemRef,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { personMatches, samePerson } from "../names.js";
import { placeMatcher } from "../researchItemQuery.js";
import { stripTypedId } from "../typedIds.js";
import { APP_UI_META } from "./apps.js";
import { resolveEntities } from "../entityGraph.js";
import { fold } from "../text.js";
import { limitEcho, yearLabel } from "./_shared.js";
import { allowDescriptive } from "../exposure.js";
import { fulltextIndex, groupLabelNote, inMappedCollection, neighboursNote, sourceRef } from "../fulltextMaps.js";
import { semanticIndex } from "../semantic.js";
import { noNeighboursReason, resolveSemanticSeed } from "./similar.js";

type EntityType = "subject" | "location" | "person" | "project" | "research_item" | "record";

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
    "Items crediting one person: the authority record the value resolves to (a name in either order, accent-insensitive, " +
    "e.g. 'Ulli Beier' = 'Beier, Ulli', or person:<id>). A value matching several people is refused with their ids.",
  project: "Items in the project whose Omeka id or legacy project key equals the value, or whose project label contains it.",
  research_item:
    "The seed article's closest articles in the ILAM journal African Music by full-text embedding (DRE Visualizations' map); " +
    "the related_* lists count what those articles share. Only articles on the full-text map can be seeds.",
  record:
    "The seed record's 20 closest records by meaning, of any type (EmbeddingGemma 2 vectors of catalogue descriptions: " +
    "research items, publications, videos, podcasts, projects, sections); the related_* lists count what those records share. " +
    "Similar wording, not documented links.",
};

interface Count {
  name: string; omeka_id: number | null; count: number; research_item_count: number; publication_count: number;
  /** Only the `record` pivot reaches these corpora. */
  video_count?: number; podcast_count?: number; project_count?: number; section_count?: number;
  amira_url: string | null;
}
type CountField = "research_item_count" | "publication_count" | "video_count" | "podcast_count" | "project_count" | "section_count";
const topN = (map: Map<string, Count>, n: number) => [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, n);
function countRecord(map: Map<string, Count>, refs: { label: string; o_id: number | null }[], corpus: CountField) {
  const seen = new Set<string>();
  for (const ref of refs) {
    const key = ref.o_id == null ? `label:${fold(ref.label)}` : `id:${ref.o_id}`;
    if (!ref.label || seen.has(key)) continue;
    seen.add(key);
    const row = map.get(key) ?? { name: ref.label, omeka_id: ref.o_id, count: 0, research_item_count: 0, publication_count: 0, amira_url: itemUrlOrNull(ref.o_id) };
    row[corpus] = (row[corpus] ?? 0) + 1; row.count++; map.set(key, row);
  }
}

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
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "find_related");
      const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
      const type = args.entity_type as EntityType;
      const value = type === "project" ? stripTypedId(args.value, ["project"])
        : type === "research_item" ? stripTypedId(args.value, ["research_item"]) : args.value;
      if (type === "research_item") {
        if (!allowDescriptive()) return exposureRestrictedResult("descriptive", "find_related by full text");
        return relatedByFullText(store, value, limit, args.limit);
      }
      if (type === "record") return relatedByMeaning(store, value, limit, args.limit);

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
          case "project":
            return equalsCI(String(store.projectOf(it)?.o_id), value) || equalsCI(store.projectOf(it)?.dre_id, value) || containsCI(it.project?.label, value);        }
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
        countRecord(people, it.contributors.filter((c) => !(type === "person" && matchesPerson(c.name, c.o_id))).map((c) => ({ label: c.name, o_id: c.o_id })), "research_item_count");
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
                [...p.authors, ...p.editors].some((r) => matchesPerson(r.label, r.o_id)),
              )
            : [];
      for (const p of matchedPubs) {
        countRecord(subjects, p.subjects.filter((s) => !(type === "subject" && containsCI(s.label, value))), "publication_count");
        countRecord(people, [...p.authors, ...p.editors].filter((s) => !(type === "person" && matchesPerson(s.label, s.o_id))), "publication_count");
      }

      const candidates = type === "person" ? personSeeds : resolveEntities(store, value, type);
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

type Store = Awaited<ReturnType<typeof ensureStore>>;

/** Records the `record` pivot counts: the seed's closest by meaning, of any type. */
const PIVOT_RECORDS = 20;

/**
 * The semantic pivot (#12, phase 2): the seed's closest records by meaning
 * stand in for the matched records, across every embedded type, and the
 * related_* lists count what they share.
 */
function relatedByMeaning(store: Store, value: string, limit: number, requested: number | undefined) {
  const index = semanticIndex(store);
  if (!index) {
    return errorResult("semantic_unavailable", "This snapshot carries no semantic neighbours (no verified corpus-vector release).", {
      suggested_tool: "find_related",
    });
  }
  const seed = resolveSemanticSeed(store, value, "find_related");
  if ("error" in seed) return seed.error;
  const { record } = seed;
  const reason = noNeighboursReason(index, record.o_id);
  if (reason) return errorResult("no_neighbours", reason, { suggested_tool: "find_related" });
  // The closest overall, not the stored ten of EVERY type: those would add the
  // few sections and podcasts however weakly they match, at equal weight. Taken
  // from the stored lists, so one type still contributes at most ten.
  const neighbours = index.neighbours.get(record.o_id)!.slice(0, PIVOT_RECORDS);

  const maps = { projects: new Map<string, Count>(), sections: new Map<string, Count>(), subjects: new Map<string, Count>(),
    people: new Map<string, Count>(), countries: new Map<string, Count>(), formats: new Map<string, Count>() };
  const person = (c: { name: string; o_id: number | null }) => ({ label: c.name, o_id: c.o_id });
  const byType: Record<string, number> = {};
  for (const { record: n } of neighbours) {
    byType[n.kind] = (byType[n.kind] ?? 0) + 1;
    if (n.kind === "research_item") {
      const it = store.getItem(String(n.o_id))!;
      countRecord(maps.projects, it.project ? [it.project] : [], "research_item_count");
      countRecord(maps.sections, store.projectOf(it)?.sections ?? [], "research_item_count");
      countRecord(maps.subjects, it.subjects, "research_item_count");
      countRecord(maps.people, it.contributors.map(person), "research_item_count");
      countRecord(maps.countries, it.places.map((p) => store.placeChainRefs(p).at(-1)!), "research_item_count");
      countRecord(maps.formats, it.formats, "research_item_count");
    } else if (n.kind === "publication") {
      const p = store.getPublication(String(n.o_id))!;
      countRecord(maps.subjects, p.subjects, "publication_count");
      countRecord(maps.people, [...p.authors, ...p.editors], "publication_count");
    } else if (n.kind === "video") {
      countRecord(maps.people, store.getVideo(n.o_id)!.speakers.map(person), "video_count");
    } else if (n.kind === "podcast") {
      countRecord(maps.people, store.getPodcast(n.o_id)!.people.map(person), "podcast_count");
    } else if (n.kind === "project") {
      const p = store.getProjectByOId(n.o_id)!;
      countRecord(maps.projects, [{ label: p.name, o_id: p.o_id }], "project_count");
      countRecord(maps.sections, p.sections, "project_count");
      countRecord(maps.people, [...p.pis, ...p.members], "project_count");
    } else {
      countRecord(maps.sections, [{ label: n.title, o_id: n.o_id }], "section_count");
    }
  }
  return textResult({
    entity_type: "record",
    value,
    seed_label: record.title,
    seed: { id: String(record.o_id), omeka_id: record.o_id, type: record.kind, title: record.title, amira_url: itemUrl(record.o_id) },
    matching: MATCHING.record,
    amira_url: itemUrl(record.o_id),
    space: { release: index.source.tag, model: index.source.model, generated_at: index.source.generated_at },
    ...limitEcho(requested, 50, limit),
    matched_records: neighbours.length,
    matched_by_type: byType,
    closest: neighbours.slice(0, 10).map(({ record: n, score }) =>
      ({ title: n.title, type: n.kind, score, omeka_id: n.o_id, amira_url: itemUrl(n.o_id) })),
    related_projects: topN(maps.projects, limit),
    related_research_sections: topN(maps.sections, limit),
    related_subjects: topN(maps.subjects, limit),
    related_people: topN(maps.people, limit),
    related_countries: topN(maps.countries, limit),
    related_formats: topN(maps.formats, limit),
  });
}

/** The full-text pivot: the seed's map neighbours stand in for the matched items. */
function relatedByFullText(store: Store, value: string, limit: number, requested: number | undefined) {
  const index = fulltextIndex(store);
  if (!index) return errorResult("fulltext_map_unavailable", "This snapshot carries no full-text map.");
  const item = store.getItem(value);
  if (!item) return errorResult("not_found", `No research item with id '${value}'.`, { suggested_tool: "search_research_items" });
  const article = index.articles.get(item.o_id);
  if (!article) {
    return errorResult("not_on_fulltext_map", inMappedCollection(index, item)
      ? `'${item.title}' is not on the full-text map (no full text, or excluded as shared section text, journal furniture or under 300 words).`
      : "Only articles of the ILAM journal African Music (collection 27724) are on the full-text map.", {
      suggested_tool: "search_research_items",
    });
  }
  const seed = article.neighbours.map((n) => store.getItem(String(n.id))!);
  const maps = { projects: new Map<string, Count>(), sections: new Map<string, Count>(), subjects: new Map<string, Count>(),
    people: new Map<string, Count>(), countries: new Map<string, Count>(), formats: new Map<string, Count>() };
  for (const it of seed) {
    countRecord(maps.projects, it.project ? [it.project] : [], "research_item_count");
    countRecord(maps.sections, store.projectOf(it)?.sections ?? [], "research_item_count");
    countRecord(maps.subjects, it.subjects, "research_item_count");
    countRecord(maps.people, it.contributors.map((c) => ({ label: c.name, o_id: c.o_id })), "research_item_count");
    countRecord(maps.countries, it.places.map((p) => store.placeChainRefs(p).at(-1)!), "research_item_count");
    countRecord(maps.formats, it.formats, "research_item_count");
  }
  const group = index.groups.get(article.group);
  return textResult({
    entity_type: "research_item",
    value,
    seed_label: item.title,
    matching: MATCHING.research_item,
    amira_url: itemUrl(item.o_id),
    ...limitEcho(requested, 50, limit),
    matched_items: seed.length,
    content_group: group ? { id: group.id, label: group.label, label_ai_generated: true, note: groupLabelNote(index) } : null,
    closest_in_content: article.neighbours.map(({ id, score }, i) => {
      const it = seed[i]!;
      return { title: it.title, date: yearLabel(it), score, omeka_id: id, amira_url: itemUrl(id),
        ...(index.articles.get(id)?.group === article.group && group ? { same_group: true } : {}) };
    }),
    neighbours_note: neighboursNote(index),
    source: sourceRef(index),
    related_projects: topN(maps.projects, limit),
    related_research_sections: topN(maps.sections, limit),
    related_subjects: topN(maps.subjects, limit),
    related_people: topN(maps.people, limit),
    related_countries: topN(maps.countries, limit),
    related_formats: topN(maps.formats, limit),
  });
}
