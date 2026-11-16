import { createHash } from "node:crypto";
import { z } from "zod";
import { citedUrl, citedUrlNullable } from "./visibility.js";
import type { DataStore } from "./data.js";
import type { LinkedRef, OrganisationRec, PersonRec } from "./types.js";
import { fold } from "./text.js";
import { nameKey, nameMatchesQuery } from "./names.js";
import { config } from "./config.js";
import { type NamesakeKind, duplicatePointer, publicNamesakeOf } from "./namesakes.js";
import { chronicleCredits, collaborativeRole } from "./personCredits.js";
import { itemSetUrl, itemUrl } from "./urls.js";
import { collectionOfItemSet } from "./collections.js";
import { snapshotId } from "./snapshotIdentity.js";
import { canonicalTypedId } from "./typedIds.js";
import { RECORD_KINDS, recordTitle } from "./recordKinds.js";

export const entityTypes = ["person", "project", "section", "organisation", "location", "subject", "format", "language",
  "collection", "research_item", "publication", "journal", "podcast", "video", "chronicle", "playlist"] as const;
export type EntityType = typeof entityTypes[number];
export const entitySchema = z.object({ id: z.string(), type: z.enum(entityTypes), label: z.string(),
  omeka_id: z.number().nullable(), amira_url: citedUrlNullable(), resolved: z.boolean(),
  // Curator mode only: a retired private duplicate points to its public namesake (src/namesakes.ts).
  ...(config.access === "curator"
    ? { possible_duplicate_of: z.object({ name: z.string(), omeka_id: z.number(), amira_url: z.string().optional() }).passthrough().optional() }
    : {}) });
export type Entity = z.infer<typeof entitySchema>;
export const evidenceSchema = z.object({ id: z.string(), corpus: z.string(), title: z.string(), amira_url: citedUrl() });
export type Evidence = z.infer<typeof evidenceSchema>;
export const edgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string(),
  kind: z.enum(["explicit", "cooccurrence"]), relation: z.string(), count: z.number(),
  research_item_count: z.number(), publication_count: z.number(), video_count: z.number(), podcast_count: z.number(),
  chronicle_count: z.number(), evidence: z.array(evidenceSchema), evidence_total: z.number() });
type Edge = z.infer<typeof edgeSchema>;
interface Link { source: string; target: string; relation: string; evidence: Evidence }
interface RecordLinks { evidence: Evidence; entities: Set<string> }
export interface GraphIndex {
  entities: Map<string, Entity>; explicit: Map<string, Link[]>; records: Map<string, RecordLinks[]>;
  /** Entities with their folded labels (and a person's order-independent name key), for resolution without re-folding. */
  folded: { entity: Entity; label: string; key?: string }[];
}

