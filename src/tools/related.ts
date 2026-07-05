import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec, ResearchItemRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
  containsCI,
  equalsCI,
  exposureRestrictedResult,
  itemRef,
  refLabels,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery, samePerson } from "../names.js";

type EntityType = "subject" | "location" | "person" | "project";

/** How `value` is matched for each pivot — surfaced in the response and the tool
 * description so the (sometimes surprising) counts are self-explaining (report §8). */
const MATCHING: Record<EntityType, string> = {
  subject:
    "Items whose subject label CONTAINS the value (substring, case-insensitive; subjects include the former free-form tags). " +
    "This is why matched_items can exceed an exact-heading count — and differ from list_subjects, which lists distinct headings, not items.",
  location:
    "Items whose place matches the value at ANY level of the city→country hierarchy (so 'Nigeria' also matches Lagos items).",
  person:
    "Items crediting a contributor whose name matches the value in either order and accent-insensitively (e.g. 'Ulli Beier' = 'Beier, Ulli').",
  project: "Items in the project whose Omeka id or legacy project key equals the value, or whose project label contains it.",
};

function topN(map: Map<string, number>, n: number): { name: string; count: number }[] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
}

function inc(map: Map<string, number>, key: string | undefined | null): void {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function registerRelatedTools(server: Server): void {
  server.registerTool(
    "find_related",
    {
      title: "Find related entities",
      description:
        "Cross-entity discovery: given one entity, find what it connects to through the research items " +
        "that mention it. Useful for 'what subjects/people/places co-occur with X?' and for tracing how a " +
        "theme spans projects.\n\n" +
        "Parameters:\n" +
        "  - entity_type (required): 'subject' | 'location' | 'person' | 'project' (tags are merged into " +
        "subjects)\n" +
        "  - value (required): e.g. subject 'Islam', location 'Nigeria', person 'Beier, Ulli', project " +
        "Omeka id '37700' or label 'International Library of African Music'\n" +
        "  - limit: max entries per related list (default 20, max 50)\n\n" +
        "Matching semantics (also echoed in the response `matching` field):\n" +
        "  - subject: substring match on subject labels (incl. former tags) — `matched_items` counts " +
        "ITEMS, so it can differ from list_subjects, which counts distinct headings\n" +
        "  - location: matches any level of the city→country hierarchy ('Nigeria' includes Lagos items)\n" +
        "  - person: name match in either order, accent-insensitive\n" +
        "  - project: Omeka id or legacy key equality, or project-label substring\n\n" +
        "Returns the matched-item count plus ranked related_projects, related_research_sections, " +
        "related_subjects, related_people, related_countries (rolled up to each place's top-level " +
        "country) and related_formats (with co-occurrence counts), up to 10 sample_items (slim refs), " +
        "and the seed's `amira_url` when resolvable. For subject and person seeds it also reports " +
        "matched_publications and up to 10 related_publications from the cluster bibliography (a " +
        "publication matches when its subjects or its authors/editors match the seed). Returns " +
        "matched_items=0 if nothing matches.",
      annotations: annotate("Find related entities"),
      inputSchema: {
        entity_type: z.enum(["subject", "location", "person", "project"]),
        value: z.string().describe("The entity value to pivot on"),
        limit: z.number().int().optional().describe("Per-list cap, default 20, max 50"),
      },
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "find_related");
      const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
      const type = args.entity_type as EntityType;
      const value = args.value;

      const matchesPerson = (name: string): boolean =>
        nameMatchesQuery(name, value) || containsCI(name, value);

      const matches = (it: ResearchItemRec): boolean => {
        switch (type) {
          case "subject":
            return it.subjects.some((s) => containsCI(s.label, value));
          case "location":
            return it.places.some((p) => store.placeChain(p).some((l) => containsCI(l, value)));
          case "person":
            return it.contributors.some((c) => matchesPerson(c.name));
          case "project":
            return equalsCI(String(store.projectOf(it)?.o_id), value) || equalsCI(store.projectOf(it)?.dre_id, value) || containsCI(it.project?.label, value);
        }
      };

      const seed = store.items.filter(matches);

      const projects = new Map<string, number>();
      const sections = new Map<string, number>();
      const subjects = new Map<string, number>();
      const people = new Map<string, number>();
      const countries = new Map<string, number>();
      const formats = new Map<string, number>();

      for (const it of seed) {
        inc(projects, it.project?.label);
        for (const s of store.sectionsOfItem(it)) inc(sections, s);
        for (const s of it.subjects) if (!(type === "subject" && containsCI(s.label, value))) inc(subjects, s.label);
        for (const c of it.contributors) if (!(type === "person" && matchesPerson(c.name))) inc(people, c.name);
        for (const p of it.places) inc(countries, store.countryOf(p));
        for (const f of it.formats) inc(formats, f.label);
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
        for (const s of p.subjects) if (!(type === "subject" && containsCI(s.label, value))) inc(subjects, s.label);
        for (const n of refLabels(p.authors)) if (!(type === "person" && matchesPerson(n))) inc(people, n);
      }

      // Best-effort amira_url for the seed entity itself.
      let seedOId: number | null = null;
      if (type === "person") {
        seedOId =
          store.getPersonByName(value)?.o_id ??
          store.persons.find((p) => samePerson(p.name, value) || nameMatchesQuery(p.name, value))?.o_id ??
          null;
      } else if (type === "project") {
        seedOId =
          store.getProject(value)?.o_id ??
          store.projects.find((p) => equalsCI(p.name, value))?.o_id ??
          store.projects.find((p) => containsCI(p.name, value))?.o_id ??
          null;
      } else if (type === "location") {
        seedOId =
          store.getLocationByName(value)?.o_id ??
          store.locations.find((l) => equalsCI(l.name, value))?.o_id ??
          store.locations.find((l) => containsCI(l.name, value))?.o_id ??
          null;
      } else {
        for (const it of seed) {
          const hit = it.subjects.find((s) => equalsCI(s.label, value)) ?? it.subjects.find((s) => containsCI(s.label, value));
          if (hit?.o_id != null) {
            seedOId = hit.o_id;
            break;
          }
        }
      }

      return textResult({
        entity_type: type,
        value,
        matching: MATCHING[type],
        amira_url: itemUrlOrNull(seedOId),
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
