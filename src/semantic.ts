// Corpus vectors (#12, phase 1): nearest neighbours by meaning across research
// items, publications, videos, podcasts, projects and sections.
//
// The vectors come from DRE Visualizations' versioned GitHub releases
// (`semantic-embeddings-v1-<build>`): `vectors.f32` (little-endian float32
// rows), `ids.json` (Omeka ids in row order, with a low-signal flag) and
// `manifest.json` (model, dimensions, normalisation, row count, SHA-256). They
// are built offline from the PUBLIC API only. The crawl downloads one release,
// verifies it against its manifest and refuses any mismatch, so two vector
// spaces can never mix. It then computes the top neighbours of every record
// present in the snapshot and stores those, never the vectors themselves
// (~15 MB): no model and no vector runs at request time.
//
// The same verified vectors also give the semantic map (get_semantic_map):
// seeded spherical k-means groups of the records, stored as member ids ordered
// by closeness to their group's centre. Groups are unnamed and renumbered per
// build (1 = the largest).
//
// Low-signal records (too little own text: title, abstract or description,
// subjects and places) are excluded as sources and as neighbours, by the
// producer's rule. Similarity measures how alike two catalogue descriptions
// read, nothing more: it is never evidence of a documented relation.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { DataStore } from "./data.js";
import type { SnapshotData } from "./types.js";

/** Where the vectors come from, and the one space this server accepts. */
export const SEMANTIC_SOURCE = {
  repository: "AM-Digital-Research-Environment/DRE-Visualizations",
  /** Release tags of the corpus-vector builds; the number is the build. */
  tagPattern: /^semantic-embeddings-v1-(\d{1,9})$/,
  model: "google/embeddinggemma-2",
  dimensions: 768,
  normalization: "l2",
  dtype: "float32-le",
} as const;

/** Neighbours kept per source AND per record type, so a `types` filter is exact up to this limit. */
export const NEIGHBOURS_PER_TYPE = 10;

/** The producer's corpus names → this server's record kinds and snapshot corpora. */
const PRODUCER_TYPES = {
  "research-items": { kind: "research_item", corpus: "research_items" },
  publications: { kind: "publication", corpus: "publications" },
  youtube: { kind: "video", corpus: "videos" },
  podcasts: { kind: "podcast", corpus: "podcasts" },
  projects: { kind: "project", corpus: "projects" },
  sections: { kind: "section", corpus: "research_sections" },
} as const;
export const SEMANTIC_KINDS = ["research_item", "publication", "video", "podcast", "project", "section"] as const;
export type SemanticKind = (typeof SEMANTIC_KINDS)[number];

const omekaId = z.number().int().positive();
const idKey = z.string().regex(/^[1-9]\d{0,9}$/);

const releaseManifestSchema = z.object({
  schemaVersion: z.literal(1),
  model: z.string().max(200),
  dimensions: z.number().int().positive().max(8192),
  dtype: z.string().max(40),
  normalization: z.string().max(40),
  count: z.number().int().positive().max(1_000_000),
  modelRevision: z.string().max(80),
  rowOrder: z.literal("ids.json"),
  vectors: z.literal("vectors.f32"),
  vectorsSha256: z.string().regex(/^[0-9a-f]{64}$/),
  generatedAt: z.string().max(40),
});
const idsSchema = z.array(z.object({ id: omekaId, type: z.string().max(40), lowSignal: z.boolean() })).max(1_000_000);

export interface VerifiedRelease {
  tag: string;
  manifest: z.infer<typeof releaseManifestSchema>;
  ids: z.infer<typeof idsSchema>;
  /** Row-major, `manifest.count` × `manifest.dimensions`. */
  vectors: Float32Array;
}

/** Validate a release tag before it becomes part of a download URL. */
export function semanticBuild(tag: string): number | null {
  const m = SEMANTIC_SOURCE.tagPattern.exec(tag);
  return m ? Number(m[1]) : null;
}

/**
 * Verify a downloaded release against its own manifest and against the space
 * this server accepts. Throws on ANY mismatch: model, dimensions, dtype,
 * normalisation, row count, byte length, checksum or row norms.
 */