export function graphIndex(store: DataStore): GraphIndex {
  return store.cached("entity-graph", () => {
    const entities = new Map<string, Entity>();
    // A collection node keeps its item-set id but cites the project page (#18).
    const collectionUrl = (setId: number) => collectionOfItemSet(store, setId)?.amira_url ?? itemSetUrl(setId);
    const explicit = new Map<string, Link[]>();
    const records = new Map<string, RecordLinks[]>();
    const entity = (type: EntityType, label: string, id: number | null, resolved = true) => {
      const key = id == null ? `literal:${type}:${createHash("sha256").update(fold(label)).digest("hex").slice(0, 16)}` : `${type}:${id}`;
      if (!entities.has(key)) entities.set(key, { id: key, type, label, omeka_id: id,
        amira_url: id == null ? null : type === "collection" ? collectionUrl(id) : itemUrl(id), resolved: id != null && resolved });
      return key;
    };
    // Subjects, languages and formats enter as they are referenced, resolved by type below.
    for (const type of ["person", "project", "section", "organisation", "location", "collection", "research_item", "publication",
      "journal", "podcast", "video", "chronicle", "playlist"] as const) {
      for (const row of RECORD_KINDS[type].rows(store)) entity(type, recordTitle(row), row.o_id);
    }
    // The kind each record was registered under. Omeka ids are unique across
    // resources, so a reference to a registered record joins that one node
    // whatever role it plays: a place used as a subject ("Lagos") used to
    // become a second node, subject:1951 beside location:1951, each with half
    // the edges, and resolve_entity reported the pair as ambiguous.
    const kindOf = new Map<number, EntityType>();
    for (const e of entities.values()) if (e.omeka_id != null && !kindOf.has(e.omeka_id)) kindOf.set(e.omeka_id, e.type);

    const add = (source: string, type: EntityType, ref: LinkedRef, relation: string, evidence: Evidence, group?: Set<string>) => {
      if (!ref.label && ref.o_id == null) return;
      if (ref.o_id != null) type = kindOf.get(ref.o_id) ?? type;
      const target = entity(type, ref.label, ref.o_id, ref.o_id != null &&
        (entities.has(`${type}:${ref.o_id}`) || ["subject", "format", "language"].includes(type)));
      group?.add(target);
      if (source === target) return;
      const link = { source, target, relation, evidence };
      for (const key of [source, target]) {
        const links = explicit.get(key) ?? []; links.push(link); explicit.set(key, links);
      }
    };
    const evidenceOf = (id: string, corpus: string): Evidence => {
      const node = entities.get(id)!;
      return { id, corpus, title: node.label, amira_url: node.amira_url! };
    };
    type Refs = [EntityType, LinkedRef[], string][];
    /** One record's links. `refs` are explicit edges AND members of the record's
     * co-occurrence group; `linksOnly` are explicit edges only. */
    const record = (id: string, corpus: string, refs: Refs, linksOnly: Refs = []) => {
      const evidence = evidenceOf(id, corpus);
      const group = new Set<string>();
      for (const [type, values, relation] of refs) for (const ref of values) add(id, type, ref, relation, evidence, group);
      for (const [type, values, relation] of linksOnly) for (const ref of values) add(id, type, ref, relation, evidence);
      const entry = { evidence, entities: group };
      for (const key of group) { const rows = records.get(key) ?? []; rows.push(entry); records.set(key, rows); }
    };
    // Credits in a non-collaborative role (sound engineer, repository,
    // sponsor…) stay explicit links but share no work, so they co-occur with
    // nobody: the definition get_person and find_related use (src/personCredits.ts).
    type Credit = { name: string; o_id: number | null; role?: string | null };
    const credits = (cs: readonly Credit[], shared: boolean) =>
      cs.filter((c) => collaborativeRole(c.role) === shared).map((c) => ({ label: c.name, o_id: c.o_id }));
    // A related item is an item-to-item link, not a member of the record's
    // group: in the group it made every related item co-occur with the
    // record's places, subjects and people.
    for (const it of store.items) record(`research_item:${it.o_id}`, "research_items", [
      ["person", credits(it.contributors, true), "contributor"],
      ["subject", it.subjects, "subject"], ["location", it.places, "spatial"], ["format", it.formats, "format"],
      ["language", it.languages, "language"], ["project", it.project ? [it.project] : [], "project"],
      ["collection", it.item_sets.map((id) => ({ o_id: id, label: store.getItemSet(id)?.title ?? `Collection ${id}` })), "collection"],
    ], [
      ["person", credits(it.contributors, false), "contributor"],
      ...it.related.map((r): [EntityType, LinkedRef[], string] => ["research_item", [r.ref], r.relation]),
    ]);
    for (const p of store.publications) record(`publication:${p.o_id}`, "publications", [
      ["person", p.authors, "author"], ["person", p.editors, "editor"], ["subject", p.subjects, "subject"],
      ["journal", p.venue_ref ? [p.venue_ref] : [], "venue"], ["organisation", p.funders, "funder"],
      ["location", p.places_of_publication, "publication_place"],
    ]);
    for (const p of store.podcasts) record(`podcast:${p.o_id}`, "podcasts", [
      ["person", credits(p.people, true), "speaker"], ["language", p.languages, "language"],
    ], [["person", credits(p.people, false), "speaker"]]);
    for (const p of store.videos) record(`video:${p.o_id}`, "videos", [
      ["person", credits(p.speakers, true), "speaker"],
      ["playlist", p.playlists, "playlist"], ["language", p.languages, "language"],
    ], [["person", credits(p.speakers, false), "speaker"]]);
    // A chronicle's people are its credits and the people it depicts
    // (src/personCredits.ts), each linked under its own role. A venue that is
    // an institution's record, and a relation to a video or podcast record,
    // join that record's node (kindOf above); a relation is an explicit link
    // only, like a research item's related items.
    const chronicleRole = (role: string) => role.toLowerCase().replace(/\s+/g, "_") || "contributor";
    for (const c of store.chronicles) {
      const people = chronicleCredits(c);
      const byRole = (shared: boolean): Refs =>
        people.filter((p) => collaborativeRole(p.role) === shared)
          .map((p): [EntityType, LinkedRef[], string] => ["person", [{ label: p.name, o_id: p.o_id }], chronicleRole(p.role)]);
      record(`chronicle:${c.o_id}`, "chronicles", [
        ...byRole(true), ["subject", c.subjects, "subject"], ["location", c.places, "spatial"], ["language", c.languages, "language"],
      ], [
        ...byRole(false),
        ...c.relations.map((r): [EntityType, LinkedRef[], string] => ["chronicle", [r], "relation"]),
      ]);
    }
    for (const p of store.projects) record(`project:${p.o_id}`, "projects", [
      ["person", p.pis, "principal_investigator"], ["person", p.members, "member"],
      ["section", p.sections, "section"], ["organisation", p.funded_by, "funder"],
    ]);
    for (const p of store.sections) record(`section:${p.o_id}`, "research_sections", [
      ["person", p.pis, "principal_investigator"], ["person", p.members, "member"],
    ]);
    for (const p of store.persons) record(`person:${p.o_id}`, "persons", [["organisation", p.affiliations, "affiliation"]]);
    for (const p of store.organisations) record(`organisation:${p.o_id}`, "organisations", [["organisation", p.part_of, "part_of"]]);
    for (const p of store.locations) record(`location:${p.o_id}`, "locations", [["location", p.parent ? [p.parent] : [], "within"]]);
    const folded = [...entities.values()].map((entity) =>
      ({ entity, label: fold(entity.label), ...(entity.type === "person" ? { key: nameKey(entity.label) } : {}) }));
    return { entities, explicit, records, folded };
  });
}

