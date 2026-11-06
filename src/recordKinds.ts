// One registry of the record kinds a typed id can name: where each kind's rows
// live, how a key finds one, which detail tool renders it, and the prefix the
// ChatGPT adapter emits. Before this, a "kind → lookup / tool / prefix" switch
// was written out separately in the semantic layer, the find_related pivots,
// get_text_passages, the record resource, `fetch` and the entity graph, and
// the copies had begun to disagree.
//
// No MCP types here: the query layer may use it as freely as the tools.
import type { DataStore } from "./data.js";
import type { RecordKind } from "./typedIds.js";
import type {
  ItemSetRec, JournalRec, LanguageRec, LocationRec, OrganisationRec, PersonRec, PlaylistRec, PodcastRec, ProjectRec,
  PublicationRec, ResearchItemRec, SectionRec, SubjectRec, VideoRec,
} from "./types.js";

/** The record type each kind resolves to. */
export interface RecordTypes {
  research_item: ResearchItemRec;
  publication: PublicationRec;
  video: VideoRec;
  podcast: PodcastRec;
  project: ProjectRec;
  section: SectionRec;
  person: PersonRec;
  organisation: OrganisationRec;
  location: LocationRec;
  subject: SubjectRec;
  journal: JournalRec;
  collection: ItemSetRec;
  playlist: PlaylistRec;
  language: LanguageRec;
}
export type StoredKind = keyof RecordTypes;
type AnyRecord = RecordTypes[StoredKind];

interface KindDef<K extends StoredKind> {
  /** Every record of this kind in the served snapshot. */
  rows(store: DataStore): readonly RecordTypes[K][];
  /** The record a tool argument or typed-id key names: an Omeka id, or the
   * legacy key the kind also accepts (dre:id, publication repository id). */
  byKey(store: DataStore, key: string): RecordTypes[K] | undefined;
  /** The get_* tool that renders this kind, and how it takes the id. */
  detail?: { tool: string; arg(id: string): Record<string, unknown> };
  /** The tool to suggest when a key of this kind is unknown. */
  search?: string;
  /** The id prefix the `search`/`fetch` adapter emits (`item:9902`). */
  fetchPrefix?: string;
}

const byOId = <T>(get: (oId: number) => T | undefined) => (key: string): T | undefined => {
  const n = Number(key.trim());
  return Number.isSafeInteger(n) && n > 0 ? get(n) : undefined;
};
const idArg = (id: string) => ({ id });

export const RECORD_KINDS: { [K in StoredKind]: KindDef<K> } = {
  research_item: {
    rows: (s) => s.items, byKey: (s, k) => s.getItem(k),
    detail: { tool: "get_research_item", arg: idArg }, search: "search_research_items", fetchPrefix: "item",
  },
  publication: {
    rows: (s) => s.publications, byKey: (s, k) => s.getPublication(k),
    detail: { tool: "get_publication", arg: idArg }, search: "search_publications", fetchPrefix: "pub",
  },
  video: {
    rows: (s) => s.videos, byKey: (s, k) => byOId((n) => s.getVideo(n))(k),
    detail: { tool: "get_video", arg: idArg }, search: "search_videos", fetchPrefix: "video",
  },
  podcast: {
    rows: (s) => s.podcasts, byKey: (s, k) => byOId((n) => s.getPodcast(n))(k),
    detail: { tool: "get_podcast", arg: idArg }, search: "search_podcasts", fetchPrefix: "podcast",
  },
  project: {
    rows: (s) => s.projects, byKey: (s, k) => s.getProject(k),
    detail: { tool: "get_project", arg: idArg }, search: "search_projects", fetchPrefix: "project",
  },
  section: {
    rows: (s) => s.sections, byKey: (s, k) => byOId((n) => s.getSectionByOId(n))(k),
    detail: { tool: "get_research_section", arg: idArg }, search: "list_research_sections", fetchPrefix: "section",
  },
  person: {
    rows: (s) => s.persons, byKey: (s, k) => byOId((n) => s.getPersonByOId(n))(k),
    detail: { tool: "get_person", arg: (id) => ({ id: Number(id) }) }, search: "search_persons",
  },
  organisation: {
    rows: (s) => s.organisations, byKey: (s, k) => byOId((n) => s.getOrganisationByOId(n))(k),
    detail: { tool: "get_institution", arg: idArg }, search: "list_institutions",
  },
  location: { rows: (s) => s.locations, byKey: (s, k) => byOId((n) => s.getLocation(n))(k), search: "list_locations" },
  subject: { rows: (s) => s.subjects, byKey: (s, k) => byOId((n) => s.getSubject(n))(k), search: "list_subjects" },
  journal: { rows: (s) => s.journals, byKey: (s, k) => byOId((n) => s.getJournal(n))(k), search: "list_journals" },
  collection: { rows: (s) => s.itemSets, byKey: (s, k) => byOId((n) => s.getItemSet(n))(k), search: "list_collections" },
  playlist: { rows: (s) => s.playlists, byKey: (s, k) => byOId((n) => s.getPlaylist(n))(k), search: "search_videos" },
  language: {
    rows: (s) => s.languageIndex.all,
    byKey: (s, k) => byOId((n) => s.languageIndex.all.find((l) => l.o_id === n))(k),
    search: "list_categories",
  },
};

export const isStoredKind = (kind: string): kind is StoredKind => Object.hasOwn(RECORD_KINDS, kind);

/** The record of `kind` that `key` names (Omeka id, or the kind's legacy key). */
export function findRecord<K extends StoredKind>(store: DataStore, kind: K, key: string): RecordTypes[K] | undefined {
  return RECORD_KINDS[kind].byKey(store, key);
}

/** A record's display title: `title`, else `name`. */
export function recordTitle(r: AnyRecord): string {
  return "title" in r ? r.title : r.name;
}

/** Any record by Omeka id, with its kind. Omeka ids are unique across every
 * resource, so one map serves all kinds; built once per snapshot. */
export function recordByOId(store: DataStore, oId: number): { kind: StoredKind; record: AnyRecord } | undefined {
  return store.cached("records-by-oid", () => {
    const map = new Map<number, { kind: StoredKind; record: AnyRecord }>();
    for (const kind of Object.keys(RECORD_KINDS) as StoredKind[]) {
      for (const record of RECORD_KINDS[kind].rows(store)) if (!map.has(record.o_id)) map.set(record.o_id, { kind, record });
    }
    return map;
  }).get(oId);
}

/** The `fetch` adapter's prefix → kind (`item` → research_item, `pub` → publication). */
export const FETCH_PREFIXES: ReadonlyMap<string, StoredKind> = new Map(
  (Object.keys(RECORD_KINDS) as StoredKind[]).flatMap((kind) => {
    const prefix = RECORD_KINDS[kind].fetchPrefix;
    return prefix ? [[prefix, kind] as const] : [];
  }),
);

/** The detail tool for a typed-id kind, when there is one (suggestions on a wrong-kind id). */
export function detailToolOf(kind: RecordKind): string | undefined {
  return isStoredKind(kind) ? RECORD_KINDS[kind].detail?.tool : undefined;
}
