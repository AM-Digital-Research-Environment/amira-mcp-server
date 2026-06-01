import { z } from "zod";
import { ensureStore } from "../data.js";
import type { CollectionItem } from "../types.js";
import {
  annotate,
  containsCI,
  equalsCI,
  itemContributors,
  itemSubjects,
  itemSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { locationUrl, personUrl, projectUrl, subjectUrl, tagUrl } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

type EntityType = "subject" | "location" | "person" | "project" | "tag";

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
        "  - entity_type (required): 'subject' | 'location' | 'person' | 'project' | 'tag'\n" +
        "  - value (required): the entity value (e.g. subject 'Islam', location 'Nigeria', person " +
        "'Beier, Ulli', project 'UBT_ArtWorld2019', tag 'Wall Painting')\n" +
        "  - limit: max entries per related list (default 20, max 50)\n\n" +
        "Returns the matched-item count plus ranked related_projects, related_research_sections, " +
        "related_subjects, related_people, related_locations (origin countries) and related_tags (each with " +
        "co-occurrence counts), a few sample_items, and the seed entity's `dashboard_url`. " +
        "Returns matched_items=0 if nothing matches.",
      annotations: annotate("Find related entities"),
      inputSchema: {
        entity_type: z.enum(["subject", "location", "person", "project", "tag"]),
        value: z.string().describe("The entity value to pivot on"),
        limit: z.number().int().optional().describe("Per-list cap, default 20, max 50"),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = Math.max(1, Math.min(args.limit ?? 20, 50));
      const type = args.entity_type as EntityType;
      const value = args.value;

      const sectionByProject = new Map(store.projects.map((p) => [p.id, p.researchSection ?? []]));

      const matches = (it: CollectionItem): boolean => {
        switch (type) {
          case "subject":
            return itemSubjects(it).some((s) => containsCI(s, value));
          case "tag":
            return (it.tags ?? []).some((t) => containsCI(t, value));
          case "location":
            return (it.location?.origin ?? []).some(
              (o) => containsCI(o.l1, value) || containsCI(o.l2, value) || containsCI(o.l3, value),
            );
          case "person":
            return itemContributors(it).some((c) => nameMatchesQuery(c.name, value) || containsCI(c.name, value));
          case "project":
            return equalsCI(it.project?.id, value) || containsCI(it.project?.name, value);
        }
      };

      const seed = store.items.filter(matches);

      const projects = new Map<string, number>();
      const sections = new Map<string, number>();
      const subjects = new Map<string, number>();
      const people = new Map<string, number>();
      const locations = new Map<string, number>();
      const tags = new Map<string, number>();

      for (const it of seed) {
        inc(projects, it.project?.name);
        for (const s of sectionByProject.get(it.project?.id) ?? []) inc(sections, s);
        for (const s of itemSubjects(it)) if (!(type === "subject" && containsCI(s, value))) inc(subjects, s);
        for (const c of itemContributors(it))
          if (!(type === "person" && nameMatchesQuery(c.name, value))) inc(people, c.name);
        for (const o of it.location?.origin ?? []) inc(locations, o.l1);
        for (const t of it.tags ?? []) if (!(type === "tag" && containsCI(t, value))) inc(tags, t);
      }

      const seedUrl =
        type === "subject"
          ? subjectUrl(value)
          : type === "tag"
            ? tagUrl(value)
            : type === "location"
              ? locationUrl(value)
              : type === "person"
                ? personUrl(value)
                : projectUrl(value);

      return textResult({
        entity_type: type,
        value,
        dashboard_url: seedUrl,
        matched_items: seed.length,
        related_projects: topN(projects, limit),
        related_research_sections: topN(sections, limit),
        related_subjects: topN(subjects, limit),
        related_people: topN(people, limit),
        related_locations: topN(locations, limit),
        related_tags: topN(tags, limit),
        sample_items: seed.slice(0, 15).map(itemSummary),
      });
    },
  );
}
