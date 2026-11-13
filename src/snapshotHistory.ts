// Retained snapshot history (get_snapshot_changes): which snapshots of this
// Omeka instance are still on disk, and what changed between two of them.
//
// Only per-record fingerprints are kept (src/snapshot.ts snapshotFingerprints):
// a hash, a title and, for an item set, the project that cites it. The first
// version loaded every retained snapshot whole (with full texts and
// transcripts) and kept them in a module global for the life of the process,
// so one call could roughly quadruple resident memory on the public server.
import * as path from "node:path";
import { config } from "./config.js";
import { cacheSnapshotDir, type DataStore } from "./data.js";
import { loadSnapshot, readFingerprints, readManifest, readSnapshotPointer, snapshotFingerprints, type Fingerprints } from "./snapshot.js";
import { assertSnapshotSource, snapshotId } from "./snapshotIdentity.js";
import { CORPORA, type CorpusName, type SnapshotData } from "./types.js";
import { itemSetUrl, itemUrl } from "./urls.js";

export interface RetainedSnapshot { id: string; fetchedAt: string; prints: Fingerprints }
export interface SnapshotChange { corpus: CorpusName; id: number; change: "added" | "updated" | "deleted"; title: string; amira_url: string }

/** The served snapshot's records as SnapshotData (the store renames two corpora). */
function storeData(store: DataStore): SnapshotData {
  return { persons: store.persons, organisations: store.organisations, locations: store.locations, projects: store.projects,
    research_sections: store.sections, research_items: store.items, publications: store.publications, journals: store.journals,
    podcasts: store.podcasts, videos: store.videos, playlists: store.playlists, languages: store.languageIndex.all,
    item_sets: store.itemSets, subjects: store.subjects };
}

/** Fingerprints of one retained directory, by snapshot id: a generation never changes, so they are read once. */
const printsById = new Map<string, Fingerprints>();
let listing: { key: string; snapshots: RetainedSnapshot[] } | null = null;
const diffs = new Map<string, SnapshotChange[]>();

async function retainedAt(directory: string): Promise<RetainedSnapshot | null> {
  try {
    const manifest = await readManifest(directory);
    assertSnapshotSource(manifest, config.apiBase, config.access);
    const id = snapshotId(manifest);
    let prints = printsById.get(id);
    if (!prints) {
      // A snapshot written before fingerprints existed is parsed once, then dropped.
      prints = (await readFingerprints(directory)) ?? snapshotFingerprints((await loadSnapshot(directory)).data);
      printsById.set(id, prints);
    }
    return { id, fetchedAt: manifest.fetchedAt, prints };
  } catch {
    return null; // Missing, invalid or cross-instance snapshots cannot participate.
  }
}

/** Every retained snapshot of this instance, newest first; the served one is always among them. */
export async function retainedSnapshots(store: DataStore): Promise<RetainedSnapshot[]> {
  const dir = cacheSnapshotDir();
  const pointer = await readSnapshotPointer(dir).catch(() => null);
  const generations = pointer ? [pointer.current, ...pointer.previous] : [];
  const servedId = snapshotId(store.manifest);
  const key = JSON.stringify([config.bundledDataDir, dir, generations, servedId]);
  if (listing?.key === key) return listing.snapshots;
  const found = new Map<string, RetainedSnapshot>();
  found.set(servedId, { id: servedId, fetchedAt: store.manifest.fetchedAt,
    prints: store.cached("fingerprints", () => snapshotFingerprints(storeData(store))) });
  // Without retained generations the only other candidate is the bundled
  // snapshot, and it is the served one unless a refresh replaced it.
  const directories = [...(store.source === "cache" ? [config.bundledDataDir] : []), ...generations.map((g) => path.join(dir, "generations", g))];
  for (const directory of directories) {
    const snapshot = await retainedAt(directory);
    if (snapshot && !found.has(snapshot.id)) found.set(snapshot.id, snapshot);
  }
  const snapshots = [...found.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  // Forget fingerprints of snapshots no longer retained.
  for (const id of printsById.keys()) if (!found.has(id)) printsById.delete(id);
  listing = { key, snapshots };
  diffs.clear();
  return snapshots;
}

/** Records added, updated or deleted between two retained snapshots, ordered by corpus then id. */
export function snapshotDiff(before: RetainedSnapshot, after: RetainedSnapshot, corpora: readonly CorpusName[] = CORPORA): SnapshotChange[] {
  const key = `${before.id}:${after.id}:${corpora.join(",")}`;
  const hit = diffs.get(key);
  if (hit) return hit;
  const changes: SnapshotChange[] = [];
  for (const corpus of corpora) {
    const old = before.prints[corpus] ?? {};
    const now = after.prints[corpus] ?? {};
    const ids = [...new Set([...Object.keys(old), ...Object.keys(now)])].map(Number).sort((a, b) => a - b);
    for (const id of ids) {
      const prev = old[id], next = now[id], rec = (next ?? prev)!;
      const change = !prev ? "added" as const : !next ? "deleted" as const : prev[0] !== next[0] ? "updated" as const : null;
      if (!change) continue;
      // A collection item set is cited by its project page (#18); the set page redirects there.
      const citedBy = rec[2];
      changes.push({ corpus, id, change, title: rec[1],
        amira_url: corpus !== "item_sets" ? itemUrl(id) : citedBy != null ? itemUrl(citedBy) : itemSetUrl(id) });
    }
  }
  diffs.set(key, changes);
  if (diffs.size > 16) diffs.delete(diffs.keys().next().value!);
  return changes;
}
