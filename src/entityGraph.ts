import { createHash } from "node:crypto";
import { z } from "zod";
import type { DataStore } from "./data.js";
import type { LinkedRef } from "./types.js";
import { fold } from "./text.js";
import { nameMatchesQuery } from "./names.js";
import { itemSetUrl, itemUrl } from "./urls.js";
import { snapshotId } from "./snapshotIdentity.js";
import { canonicalTypedId } from "./typedIds.js";

export const entityTypes = ["person", "project", "section", "organisation", "location", "subject", "format", "language",
  "collection", "research_item", "publication", "journal", "podcast", "video", "playlist"] as const;
export type EntityType = typeof entityTypes[number];
export const entitySchema = z.object({ id: z.string(), type: z.enum(entityTypes), label: z.string(),
  omeka_id: z.number().nullable(), amira_url: z.string().nullable(), resolved: z.boolean() });
export type Entity = z.infer<typeof entitySchema>;
export const evidenceSchema = z.object({ id: z.string(), corpus: z.string(), title: z.string(), amira_url: z.string() });
export type Evidence = z.infer<typeof evidenceSchema>;
export const edgeSchema = z.object({ id: z.string(), source: z.string(), target: z.string(),
  kind: z.enum(["explicit", "cooccurrence"]), relation: z.string(), count: z.number(),
  research_item_count: z.number(), publication_count: z.number(), video_count: z.number(), podcast_count: z.number(),
  evidence: z.array(evidenceSchema), evidence_total: z.number() });
type Edge = z.infer<typeof edgeSchema>;
interface Link { source: string; target: string; relation: string; evidence: Evidence }
interface RecordLinks { evidence: Evidence; entities: Set<string> }
export interface GraphIndex {
  entities: Map<string, Entity>; explicit: Map<string, Link[]>; records: Map<string, RecordLinks[]>;
  /** Entities with their folded labels, for resolution without re-folding. */
  folded: { entity: Entity; label: string }[];
}