export function verifySemanticRelease(input: { tag: string; manifest: unknown; ids: unknown; vectors: Uint8Array }): VerifiedRelease {
  const { tag } = input;
  if (semanticBuild(tag) == null) throw new Error(`semantic release: '${tag}' is not a corpus-vector release tag`);
  const manifest = releaseManifestSchema.parse(input.manifest);
  for (const key of ["model", "dimensions", "dtype", "normalization"] as const) {
    if (manifest[key] !== SEMANTIC_SOURCE[key]) {
      throw new Error(`semantic release ${tag}: ${key} is ${manifest[key]}, this server expects ${SEMANTIC_SOURCE[key]}`);
    }
  }
  const ids = idsSchema.parse(input.ids);
  if (ids.length !== manifest.count) throw new Error(`semantic release ${tag}: ids.json has ${ids.length} rows, manifest says ${manifest.count}`);
  if (new Set(ids.map((r) => r.id)).size !== ids.length) throw new Error(`semantic release ${tag}: duplicate ids in ids.json`);
  const dims = manifest.dimensions;
  if (input.vectors.byteLength !== manifest.count * dims * 4) {
    throw new Error(`semantic release ${tag}: vectors.f32 is ${input.vectors.byteLength} bytes, expected ${manifest.count * dims * 4}`);
  }
  const sha = createHash("sha256").update(input.vectors).digest("hex");
  if (sha !== manifest.vectorsSha256) throw new Error(`semantic release ${tag}: vectors.f32 checksum does not match the manifest`);
  const view = new DataView(input.vectors.buffer, input.vectors.byteOffset, input.vectors.byteLength);
  const vectors = new Float32Array(manifest.count * dims);
  for (let i = 0; i < vectors.length; i++) vectors[i] = view.getFloat32(i * 4, true);
  for (let row = 0; row < manifest.count; row++) {
    let norm = 0;
    for (let d = row * dims, end = d + dims; d < end; d++) norm += vectors[d]! * vectors[d]!;
    if (!(Math.abs(norm - 1) < 1e-3)) throw new Error(`semantic release ${tag}: row ${row} is not L2-normalised`);
  }
  return { tag, manifest, ids, vectors };
}

// --- the stored product ----------------------------------------------------------

const neighboursFileSchema = z.object({
  source: z.object({
    repository: z.string().max(200), tag: z.string().max(80), model: z.string().max(200), model_revision: z.string().max(80),
    dimensions: z.number().int().positive(), generated_at: z.string().max(40), vectors_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    neighbours_per_type: z.number().int().positive().max(100),
  }),
  /** Embedded records present in the snapshot that are low-signal: no neighbours, by design. */
  low_signal: z.array(omekaId).max(1_000_000),
  /** Source id → [neighbour id, round(score × 10⁴), …], best first. */
  neighbours: z.record(idKey, z.array(z.number().int().min(-10_000)).max(SEMANTIC_KINDS.length * 100 * 2)),
  /** The semantic map: group g + 1 is `members[g]`, closest to its centre first. Optional: absent before 1.34.0. */
  clusters: z.object({
    algorithm: z.literal("spherical-kmeans"),
    seed: z.number().int(),
    iterations: z.number().int().positive(),
    members: z.array(z.array(omekaId).min(1).max(1_000_000)).min(1).max(500),
  }).optional(),
});
export type SemanticNeighbours = z.infer<typeof neighboursFileSchema>;

/** What the snapshot manifest records about the stored neighbours. */
export interface SemanticManifestEntry { repository: string; tag: string; model: string; generated_at: string; sources: number }

export function parseSemanticNeighbours(raw: unknown): SemanticNeighbours {
  const out = neighboursFileSchema.parse(raw);
  const grouped = out.clusters?.members.flat() ?? [];
  if (new Set(grouped).size !== grouped.length) throw new Error("semantic clusters: a record sits in two groups");
  for (const [id, flat] of Object.entries(out.neighbours)) {
    if (flat.length % 2) throw new Error(`semantic neighbours: '${id}' has an odd-length list`);
    for (let i = 0; i < flat.length; i += 2) {
      if (!(flat[i]! > 0) || flat[i + 1]! > 10_000) throw new Error(`semantic neighbours: '${id}' holds an invalid id or score`);
    }
  }
  return out;
}

