// Collections (#18). Every research project exists twice in Omeka: as the
// project item (template 5, foaf:Project) and as the item set its records are
// filed in, and both hold the same records. The project item is the canonical
// public page (DRE SEO answers a project's item-set page with a 301 to it), so
// the PROJECT is the collection unit here; its item sets are metadata. Nothing
// below requires the sets to be public: a project whose set is missing from the
// snapshot still forms a collection from its research items' project link.
import type { DataStore } from "./data.js";
import type { ItemSetRec, ProjectRec, ResearchItemRec } from "./types.js";
import { fold } from "./text.js";
import { iiifCollectionUrl, itemSetUrl, itemUrl } from "./urls.js";

export interface Collection {
  /** The project item: the citable unit. Null only for a set no project claims. */
  project: ProjectRec | null;
  /** Public item sets filing the project's records; empty once they are private. */
  sets: ItemSetRec[];
  /** The set's own title when the project files under one set, else the project name. */
  title: string;
  /** Id of the cited page: the project item, else the set. */
  omeka_id: number;
  amira_url: string;
}

interface CollectionIndex {
  all: Collection[];
  byProject: Map<number, Collection>;
  bySet: Map<number, Collection>;
  byCode: Map<string, Collection>;
}

function collectionIndex(store: DataStore): CollectionIndex {
  return store.cached("collections", () => {
    // Older snapshots lack the set → project link: infer it from the project
    // most of the set's research items name. Sets without research items or a
    // link (Persons, Languages, Publications) are registries, not collections.
    const votes = new Map<number, Map<number, number>>();
    for (const it of store.items) {
      const pid = it.project?.o_id;
      if (pid == null) continue;
      for (const setId of it.item_sets) {
        const tally = votes.get(setId) ?? new Map<number, number>();
        tally.set(pid, (tally.get(pid) ?? 0) + 1);
        votes.set(setId, tally);
      }
    }
    const majority = (tally: Map<number, number> | undefined): number | undefined =>
      tally && [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];

    const byProject = new Map<number, Collection>();
    const bySet = new Map<number, Collection>();
    const byCode = new Map<string, Collection>();
    const ofProject = (project: ProjectRec): Collection => {
      let c = byProject.get(project.o_id);
      if (!c) {
        c = { project, sets: [], title: project.name, omeka_id: project.o_id, amira_url: itemUrl(project.o_id) };
        byProject.set(project.o_id, c);
      }
      return c;
    };
    for (const set of store.itemSets) {
      const pid = set.project?.o_id ?? majority(votes.get(set.o_id));
      const project = pid != null ? store.getProjectByOId(pid) : undefined;
      if (!project && !votes.has(set.o_id) && !store.items.some((it) => it.item_sets.includes(set.o_id))) continue;
      const c = project ? ofProject(project)
        : { project: null, sets: [], title: set.title, omeka_id: set.o_id, amira_url: itemSetUrl(set.o_id) };
      c.sets.push(set);
      bySet.set(set.o_id, c);
      if (set.code) byCode.set(fold(set.code), c);
    }
    for (const c of byProject.values()) if (c.sets.length === 1) c.title = c.sets[0]!.title;
    // A project with research items is a collection even when its set is not public.
    for (const it of store.items) {
      const project = store.projectOf(it);
      if (project) ofProject(project);
    }
    const all = [...new Set([...byProject.values(), ...bySet.values()])];
    return { all, byProject, bySet, byCode };
  });
}

/** Every collection holding (or filed for) research items. */
export function allCollections(store: DataStore): Collection[] {
  return collectionIndex(store).all;
}

/** A collection by project id, project `dre:id`, item-set id or collection code. */
export function resolveCollection(store: DataStore, key: string): Collection | undefined {
  const index = collectionIndex(store);
  const k = key.trim();
  const asId = Number(k);
  if (Number.isInteger(asId) && asId > 0) return index.bySet.get(asId) ?? index.byProject.get(asId);
  const byCode = index.byCode.get(fold(k));
  if (byCode) return byCode;
  const project = store.getProject(k);
  return project ? index.byProject.get(project.o_id) : undefined;
}

/** The collection an item set belongs to. */
export function collectionOfItemSet(store: DataStore, setId: number): Collection | undefined {
  return collectionIndex(store).bySet.get(setId);
}

/** Collections a research item belongs to (see `inCollection`). */
export function collectionsOfItem(store: DataStore, it: ResearchItemRec): Collection[] {
  const index = collectionIndex(store);
  const candidates = new Set<Collection>();
  const pid = it.project?.o_id;
  const own = pid != null ? index.byProject.get(pid) : undefined;
  if (own) candidates.add(own);
  for (const setId of it.item_sets) {
    const c = index.bySet.get(setId);
    if (c) candidates.add(c);
  }
  return [...candidates].filter((c) => inCollection(it, c));
}

/** Membership follows the item's own project link; item-set membership only
 * places items that have none (or collections no project claims). */
export function inCollection(it: ResearchItemRec, c: Collection): boolean {
  if (c.project && it.project?.o_id != null) return it.project.o_id === c.project.o_id;
  return it.item_sets.some((id) => c.sets.some((s) => s.o_id === id));
}

export function itemsOfCollection(store: DataStore, c: Collection): ResearchItemRec[] {
  if (!c.project) return store.items.filter((it) => inCollection(it, c));
  const unlinked = c.sets.length ? store.items.filter((it) => it.project?.o_id == null && inCollection(it, c)) : [];
  return [...store.itemsForProject(c.project.o_id), ...unlinked];
}

/** The public description of a collection, cited by its project page. */
export function collectionFields(c: Collection) {
  return {
    id: String(c.omeka_id),
    omeka_id: c.omeka_id,
    // The project's name only when the set calls the collection something else.
    ...(c.project && c.project.name !== c.title ? { project: c.project.name } : {}),
    project_id: c.project?.dre_id ?? null,
    item_sets: c.sets.map((s) => ({ id: s.o_id, code: s.code ?? null })),
    iiif_collection: c.sets[0] ? iiifCollectionUrl(c.sets[0].o_id) : null,
    amira_url: c.amira_url,
  };
}
