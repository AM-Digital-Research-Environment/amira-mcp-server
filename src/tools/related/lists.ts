// The related_* lists every find_related pivot returns: which projects,
// sections, subjects, people, countries and formats its matched records share,
// counted per record (src/matching.ts RefTally) and split by corpus.
import { RefTally } from "../../matching.js";
import type { RecordLinks } from "../../recordLinks.js";
import type { SemanticKind } from "../../semantic.js";
import type { LinkedRef } from "../../types.js";
import { itemUrlOrNull } from "../../urls.js";

/** The per-corpus count each record kind adds to. Research items and
 * publications are always reported; the others only by the record pivot. */
const CORPUS_FIELD: Record<SemanticKind, string> = {
  research_item: "research_item_count", publication: "publication_count", video: "video_count",
  podcast: "podcast_count", project: "project_count", section: "section_count",
};
const ALWAYS = ["research_item_count", "publication_count"];

export type RelatedList = "projects" | "sections" | "subjects" | "people" | "countries" | "formats";
const LISTS: readonly RelatedList[] = ["projects", "sections", "subjects", "people", "countries", "formats"];
const LINK_OF: Record<RelatedList, keyof RecordLinks> = {
  projects: "projects", sections: "sections", subjects: "subjects", people: "people", countries: "countries", formats: "formats",
};

export class RelatedLists {
  private readonly tallies = Object.fromEntries(LISTS.map((l) => [l, new RefTally()])) as Record<RelatedList, RefTally>;

  /** Count one matched record's links. `skip` drops values from a list (the
   * pivot's own subject or person, which would otherwise top every list). */
  add(kind: SemanticKind, links: RecordLinks, skip: Partial<Record<RelatedList, (ref: LinkedRef) => boolean>> = {}): void {
    for (const list of LISTS) {
      const refs = links[LINK_OF[list]];
      const drop = skip[list];
      this.tallies[list].add(drop ? refs.filter((r) => !drop(r)) : refs, CORPUS_FIELD[kind]);
    }
  }

  /** The six lists, each its \`limit\` most frequent values. */
  toResponse(limit: number) {
    const rows = (list: RelatedList) => this.tallies[list].top(limit).map((r) => {
      const extra = Object.entries(r.by).filter(([field]) => !ALWAYS.includes(field));
      return {
        name: r.label, omeka_id: r.o_id, count: r.count,
        research_item_count: r.by.research_item_count ?? 0, publication_count: r.by.publication_count ?? 0,
        ...Object.fromEntries(extra),
        amira_url: itemUrlOrNull(r.o_id),
      };
    });
    return {
      related_projects: rows("projects"),
      related_research_sections: rows("sections"),
      related_subjects: rows("subjects"),
      related_people: rows("people"),
      related_countries: rows("countries"),
      related_formats: rows("formats"),
    };
  }
}
