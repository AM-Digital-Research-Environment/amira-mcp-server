// What a record links to in the catalogue: its subjects, places (and their
// countries), people, project(s), research sections and formats.
//
// find_related (every pivot), get_similar_items' explanations and the semantic
// map's group descriptions all read a record's links. Each used to fetch the
// record by kind and pick the fields itself, three copies that had to agree.
import type { DataStore } from "./data.js";
import { RECORD_KINDS } from "./recordKinds.js";
import type { SemanticKind } from "./semantic.js";
import type { LinkedRef } from "./types.js";

export interface RecordLinks {
  subjects: readonly LinkedRef[];
  /** The places as recorded (a city, a country). */
  places: readonly LinkedRef[];
  /** The country of each place: the root of its ancestor chain. */
  countries: readonly LinkedRef[];
  /** Credited people: contributors, authors and editors, speakers, PIs and members. */
  people: readonly LinkedRef[];
  /** A research item's project, or a project itself. */
  projects: readonly LinkedRef[];
  /** A project's research sections (an item's, through its project), or a section itself. */
  sections: readonly LinkedRef[];
  formats: readonly LinkedRef[];
}

const NONE: readonly LinkedRef[] = [];
const EMPTY: RecordLinks = { subjects: NONE, places: NONE, countries: NONE, people: NONE, projects: NONE, sections: NONE, formats: NONE };
const credit = (c: { name: string; o_id: number | null }): LinkedRef => ({ label: c.name, o_id: c.o_id });

function build(store: DataStore, kind: SemanticKind, oId: number): RecordLinks {
  switch (kind) {
    case "research_item": {
      const it = RECORD_KINDS.research_item.byKey(store, String(oId));
      if (!it) return EMPTY;
      return {
        subjects: it.subjects,
        places: it.places,
        countries: it.places.map((p) => store.placeChainRefs(p).at(-1) ?? p),
        people: it.contributors.map(credit),
        projects: it.project ? [it.project] : NONE,
        sections: store.sectionRefsOfItem(it),
        formats: it.formats,
      };
    }
    case "publication": {
      const p = store.getPublication(String(oId));
      return p ? { ...EMPTY, subjects: p.subjects, people: [...p.authors, ...p.editors] } : EMPTY;
    }
    case "video": {
      const v = store.getVideo(oId);
      return v ? { ...EMPTY, people: v.speakers.map(credit) } : EMPTY;
    }
    case "podcast": {
      const p = store.getPodcast(oId);
      return p ? { ...EMPTY, people: p.people.map(credit) } : EMPTY;
    }
    case "project": {
      const p = store.getProjectByOId(oId);
      return p ? { ...EMPTY, projects: [{ label: p.name, o_id: p.o_id }], sections: p.sections, people: [...p.pis, ...p.members] } : EMPTY;
    }
    case "section": {
      const s = store.getSectionByOId(oId);
      return s ? { ...EMPTY, sections: [{ label: s.name, o_id: s.o_id }], people: [...s.pis, ...s.members] } : EMPTY;
    }
  }
}

/** A record's catalogue links, cached for the most recent 4,096 records. */
export function recordLinks(store: DataStore, kind: SemanticKind, oId: number): RecordLinks {
  return store.cachedRecent("record-links", `${kind}:${oId}`, () => build(store, kind, oId), 4096);
}
