// Snapshot disk layout: write a snapshot (manifest LAST — a dir without a
// valid manifest is never loadable), load + validate it, per-record
// fingerprints, and the atomic publish of immutable generations behind a
// pointer file.

import fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fulltextManifestEntry, parseFulltextMaps, type FulltextMaps } from "../fulltextMaps.js";
import { parseSemanticNeighbours, semanticManifestEntry, type SemanticNeighbours } from "../semantic.js";
import {
  CORPORA,
  MIN_SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  V5_CORPORA,
  type CorpusName,
  type SnapshotData,
  type SnapshotManifest,
} from "../types.js";
import type { CrawlOutput } from "./crawl.js";
import { sleep } from "./http.js";

/** File holding the validated full-text map products inside a snapshot directory. */
const FULLTEXT_FILE = "fulltext_maps.json";

/** File holding the precomputed semantic neighbours inside a snapshot directory. */
const SEMANTIC_FILE = "semantic_neighbours.json";

/** Per-record fingerprints inside a snapshot directory (get_snapshot_changes). */
const FINGERPRINT_FILE = "fingerprints.json";

/**
 * One fingerprint per record, per corpus: a short content hash, the title to
 * report, and for an item set the project it is cited by (#18). Diffing two
 * snapshots compares these, so get_snapshot_changes never holds a retained
 * snapshot's records (with their full texts and transcripts) in memory.
 */
export type Fingerprint = [hash: string, title: string, citedBy?: number];
export type Fingerprints = Partial<Record<CorpusName, Record<string, Fingerprint>>>;

export function snapshotFingerprints(data: SnapshotData): Fingerprints {
  const out: Fingerprints = {};
  for (const corpus of CORPORA) {
    const rows: Record<string, Fingerprint> = {};
    for (const rec of (data[corpus] ?? []) as { o_id: number; title?: string; name?: string; project?: { o_id: number | null } | null }[]) {
      const hash = createHash("sha1").update(JSON.stringify(rec)).digest("base64url").slice(0, 16);
      const citedBy = corpus === "item_sets" ? rec.project?.o_id ?? undefined : undefined;
      rows[String(rec.o_id)] = citedBy != null ? [hash, rec.title ?? rec.name ?? "", citedBy] : [hash, rec.title ?? rec.name ?? ""];
    }
    out[corpus] = rows;
  }
  return out;
}

/** A snapshot dir's fingerprints (following the pointer), or null for one written before 1.35. */
export async function readFingerprints(dir: string): Promise<Fingerprints | null> {
  const active = await readSnapshotPointer(dir);
  if (active) return readFingerprints(path.join(dir, "generations", active.current));
  try {
    return JSON.parse(await fs.readFile(path.join(dir, FINGERPRINT_FILE), "utf8")) as Fingerprints;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Write a snapshot. Data files first, manifest.json LAST (validity marker). */
export async function writeSnapshot(dir: string, out: CrawlOutput): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const corpus of CORPORA) {
    await fs.writeFile(path.join(dir, `${corpus}.json`), JSON.stringify(out.data[corpus]));
  }
  // The manifest entry is derived from the files actually written, never trusted from the caller.
  const { fulltextMaps: _stale, semanticNeighbours: _staleSemantic, ...manifest } = out.manifest;
  if (out.fulltext) await fs.writeFile(path.join(dir, FULLTEXT_FILE), JSON.stringify(out.fulltext));
  if (out.semantic) await fs.writeFile(path.join(dir, SEMANTIC_FILE), JSON.stringify(out.semantic));
  await fs.writeFile(path.join(dir, FINGERPRINT_FILE), JSON.stringify(snapshotFingerprints(out.data)));
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify({
    ...manifest,
    ...(out.fulltext ? { fulltextMaps: fulltextManifestEntry(out.fulltext) } : {}),
    ...(out.semantic ? { semanticNeighbours: semanticManifestEntry(out.semantic) } : {}),
  }, null, 2));
}

/** The manifest a snapshot dir serves (following the generation pointer),
 * without parsing any corpus: what a writer needs to order two snapshots. */
export async function readManifest(dir: string): Promise<SnapshotManifest> {
  const active = await readSnapshotPointer(dir);
  if (active) return readManifest(path.join(dir, "generations", active.current));
  return JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
}

