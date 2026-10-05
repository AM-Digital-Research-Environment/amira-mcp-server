// Snapshot lifecycle: crawl the public Omeka API into typed records, write them
// to a directory (manifest LAST — a dir without a valid manifest is never
// loadable), load + validate, and the cheap freshness probe (D9/D11).
//
// Shared by the build-time fetch CLI (src/fetchCli.ts) and the runtime live
// refresh (src/data.ts), so fetch behaviour can never drift between the two.

import fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  transformItemSet,
  transformJournal,
  transformLanguage,
  transformLocation,
  transformOrganisation,
  transformPerson,
  transformPlaylist,
  transformPodcast,
  transformProject,
  transformPublication,
  transformResearchItem,
  transformSection,
  transformVideo,
  type TransformContext,
} from "./transform.js";
import { classId, systemDate, type OmekaItem } from "./omekaJSON.js";
import {
  CORPORA,
  SNAPSHOT_SCHEMA_VERSION,
  type CorpusName,
  type ProjectRec,
  type SnapshotData,
  type SnapshotManifest,
  type University,
} from "./types.js";

const PER_PAGE = 100;
const PAGE_CONCURRENCY = 4;
const USER_AGENT = "amira-mcp-server (https://github.com/AM-Digital-Research-Environment/amira-mcp-server)";

const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });

interface FetchResult<T> {
  body: T;
  total: number;
}

export async function fetchJSON<T>(url: string, signal?: AbortSignal, timeoutMs = 30000): Promise<FetchResult<T>> {
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    let retryAfter = 0;
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) {
        const header = res.headers.get("retry-after");
        retryAfter = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
        await res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      const body = (await res.json()) as T;
      return { body, total: Number(res.headers.get("omeka-s-total-results") ?? NaN) };
    } catch (err) {
      signal?.throwIfAborted();
      const status = (err as { status?: number }).status;
      const transient = status ? [408, 429, 500, 502, 503, 504].includes(status)
        : err instanceof TypeError || (err as Error).name === "TimeoutError";
      if (!transient || attempt >= 4) throw err;
      await sleep(Math.min(30_000, Math.max(retryAfter || 0, 600 * 2 ** (attempt - 1) + Math.random() * 300)), signal);
    }
  }
}

/** All pages of one items query, with bounded page concurrency. */
async function crawlItems(apiBase: string, query: string, signal?: AbortSignal): Promise<{ items: OmekaItem[]; total: number }> {
  query += "&sort_by=id&sort_order=asc";
  const first = await fetchJSON<OmekaItem[]>(`${apiBase}/items?${query}&per_page=${PER_PAGE}&page=1`, signal);
  const total = first.total;
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`crawl ${query}: missing or invalid total-results header`);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const byPage: OmekaItem[][] = [first.body];
  const queue: number[] = [];
  for (let p = 2; p <= pages; p++) queue.push(p);
  let qi = 0;
  await Promise.all(
    Array.from({ length: Math.min(PAGE_CONCURRENCY, queue.length || 1) }, async () => {
      while (qi < queue.length) {
        const p = queue[qi++]!;
        await sleep(100, signal);
        const res = await fetchJSON<OmekaItem[]>(`${apiBase}/items?${query}&per_page=${PER_PAGE}&page=${p}`, signal);
        byPage[p - 1] = res.body;
      }
    }),
  );
  const items = byPage.flat();
  if (items.length !== total) {
    throw new Error(`crawl ${query}: fetched ${items.length} of ${total} items`);
  }
  if (new Set(items.map((item) => item["o:id"])).size !== items.length) {
    throw new Error(`crawl ${query}: duplicate item ids; the API may have changed during pagination`);
  }
  return { items, total };
}

/** Property term -> label map (for marcrel role names). */
async function fetchPropertyLabels(apiBase: string, signal?: AbortSignal): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<Record<string, unknown>[]>(`${apiBase}/properties?per_page=${PER_PAGE}&page=${p}`, signal);
    for (const prop of body) out[String(prop["o:term"])] = String(prop["o:label"] ?? "");
    if (body.length < PER_PAGE) break;
    await sleep(100, signal);
  }
  return out;
}

/** The crawl queries, per /items corpus (templates / sets verified by the
 * census). `item_sets` is special-cased: it comes from /api/item_sets. */