export function semanticManifestEntry(s: SemanticNeighbours): SemanticManifestEntry {
  return { repository: s.source.repository, tag: s.source.tag, model: s.source.model, generated_at: s.source.generated_at,
    sources: Object.keys(s.neighbours).length };
}

/** Snapshot ids per record kind: the only ids a neighbour list may reference. */
function snapshotIds(data: SnapshotData): Record<SemanticKind, Set<number>> {
  const out = {} as Record<SemanticKind, Set<number>>;
  for (const { kind, corpus } of Object.values(PRODUCER_TYPES)) out[kind] = new Set(data[corpus].map((r) => r.o_id));
  return out;
}

/**
 * Top neighbours of every embedded record present in `data`, by cosine (dot
 * product of L2-normalised rows): the best NEIGHBOURS_PER_TYPE of each record
 * kind, merged best first. Rows absent from the snapshot (deleted, made private,
 * or of a type it does not hold) are dropped BEFORE ranking, so a stale release
 * can never cite a missing record. Yields to the event loop as it goes: a live
 * refresh runs this inside a serving process.
 */
export async function computeNeighbours(release: VerifiedRelease, data: SnapshotData,
  opts: { signal?: AbortSignal; perType?: number; clusters?: number } = {}): Promise<SemanticNeighbours> {
  const perType = opts.perType ?? NEIGHBOURS_PER_TYPE;
  const present = snapshotIds(data);
  const dims = release.manifest.dimensions;
  const v = release.vectors;
  const rows: { row: number; id: number; kind: number }[] = [];
  const lowSignal: number[] = [];
  release.ids.forEach((r, row) => {
    const type = PRODUCER_TYPES[r.type as keyof typeof PRODUCER_TYPES];
    if (!type || !present[type.kind].has(r.id)) return;
    if (r.lowSignal) lowSignal.push(r.id);
    else rows.push({ row, id: r.id, kind: SEMANTIC_KINDS.indexOf(type.kind) });
  });

  const neighbours: Record<string, number[]> = {};
  const scores = new Float32Array(rows.length);
  for (let a = 0; a < rows.length; a++) {
    if (a % 4 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      opts.signal?.throwIfAborted();
    }
    const oa = rows[a]!.row * dims;
    for (let b = 0; b < rows.length; b++) {
      const ob = rows[b]!.row * dims;
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let d = 0; d < dims; d += 4) {
        s0 += v[oa + d]! * v[ob + d]!; s1 += v[oa + d + 1]! * v[ob + d + 1]!;
        s2 += v[oa + d + 2]! * v[ob + d + 2]!; s3 += v[oa + d + 3]! * v[ob + d + 3]!;
      }
      scores[b] = s0 + s1 + s2 + s3;
    }
    // Per kind, keep the best `perType` (ties broken by Omeka id, so builds are reproducible).
    const better = (x: number, y: number) => scores[x]! > scores[y]! || (scores[x] === scores[y] && rows[x]!.id < rows[y]!.id);
    const best = SEMANTIC_KINDS.map(() => [] as number[]);
    for (let b = 0; b < rows.length; b++) {
      if (b === a) continue;
      const list = best[rows[b]!.kind]!;
      if (list.length === perType && !better(b, list[perType - 1]!)) continue;
      let at = Math.min(list.length, perType - 1);
      list[at] = b;
      while (at > 0 && better(b, list[at - 1]!)) { list[at] = list[at - 1]!; list[--at] = b; }
    }
    const merged = best.flat().sort((x, y) => (better(x, y) ? -1 : 1));
    if (merged.length) neighbours[String(rows[a]!.id)] = merged.flatMap((b) => [rows[b]!.id, Math.round(scores[b]! * 10_000)]);
  }
  return {
    source: { repository: SEMANTIC_SOURCE.repository, tag: release.tag, model: release.manifest.model,
      model_revision: release.manifest.modelRevision, dimensions: dims, generated_at: release.manifest.generatedAt,
      vectors_sha256: release.manifest.vectorsSha256, neighbours_per_type: perType },
    low_signal: lowSignal.sort((x, y) => x - y),
    neighbours,
    ...(rows.length ? { clusters: await clusterRows(v, dims, rows, opts.clusters ?? defaultClusterCount(rows.length), opts.signal) } : {}),
  };
}