/** Load + validate a snapshot dir. Throws on schema/count mismatch. */
export async function loadSnapshot(dir: string, opts: { strict?: boolean } = {}): Promise<CrawlOutput> {
  const active = await readSnapshotPointer(dir);
  if (active) return loadSnapshot(path.join(dir, "generations", active.current), opts);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  if (!(manifest.schemaVersion >= MIN_SNAPSHOT_SCHEMA_VERSION && manifest.schemaVersion <= SNAPSHOT_SCHEMA_VERSION)) {
    throw new Error(`snapshot schema v${manifest.schemaVersion}, expected v${MIN_SNAPSHOT_SCHEMA_VERSION}–v${SNAPSHOT_SCHEMA_VERSION}`);
  }
  const data = {} as SnapshotData;
  for (const corpus of CORPORA) {
    // A v4 snapshot predates these corpora; serve them empty.
    if (manifest.schemaVersion < 5 && V5_CORPORA.includes(corpus) && manifest.counts?.[corpus] === undefined) {
      (data as unknown as Record<string, unknown[]>)[corpus] = [];
      continue;
    }
    const arr = JSON.parse(await fs.readFile(path.join(dir, `${corpus}.json`), "utf8"));
    if (!Array.isArray(arr)) throw new Error(`snapshot ${corpus}.json is not an array`);
    const expected = manifest.counts?.[corpus];
    if (!Number.isSafeInteger(expected) || expected < 0 || arr.length !== expected) {
      throw new Error(`snapshot ${corpus}: ${arr.length} records, manifest says ${expected}`);
    }
    if (arr.some((record) => !Number.isSafeInteger(record?.o_id) || record.o_id <= 0) ||
        new Set(arr.map((record) => record.o_id)).size !== arr.length) {
      throw new Error(`snapshot ${corpus}: invalid or duplicate Omeka ids`);
    }
    (data as unknown as Record<string, unknown[]>)[corpus] = arr;
  }
  let fulltext: FulltextMaps | null = null;
  if (manifest.fulltextMaps) {
    fulltext = parseFulltextMaps(JSON.parse(await fs.readFile(path.join(dir, FULLTEXT_FILE), "utf8")));
    const entry = fulltextManifestEntry(fulltext);
    if (entry.tag !== manifest.fulltextMaps.tag || entry.articles !== manifest.fulltextMaps.articles) {
      throw new Error(`snapshot ${FULLTEXT_FILE}: ${entry.tag} with ${entry.articles} articles, manifest says ${manifest.fulltextMaps.tag} with ${manifest.fulltextMaps.articles}`);
    }
  }
  let semantic: SemanticNeighbours | null = null;
  if (manifest.semanticNeighbours) {
    try {
      semantic = parseSemanticNeighbours(JSON.parse(await fs.readFile(path.join(dir, SEMANTIC_FILE), "utf8")));
      const entry = semanticManifestEntry(semantic);
      if (entry.tag !== manifest.semanticNeighbours.tag || entry.sources !== manifest.semanticNeighbours.sources) {
        throw new Error(`${entry.tag} with ${entry.sources} sources, manifest says ` +
          `${manifest.semanticNeighbours.tag} with ${manifest.semanticNeighbours.sources}`);
      }
    } catch (err) {
      // The neighbours are an optional enrichment: an unreadable file (a torn
      // write, a future format) must cost the semantic tools, not the snapshot.
      // The writer verifies strictly, so a bad file is never published.
      if (opts.strict) throw new Error(`snapshot ${SEMANTIC_FILE}: ${(err as Error).message}`);
      console.error(`[amira] snapshot ${SEMANTIC_FILE} ignored: ${(err as Error).message}`);
      semantic = null;
      const { semanticNeighbours: _unread, ...rest } = manifest;
      return { data, manifest: rest, fulltext, semantic };
    }
  }
  return { data, manifest, fulltext, semantic };
}

/**
 * Atomically replace `destDir` with a freshly written snapshot: write to a
 * sibling staging dir, then swap. A crash mid-swap leaves either the old
 * snapshot or none (callers fall back to the bundled one) — never a torn mix.
 */