export function graphIndex(store: DataStore): GraphIndex {
  return store.cached("entity-graph", () => {
    const entities = new Map<string, Entity>();
    const explicit = new Map<string, Link[]>();
    const records = new Map<string, RecordLinks[]>();
    const entity = (type: EntityType, label: string, id: number | null, resolved = true) => {
      const key = id == null ? `literal:${type}:${createHash("sha256").update(fold(label)).digest("hex").slice(0, 16)}` : `${type}:${id}`;
      if (!entities.has(key)) entities.set(key, { id: key, type, label, omeka_id: id,
        amira_url: id == null ? null : type === "collection" ? itemSetUrl(id) : itemUrl(id), resolved: id != null && resolved });
      return key;
    };
    for (const [type, rows] of [
      ["person", store.persons], ["project", store.projects], ["section", store.sections],
      ["organisation", store.organisations], ["location", store.locations], ["collection", store.itemSets],
      ["research_item", store.items], ["publication", store.publications], ["journal", store.journals],
      ["podcast", store.podcasts], ["video", store.videos], ["playlist", store.playlists],
    ] as const) for (const row of rows) entity(type, "name" in row ? row.name : row.title, row.o_id);

    const add = (source: string, type: EntityType, ref: LinkedRef, relation: string, evidence: Evidence, group?: Set<string>) => {
      if (!ref.label && ref.o_id == null) return;
      if (type === "person" && ref.o_id != null && entities.has(`organisation:${ref.o_id}`)) type = "organisation";
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
    const record = (id: string, corpus: string, refs: [EntityType, LinkedRef[], string][]) => {
      const evidence = evidenceOf(id, corpus);
      const group = new Set<string>();
      for (const [type, values, relation] of refs) for (const ref of values) add(id, type, ref, relation, evidence, group);
      const entry = { evidence, entities: group };
      for (const key of group) { const rows = records.get(key) ?? []; rows.push(entry); records.set(key, rows); }
    };
    for (const it of store.items) record(`research_item:${it.o_id}`, "research_items", [
      ["person", it.contributors.map((c) => ({ label: c.name, o_id: c.o_id })), "contributor"],
      ["subject", it.subjects, "subject"], ["location", it.places, "spatial"], ["format", it.formats, "format"],
      ["language", it.languages, "language"], ["project", it.project ? [it.project] : [], "project"],
      ["collection", it.item_sets.map((id) => ({ o_id: id, label: store.getItemSet(id)?.title ?? `Collection ${id}` })), "collection"],
      ...it.related.map((r): [EntityType, LinkedRef[], string] => ["research_item", [r.ref], r.relation]),
    ]);
    for (const p of store.publications) record(`publication:${p.o_id}`, "publications", [
      ["person", p.authors, "author"], ["person", p.editors, "editor"], ["subject", p.subjects, "subject"],
      ["journal", p.venue_ref ? [p.venue_ref] : [], "venue"], ["organisation", p.funders, "funder"],
      ["location", p.places_of_publication, "publication_place"],
    ]);
    for (const p of store.podcasts) record(`podcast:${p.o_id}`, "podcasts", [
      ["person", p.people.map((c) => ({ label: c.name, o_id: c.o_id })), "speaker"], ["language", p.languages, "language"],
    ]);
    for (const p of store.videos) record(`video:${p.o_id}`, "videos", [
      ["person", p.speakers.map((c) => ({ label: c.name, o_id: c.o_id })), "speaker"],
      ["playlist", p.playlists, "playlist"], ["language", p.languages, "language"],
    ]);
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
    const folded = [...entities.values()].map((entity) => ({ entity, label: fold(entity.label) }));
    return { entities, explicit, records, folded };
  });
}

export function resolveEntities(store: DataStore, query: string, type?: EntityType): Entity[] {
  const all = graphIndex(store).folded.filter(({ entity }) => !type || entity.type === type);
  const raw = query.trim();
  const q = fold(raw);
  if (!q) return [];
  // Typed ids from either vocabulary (`item:7392` = `research_item:7392`).
  const typed = canonicalTypedId(raw);
  const exact = all.filter(({ entity, label }) => entity.id === typed || String(entity.omeka_id) === raw || label === q).map(({ entity }) => entity);
  if (exact.length) return exact;
  return all.filter(({ entity, label }) => label.includes(q) || (entity.type === "person" && nameMatchesQuery(entity.label, raw)))
    .map(({ entity }) => entity)
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

/** A seed's edges with their evidence, cached per seed (the most recent 64): an
 * evidence page used to recompute every edge and its SHA-256 id (~120 ms on a
 * busy node such as a language). */
export function entityEdges(store: DataStore, seed: string) {
  return store.cachedRecent(`edges:${seed}`, () => computeEdges(store, seed));
}

function computeEdges(store: DataStore, seed: string) {
  const index = graphIndex(store);
  const edges = new Map<string, { edge: Edge; evidence: Map<string, Evidence> }>();
  const add = (source: string, target: string, kind: Edge["kind"], relation: string, evidence: Evidence) => {
    if (target === source) return;
    const id = createHash("sha256").update(JSON.stringify([source, target, kind, relation])).digest("hex").slice(0, 24);
    const row = edges.get(id) ?? { edge: { id, source, target, kind, relation, count: 0, research_item_count: 0,
      publication_count: 0, video_count: 0, podcast_count: 0, evidence: [], evidence_total: 0 }, evidence: new Map() };
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
  }
  return [...edges.values()].sort((a, b) => b.edge.count - a.edge.count || a.edge.id.localeCompare(b.edge.id));
}

export function entityGraph(store: DataStore, seed: string, maxNodes: number, maxEdges: number) {
  const index = graphIndex(store);
  const all = entityEdges(store, seed);
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
    additions.forEach((id) => ids.add(id)); edges.push(edge);
  }
  return { snapshot_id: snapshotId(store.manifest), seed, nodes: [...ids].map((id) => index.entities.get(id)!), edges,
    total_edges: all.length, truncated: edges.length < all.length, bounds: { max_nodes: maxNodes, max_edges: maxEdges, hops: 1 } };
}