const CORPUS_QUERIES: Record<Exclude<CorpusName, "item_sets">, string> = {
  persons: "resource_template_id=4",
  organisations: "resource_template_id=2",
  locations: "resource_template_id=3",
  projects: "resource_template_id=5",
  research_sections: "resource_template_id=7",
  research_items: "resource_template_id=10",
  publications: "item_set_id=29918",
  journals: "resource_template_id=23",
  podcasts: "resource_template_id=21",
  videos: "resource_template_id=22",
  playlists: "item_set_id=39193",
  languages: "item_set_id=19",
};

export interface CrawlOutput {
  data: SnapshotData;
  manifest: SnapshotManifest;
}

/** Crawl everything and transform to snapshot records. Throws on ANY shortfall. */
export async function crawlSnapshot(apiBase: string, log: (msg: string) => void = () => {}, signal?: AbortSignal): Promise<CrawlOutput> {
  const before = await probeRemote(apiBase, signal);
  const labels = await fetchPropertyLabels(apiBase, signal);
  const classTerms = new Map<number, string>();
  const ctx: TransformContext = {
    roleLabel: (term) => labels[term] ?? null,
    classTerm: (id) => (id == null ? null : (classTerms.get(id) ?? null)),
  };

  const raw = {} as Record<CorpusName, OmekaItem[]>;
  for (const corpus of CORPORA) {
    if (corpus === "item_sets") continue;
    const { items } = await crawlItems(apiBase, CORPUS_QUERIES[corpus], signal);
    raw[corpus] = items;
    log(`crawled ${corpus}: ${items.length}`);
  }

  // Item sets (collections) live on their own endpoint.
  const itemSetsRaw: OmekaItem[] = [];
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<OmekaItem[]>(`${apiBase}/item_sets?sort_by=id&sort_order=asc&per_page=${PER_PAGE}&page=${p}`, signal);
    itemSetsRaw.push(...body);
    if (body.length < PER_PAGE) break;
    await sleep(100, signal);
  }
  raw.item_sets = itemSetsRaw;
  if (new Set(itemSetsRaw.map((item) => item["o:id"])).size !== itemSetsRaw.length ||
      itemSetsRaw.length !== before.totalItemSets) throw new Error("Item sets changed during the crawl");
  log(`crawled item_sets: ${itemSetsRaw.length}`);

  // Resolve the publication fabio classes (a handful of ids).
  const pubClassIds = new Set<number>();
  for (const it of raw.publications) {
    const c = classId(it);
    if (c != null) pubClassIds.add(c);
  }
  for (const id of pubClassIds) {
    const { body } = await fetchJSON<Record<string, unknown>>(`${apiBase}/resource_classes/${id}`, signal);
    classTerms.set(id, String(body["o:term"]));
  }

  // Projects before items: items derive their university from their project.
  const projects = raw.projects.map(transformProject);
  const projectByOId = new Map<number, ProjectRec>(projects.map((p) => [p.o_id, p]));
  const universityOfProject = (oId: number | null): University =>
    (oId != null ? projectByOId.get(oId)?.university : undefined) ?? "external";

  const data: SnapshotData = {
    persons: raw.persons.map(transformPerson),
    organisations: raw.organisations.map(transformOrganisation),
    locations: raw.locations.map(transformLocation),
    projects,
    research_sections: raw.research_sections.map(transformSection),
    research_items: raw.research_items.map((it) => transformResearchItem(it, ctx, universityOfProject)),
    publications: raw.publications.map((it) => transformPublication(it, ctx, classId(it))),
    journals: raw.journals.map(transformJournal),
    podcasts: raw.podcasts.map((it) => transformPodcast(it, ctx)),
    videos: raw.videos.map((it) => transformVideo(it, ctx)),
    playlists: raw.playlists.map(transformPlaylist),
    languages: raw.languages.map(transformLanguage),
    item_sets: raw.item_sets.map(transformItemSet),
  };

  const probe = await probeRemote(apiBase, signal);
  if (before.maxModified !== probe.maxModified || before.totalItems !== probe.totalItems || before.itemSetsSignature !== probe.itemSetsSignature) {
    throw new Error("Omeka items changed during the crawl; keeping the previous snapshot. Retry after the upstream sync finishes.");
  }
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    apiBase,
    // Compare like with like: the runtime probe covers ALL items, including
    // authorities outside the crawled corpora. A corpus-only max would cause
    // repeated full crawls whenever such an authority was modified last.
    maxModified: probe.maxModified,
    totalItemsOnInstance: probe.totalItems,
    itemSetsSignature: probe.itemSetsSignature,
    counts: Object.fromEntries(CORPORA.map((c) => [c, data[c].length])) as Record<CorpusName, number>,
  };
  return { data, manifest };
}