/** About a hundred records per group, between 2 and 30 groups. */
export const defaultClusterCount = (n: number): number => Math.min(n, 30, Math.max(2, Math.round(n / 100)));
const CLUSTER_SEED = 42;
const MAX_ITERATIONS = 30;

/** Deterministic PRNG (mulberry32), so a build is reproducible. */
function prng(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded spherical k-means over L2-normalised rows (cosine similarity): k-means++
 * starts, then assign / re-centre until no record moves. Groups are renumbered
 * by size (largest first) and their members ordered by closeness to the centre.
 */
async function clusterRows(v: Float32Array, dims: number, rows: { row: number; id: number }[], k: number,
  signal?: AbortSignal): Promise<NonNullable<SemanticNeighbours["clusters"]>> {
  const n = rows.length;
  k = Math.max(1, Math.min(k, n));
  const centres = new Float32Array(k * dims);
  const dot = (i: number, c: number) => {
    const o = rows[i]!.row * dims, oc = c * dims;
    let s = 0;
    for (let d = 0; d < dims; d++) s += v[o + d]! * centres[oc + d]!;
    return s;
  };
  const setCentre = (c: number, i: number) => centres.set(v.subarray(rows[i]!.row * dims, rows[i]!.row * dims + dims), c * dims);
  const pause = async () => { await new Promise((resolve) => setImmediate(resolve)); signal?.throwIfAborted(); };

  // k-means++: each next start is drawn in proportion to its squared distance from the nearest start.
  const random = prng(CLUSTER_SEED);
  setCentre(0, Math.floor(random() * n));
  const nearest = new Float64Array(n).fill(Infinity);
  for (let c = 1; c < k; c++) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.max(0, 1 - dot(i, c - 1));
      if (d * d < nearest[i]!) nearest[i] = d * d;
      total += nearest[i]!;
    }
    let pick = random() * total, chosen = n - 1;
    for (let i = 0; i < n; i++) { pick -= nearest[i]!; if (pick <= 0) { chosen = i; break; } }
    setCentre(c, chosen);
    if (c % 4 === 0) await pause();
  }

  const assign = new Int32Array(n).fill(-1);
  const closeness = new Float64Array(n);
  let iterations = 0;
  for (; iterations < MAX_ITERATIONS; iterations++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0, bestScore = -Infinity;
      for (let c = 0; c < k; c++) { const s = dot(i, c); if (s > bestScore) { bestScore = s; best = c; } }
      if (assign[i] !== best) { assign[i] = best; moved++; }
      closeness[i] = bestScore;
      if (i % 256 === 255) await pause();
    }
    if (!moved) break;
    // Re-centre: the normalised mean of each group's members.
    centres.fill(0);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const o = rows[i]!.row * dims, oc = assign[i]! * dims;
      for (let d = 0; d < dims; d++) centres[oc + d]! += v[o + d]!;
      counts[assign[i]!] = counts[assign[i]!]! + 1;
    }
    for (let c = 0; c < k; c++) {
      if (!counts[c]) {
        // An empty group restarts on the record furthest from its own centre.
        let worst = 0;
        for (let i = 1; i < n; i++) if (closeness[i]! < closeness[worst]!) worst = i;
        setCentre(c, worst);
        closeness[worst] = 1;
        continue;
      }
      let norm = 0;
      for (let d = c * dims; d < (c + 1) * dims; d++) norm += centres[d]! * centres[d]!;
      norm = Math.sqrt(norm) || 1;
      for (let d = c * dims; d < (c + 1) * dims; d++) centres[d]! /= norm;
    }
    await pause();
  }
  const groups = Array.from({ length: k }, () => [] as number[]);
  for (let i = 0; i < n; i++) groups[assign[i]!]!.push(i);
  const members = groups.filter((g) => g.length)
    .map((g) => g.sort((a, b) => closeness[b]! - closeness[a]! || rows[a]!.id - rows[b]!.id).map((i) => rows[i]!.id))
    .sort((a, b) => b.length - a.length || a[0]! - b[0]!);
  // Assignment passes run: one more than the re-centrings when it converged early.
  return { algorithm: "spherical-kmeans", seed: CLUSTER_SEED, iterations: Math.min(iterations + 1, MAX_ITERATIONS), members };
}