interface SnapshotPointer { current: string; previous: string[] }
const GENERATION = /^[a-zA-Z0-9-]+$/;
export async function readSnapshotPointer(dir: string): Promise<SnapshotPointer | null> {
  let text: string;
  try { text = await fs.readFile(path.join(dir, "active.json"), "utf8"); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  const value = JSON.parse(text) as SnapshotPointer;
  if (!GENERATION.test(value.current) || !Array.isArray(value.previous) || value.previous.some((s) => !GENERATION.test(s))) {
    throw new Error("Invalid snapshot generation pointer");
  }
  return value;
}

/** Immutable generations and an atomic pointer replacement preserve the old
 * snapshot on failure. Exclusive file creation serializes writers across processes.
 *
 * Returns the snapshot as read back from the new generation (the verification
 * load), so a caller serving it does not parse it a second time; or null when
 * a newer generation was already published and this one was not written. */
export async function writeSnapshotAtomic(destDir: string, out: CrawlOutput, signal?: AbortSignal): Promise<CrawlOutput | null> {
  signal?.throwIfAborted();
  await fs.mkdir(path.join(destDir, "generations"), { recursive: true });
  const lockPath = path.join(destDir, "writer.lock");
  let lock: Awaited<ReturnType<typeof fs.open>> | undefined;
  const deadline = Date.now() + 30_000;
  for (;;) {
    signal?.throwIfAborted();
    try { lock = await fs.open(lockPath, "wx"); break; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw err;
      // Do not guess whether another process owns an old lock: PID reuse and
      // concurrent stale-lock reclamation can otherwise admit two writers.
      // A crashed writer's lock is removed by an operator while the server is stopped.
      await sleep(50, signal);
    }
  }
  const generation = randomUUID();
  const dir = path.join(destDir, "generations", generation);
  const pointerTmp = path.join(destDir, `active-${generation}.tmp`);
  try {
    await lock.writeFile(String(process.pid));
    // Only the manifest: parsing the whole served snapshot to read one date
    // blocked a serving process's event loop for a quarter of a second.
    const existing = await readManifest(destDir).catch(() => null);
    // Crawls run outside this lock. An older crawl finishing last must not
    // replace a newer successfully published generation.
    if (existing && Date.parse(existing.fetchedAt) > Date.parse(out.manifest.fetchedAt)) return null;
    await writeSnapshot(dir, out);
    const written = await loadSnapshot(dir, { strict: true });
    let previous = await readSnapshotPointer(destDir);
    if (!previous) {
      // Preserve a pre-generation cache on the first successful publication.
      const legacy = existing ? await loadSnapshot(destDir).catch(() => null) : null;
      if (legacy) {
        const legacyId = randomUUID();
        await writeSnapshot(path.join(destDir, "generations", legacyId), legacy);
        previous = { current: legacyId, previous: [] };
      }
    }
    // Flush data before publishing the only mutable reference.
    for (const name of [...CORPORA.map((c) => `${c}.json`), ...(out.fulltext ? [FULLTEXT_FILE] : []),
      ...(out.semantic ? [SEMANTIC_FILE] : []), FINGERPRINT_FILE, "manifest.json"]) {
      const file = await fs.open(path.join(dir, name), "r+");
      try { await file.sync(); } finally { await file.close(); }
    }
    const pointer = await fs.open(pointerTmp, "wx");
    const history = previous ? [previous.current, ...previous.previous].slice(0, 2) : [];
    try { await pointer.writeFile(JSON.stringify({ current: generation, previous: history })); await pointer.sync(); }
    finally { await pointer.close(); }
    signal?.throwIfAborted();
    await fs.rename(pointerTmp, path.join(destDir, "active.json"));
    // Retain three generations and a 24h grace period for concurrent readers.
    for (const name of await fs.readdir(path.join(destDir, "generations"))) {
      if (!GENERATION.test(name) || name === generation || history.includes(name)) continue;
      const old = path.join(destDir, "generations", name);
      // Cleanup failure must not turn an already committed publish into a failure.
      await fs.stat(old).then(async (stat) => {
        if (stat.mtimeMs < Date.now() - 86_400_000) await fs.rm(old, { recursive: true, force: true });
      }).catch(() => {});
    }
    return written;
  } finally {
    await fs.unlink(pointerTmp).catch(() => {});
    await lock.close();
    await fs.unlink(lockPath);
  }
}