/** The person or organisation record behind an entity, for the curator-mode namesake rules. */
function authorityOf(store: DataStore, entity: Entity): { record: PersonRec | OrganisationRec; kind: NamesakeKind } | undefined {
  if (entity.omeka_id == null) return undefined;
  if (entity.type === "person") { const record = store.getPersonByOId(entity.omeka_id); return record && { record, kind: "person" }; }
  if (entity.type === "organisation") { const record = store.getOrganisationByOId(entity.omeka_id); return record && { record, kind: "organisation" }; }
  return undefined;
}

/** The public record a private authority entity duplicates, as its typed id. */
function namesakeId(store: DataStore, entity: Entity): string | undefined {
  const authority = authorityOf(store, entity);
  const canonical = authority && publicNamesakeOf(store, authority.record, authority.kind);
  return canonical ? `${authority.kind}:${canonical.o_id}` : undefined;
}

/** Curator mode: an entity with its `possible_duplicate_of` pointer when it is a retired private duplicate. */
function withPointer(store: DataStore, entity: Entity): Entity {
  const authority = authorityOf(store, entity);
  const pointer = authority ? duplicatePointer(store, authority.record, authority.kind) : {};
  return "possible_duplicate_of" in pointer ? { ...entity, ...pointer } : entity;
}

export function resolveEntities(store: DataStore, query: string, type?: EntityType): Entity[] {
  const all = graphIndex(store).folded.filter(({ entity }) => !type || entity.type === type);
  const raw = query.trim();
  const q = fold(raw);
  if (!q) return [];
  const curator = config.access === "curator";
  // Typed ids from either vocabulary (`item:9902` = `research_item:9902`).
  const typed = canonicalTypedId(raw);
  // A person's full name matches in either order ("Fernand Bationo" = "Bationo, Fernand").
  const key = nameKey(raw);
  let exact = all.filter(({ entity, label, key: k }) =>
    entity.id === typed || String(entity.omeka_id) === raw || label === q || (!!k && k === key)).map(({ entity }) => entity);
  if (exact.length) {
    // A retired private duplicate gives way to its public namesake (curator mode).
    if (curator && exact.length > 1) {
      const ids = new Set(exact.map((e) => e.id));
      exact = exact.filter((e) => { const canonical = namesakeId(store, e); return !canonical || !ids.has(canonical); });
    }
    return curator ? exact.map((e) => withPointer(store, e)) : exact;
  }
  const isPrivate = (e: Entity): number => (curator && authorityOf(store, e)?.record.visibility === "private" ? 1 : 0);
  const partial = all.filter(({ entity, label }) => label.includes(q) || (entity.type === "person" && nameMatchesQuery(entity.label, raw)))
    .map(({ entity }) => entity)
    .sort((a, b) => a.label.localeCompare(b.label) || isPrivate(a) - isPrivate(b) || a.id.localeCompare(b.id));
  return curator ? partial.map((e) => withPointer(store, e)) : partial;
}