// --- request time ------------------------------------------------------------------

export interface SemanticRecord { kind: SemanticKind; o_id: number; title: string }

/** A record of an embedded kind, by Omeka id (optionally restricted to `kinds`). */
export function semanticRecord(store: DataStore, oId: number, kinds: readonly SemanticKind[] = SEMANTIC_KINDS): SemanticRecord | undefined {
  const lookups: Record<SemanticKind, () => { o_id: number; title?: string; name?: string } | undefined> = {
    research_item: () => store.getItem(String(oId)),
    publication: () => store.getPublication(String(oId)),
    video: () => store.getVideo(oId),
    podcast: () => store.getPodcast(oId),
    project: () => store.getProjectByOId(oId),
    section: () => store.getSectionByOId(oId),
  };
  for (const kind of kinds) {
    const rec = lookups[kind]();
    if (rec && rec.o_id === oId) return { kind, o_id: rec.o_id, title: rec.title ?? rec.name ?? String(oId) };
  }
  return undefined;
}

export interface SemanticIndex {
  source: SemanticNeighbours["source"];
  lowSignal: Set<number>;
  /** Restricted to records present in the served snapshot. */
  neighbours: Map<number, { record: SemanticRecord; score: number }[]>;
  /** The semantic map: group id (1-based) → present members, closest to the centre first. */
  groups: Map<number, SemanticRecord[]>;
  groupOf: Map<number, number>;
}

/** The stored neighbours, filtered at load to records the served snapshot holds. */
export function semanticIndex(store: DataStore): SemanticIndex | null {
  const semantic = store.semantic;
  if (!semantic) return null;
  return store.cached("semantic:index", () => {
    const neighbours = new Map<number, { record: SemanticRecord; score: number }[]>();
    for (const [key, flat] of Object.entries(semantic.neighbours)) {
      if (!semanticRecord(store, Number(key))) continue;
      const list = [];
      for (let i = 0; i < flat.length; i += 2) {
        const record = semanticRecord(store, flat[i]!);
        if (record) list.push({ record, score: flat[i + 1]! / 10_000 });
      }
      neighbours.set(Number(key), list);
    }
    const groups = new Map<number, SemanticRecord[]>();
    const groupOf = new Map<number, number>();
    (semantic.clusters?.members ?? []).forEach((ids, g) => {
      const present = ids.map((id) => semanticRecord(store, id)).filter((r): r is SemanticRecord => !!r);
      if (!present.length) return;
      groups.set(g + 1, present);
      for (const r of present) groupOf.set(r.o_id, g + 1);
    });
    return { source: semantic.source, lowSignal: new Set(semantic.low_signal), neighbours, groups, groupOf };
  });
}

/** Coverage of the served snapshot, per record kind (get_data_quality, amira://dataset). */
export function semanticCoverage(store: DataStore) {
  const index = semanticIndex(store);
  if (!index) return null;
  const totals: Record<SemanticKind, number> = { research_item: store.items.length, publication: store.publications.length,
    video: store.videos.length, podcast: store.podcasts.length, project: store.projects.length, section: store.sections.length };
  const withNeighbours = Object.fromEntries(SEMANTIC_KINDS.map((k) => [k, 0])) as Record<SemanticKind, number>;
  const lowSignal = Object.fromEntries(SEMANTIC_KINDS.map((k) => [k, 0])) as Record<SemanticKind, number>;
  for (const id of index.neighbours.keys()) withNeighbours[semanticRecord(store, id)!.kind]++;
  for (const id of index.lowSignal) { const r = semanticRecord(store, id); if (r) lowSignal[r.kind]++; }
  const notInRelease = Object.fromEntries(SEMANTIC_KINDS.map((k) => [k, totals[k] - withNeighbours[k] - lowSignal[k]]));
  return {
    release: index.source.tag, model: index.source.model, generated_at: index.source.generated_at,
    with_neighbours: withNeighbours, low_signal: lowSignal, not_in_release: notInRelease,
    semantic_map_groups: index.groups.size,
  };
}