/** One-request freshness probe: max o:modified + unfiltered item total (D11). */
export interface RemoteProbe { maxModified: string | null; totalItems: number; itemSetsSignature?: string; totalItemSets?: number }
export async function probeRemote(apiBase: string, signal?: AbortSignal): Promise<RemoteProbe> {
  const { body, total } = await fetchJSON<OmekaItem[]>(
    `${apiBase}/items?sort_by=modified&sort_order=desc&per_page=1`, signal,
  );
  if (!Array.isArray(body) || !Number.isSafeInteger(total) || total < 0 || (total > 0 && !body[0])) {
    throw new Error("Omeka freshness probe returned an invalid item list or total-results header");
  }
  const sets = await fetchJSON<OmekaItem[]>(`${apiBase}/item_sets?sort_by=modified&sort_order=desc&per_page=1`, signal);
  if (!Array.isArray(sets.body) || !Number.isSafeInteger(sets.total) || sets.total < 0 || (sets.total > 0 && !sets.body[0])) {
    throw new Error("Omeka item-set freshness probe returned an invalid item list or total-results header");
  }
  return { maxModified: body[0] ? systemDate(body[0], "o:modified") : null, totalItems: total,
    totalItemSets: sets.total, itemSetsSignature: JSON.stringify([sets.total, sets.body[0] ? systemDate(sets.body[0], "o:modified") : null]) };
}

/** True when the local manifest is older than what the probe reports. */
export function isStale(local: SnapshotManifest, probe: RemoteProbe): boolean {
  if (probe.itemSetsSignature !== undefined && local.itemSetsSignature !== probe.itemSetsSignature) return true;
  if (probe.maxModified && (!local.maxModified || probe.maxModified > local.maxModified)) return true;
  if (local.totalItemsOnInstance != null && probe.totalItems !== local.totalItemsOnInstance) return true;
  return false;
}

// --- disk layout ----------------------------------------------------------------

/** Write a snapshot. Data files first, manifest.json LAST (validity marker). */
export async function writeSnapshot(dir: string, out: CrawlOutput): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const corpus of CORPORA) {
    await fs.writeFile(path.join(dir, `${corpus}.json`), JSON.stringify(out.data[corpus]));
  }
  await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(out.manifest, null, 2));
}

/** Load + validate a snapshot dir. Throws on schema/count mismatch. */
export async function loadSnapshot(dir: string): Promise<CrawlOutput> {
  const active = await readSnapshotPointer(dir);
  if (active) return loadSnapshot(path.join(dir, "generations", active.current));
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`snapshot schema v${manifest.schemaVersion}, expected v${SNAPSHOT_SCHEMA_VERSION}`);
  }
  const data = {} as SnapshotData;
  for (const corpus of CORPORA) {
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
  return { data, manifest };
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
 * snapshot on failure. Exclusive file creation serializes writers across processes. */
export async function writeSnapshotAtomic(destDir: string, out: CrawlOutput, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await fs.mkdir(path.join(destDir, "generations"), { recursive: true });
  const lockPath = path.join(destDir, "writer.lock");
  let lock;
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
    const existing = await loadSnapshot(destDir).catch(() => null);
    // Crawls run outside this lock. An older crawl finishing last must not
    // replace a newer successfully published generation.
    if (existing && Date.parse(existing.manifest.fetchedAt) > Date.parse(out.manifest.fetchedAt)) return;
    await writeSnapshot(dir, out);
    await loadSnapshot(dir);
    let previous = await readSnapshotPointer(destDir);
    if (!previous) {
      // Preserve a pre-generation cache on the first successful publication.
      const legacy = await loadSnapshot(destDir).catch(() => null);
      if (legacy) {
        const legacyId = randomUUID();
        await writeSnapshot(path.join(destDir, "generations", legacyId), legacy);
        previous = { current: legacyId, previous: [] };
      }
    }
    // Flush data before publishing the only mutable reference.
    for (const name of [...CORPORA.map((c) => `${c}.json`), "manifest.json"]) {
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
  } finally {
    await fs.unlink(pointerTmp).catch(() => {});
    await lock.close();
    await fs.unlink(lockPath);
  }
}