/** A seed's edges with their evidence, cached per seed (the most recent 64): an
 * evidence page used to recompute every edge and its SHA-256 id (~120 ms on a
 * busy node such as a language). */
export function entityEdges(store: DataStore, seed: string) {
  return store.cachedRecent("edges", seed, () => computeEdges(store, seed));
}

function computeEdges(store: DataStore, seed: string) {
  const index = graphIndex(store);
  const edges = new Map<string, { edge: Edge; evidence: Map<string, Evidence> }>();
  const add = (source: string, target: string, kind: Edge["kind"], relation: string, evidence: Evidence) => {
    if (target === source) return;
    const id = createHash("sha256").update(JSON.stringify([source, target, kind, relation])).digest("hex").slice(0, 24);
    const row = edges.get(id) ?? { edge: { id, source, target, kind, relation, count: 0, research_item_count: 0,
      publication_count: 0, video_count: 0, podcast_count: 0, chronicle_count: 0, evidence: [], evidence_total: 0 }, evidence: new Map() };
    row.evidence.set(evidence.id, evidence); edges.set(id, row);
  };
  for (const link of index.explicit.get(seed) ?? []) add(link.source, link.target, "explicit", link.relation, link.evidence);
  for (const row of index.records.get(seed) ?? []) for (const target of row.entities) {
    add(seed, target, "cooccurrence", `shared_${row.evidence.corpus}`, row.evidence);
  }
  for (const { edge, evidence } of edges.values()) {
    const refs = [...evidence.values()];
    edge.count = edge.evidence_total = refs.length;
    edge.evidence = refs.slice(0, 1);
    edge.research_item_count = refs.filter((r) => r.corpus === "research_items").length;
    edge.publication_count = refs.filter((r) => r.corpus === "publications").length;
    edge.video_count = refs.filter((r) => r.corpus === "videos").length;
    edge.podcast_count = refs.filter((r) => r.corpus === "podcasts").length;
    edge.chronicle_count = refs.filter((r) => r.corpus === "chronicles").length;
  }
  return [...edges.values()].sort((a, b) => b.edge.count - a.edge.count || a.edge.id.localeCompare(b.edge.id));
}

/** The entity at the far end of one of the seed's edges. */
const neighbourOf = (edge: Edge, seed: string) => edge.source === seed ? edge.target : edge.source;

export function entityGraph(store: DataStore, seed: string, maxNodes: number, maxEdges: number, types?: readonly EntityType[]) {
  const index = graphIndex(store);
  const every = entityEdges(store, seed);
  // Distinct neighbours per type over the whole neighbourhood, so a reader can
  // see what a type filter leaves out.
  const neighbours = new Map<string, EntityType>();
  for (const { edge } of every) {
    const id = neighbourOf(edge, seed);
    neighbours.set(id, index.entities.get(id)!.type);
  }
  const typeCounts: Partial<Record<EntityType, number>> = {};
  for (const type of neighbours.values()) typeCounts[type] = (typeCounts[type] ?? 0) + 1;
  // The filter runs before the bounds: otherwise high-count languages and
  // formats spend the node budget before the requested types are reached.
  const wanted = types?.length ? new Set(types) : null;
  const all = wanted ? every.filter(({ edge }) => wanted.has(neighbours.get(neighbourOf(edge, seed))!)) : every;
  const ids = new Set([seed]);
  const edges: Edge[] = [];
  // Bound both graph complexity and serialized text. Full evidence is pageable.
  let bytes = Buffer.byteLength(JSON.stringify(index.entities.get(seed))) + 1024;
  for (const { edge } of all) {
    const additions = [edge.source, edge.target].filter((id) => !ids.has(id));
    if (edges.length >= maxEdges || ids.size + additions.length > maxNodes) continue;
    const cost = Buffer.byteLength(JSON.stringify(edge)) + additions.reduce((sum, id) => sum + Buffer.byteLength(JSON.stringify(index.entities.get(id))), 0);
    // 42 KB keeps the whole graph result under the 50,000 characters above which
    // Claude Code moves a tool result out of the conversation into a file.
    if (bytes + cost > 42_000) continue;
    bytes += cost;
    for (const id of additions) ids.add(id);
    edges.push(edge);
  }
  return { snapshot_id: snapshotId(store.manifest), seed, nodes: [...ids].map((id) => index.entities.get(id)!), edges,
    total_edges: all.length, truncated: edges.length < all.length, bounds: { max_nodes: maxNodes, max_edges: maxEdges, hops: 1 },
    neighbour_types: typeCounts, ...(wanted ? { types: [...wanted] } : {}) };
}
