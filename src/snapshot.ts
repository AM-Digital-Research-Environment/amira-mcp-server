// Snapshot lifecycle: crawl the public Omeka API into typed records, write them
// to a directory (manifest LAST — a dir without a valid manifest is never
// loadable), load + validate, and the cheap freshness probe (D9/D11).
//
// Shared by the build-time fetch CLI (src/fetchCli.ts) and the runtime live
// refresh (src/data.ts), so fetch behaviour can never drift between the two.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  maxModified,
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FetchResult<T> {
  body: T;
  total: number;
}

async function fetchJSON<T>(url: string, timeoutMs = 30000): Promise<FetchResult<T>> {
  for (let attempt = 1; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as T;
      return { body, total: Number(res.headers.get("omeka-s-total-results") ?? "0") };
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${(err as Error).message}`);
      await sleep(600 * attempt * attempt);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** All pages of one items query, with bounded page concurrency. */
async function crawlItems(apiBase: string, query: string): Promise<{ items: OmekaItem[]; total: number }> {
  const first = await fetchJSON<OmekaItem[]>(`${apiBase}/items?${query}&per_page=${PER_PAGE}&page=1`);
  const total = first.total;
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const byPage: OmekaItem[][] = [first.body];
  const queue: number[] = [];
  for (let p = 2; p <= pages; p++) queue.push(p);
  let qi = 0;
  await Promise.all(
    Array.from({ length: Math.min(PAGE_CONCURRENCY, queue.length || 1) }, async () => {
      while (qi < queue.length) {
        const p = queue[qi++]!;
        await sleep(100);
        const res = await fetchJSON<OmekaItem[]>(`${apiBase}/items?${query}&per_page=${PER_PAGE}&page=${p}`);
        byPage[p - 1] = res.body;
      }
    }),
  );
  const items = byPage.flat();
  if (items.length !== total) {
    throw new Error(`crawl ${query}: fetched ${items.length} of ${total} items`);
  }
  return { items, total };
}

/** Property term -> label map (for marcrel role names). */
async function fetchPropertyLabels(apiBase: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<Record<string, unknown>[]>(`${apiBase}/properties?per_page=${PER_PAGE}&page=${p}`);
    for (const prop of body) out[String(prop["o:term"])] = String(prop["o:label"] ?? "");
    if (body.length < PER_PAGE) break;
    await sleep(100);
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
export async function crawlSnapshot(apiBase: string, log: (msg: string) => void = () => {}): Promise<CrawlOutput> {
  const labels = await fetchPropertyLabels(apiBase);
  const classTerms = new Map<number, string>();
  const ctx: TransformContext = {
    roleLabel: (term) => labels[term] ?? null,
    classTerm: (id) => (id == null ? null : (classTerms.get(id) ?? null)),
  };

  const raw = {} as Record<CorpusName, OmekaItem[]>;
  let modified: string | null = null;
  for (const corpus of CORPORA) {
    if (corpus === "item_sets") continue;
    const { items } = await crawlItems(apiBase, CORPUS_QUERIES[corpus]);
    raw[corpus] = items;
    modified = maxModified(items, modified);
    log(`crawled ${corpus}: ${items.length}`);
  }

  // Item sets (collections) live on their own endpoint.
  const itemSetsRaw: OmekaItem[] = [];
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<OmekaItem[]>(`${apiBase}/item_sets?per_page=${PER_PAGE}&page=${p}`);
    itemSetsRaw.push(...body);
    if (body.length < PER_PAGE) break;
    await sleep(100);
  }
  raw.item_sets = itemSetsRaw;
  log(`crawled item_sets: ${itemSetsRaw.length}`);

  // Resolve the publication fabio classes (a handful of ids).
  const pubClassIds = new Set<number>();
  for (const it of raw.publications) {
    const c = classId(it);
    if (c != null) pubClassIds.add(c);
  }
  for (const id of pubClassIds) {
    const { body } = await fetchJSON<Record<string, unknown>>(`${apiBase}/resource_classes/${id}`);
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

  const probe = await probeRemote(apiBase);
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    apiBase,
    maxModified: modified ?? probe.maxModified,
    totalItemsOnInstance: probe.totalItems,
    counts: Object.fromEntries(CORPORA.map((c) => [c, data[c].length])) as Record<CorpusName, number>,
  };
  return { data, manifest };
}

/** One-request freshness probe: max o:modified + unfiltered item total (D11). */
export async function probeRemote(apiBase: string): Promise<{ maxModified: string | null; totalItems: number }> {
  const { body, total } = await fetchJSON<OmekaItem[]>(
    `${apiBase}/items?sort_by=modified&sort_order=desc&per_page=1`,
  );
  return { maxModified: body[0] ? systemDate(body[0], "o:modified") : null, totalItems: total };
}

/** True when the local manifest is older than what the probe reports. */
export function isStale(local: SnapshotManifest, probe: { maxModified: string | null; totalItems: number }): boolean {
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
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")) as SnapshotManifest;
  if (manifest.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(`snapshot schema v${manifest.schemaVersion}, expected v${SNAPSHOT_SCHEMA_VERSION}`);
  }
  const data = {} as SnapshotData;
  for (const corpus of CORPORA) {
    const arr = JSON.parse(await fs.readFile(path.join(dir, `${corpus}.json`), "utf8"));
    if (!Array.isArray(arr)) throw new Error(`snapshot ${corpus}.json is not an array`);
    const expected = manifest.counts[corpus];
    if (expected != null && arr.length !== expected) {
      throw new Error(`snapshot ${corpus}: ${arr.length} records, manifest says ${expected}`);
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
export async function writeSnapshotAtomic(destDir: string, out: CrawlOutput): Promise<void> {
  const parent = path.dirname(destDir);
  const staging = path.join(parent, `.staging-${process.pid}-${Date.now()}`);
  await fs.mkdir(parent, { recursive: true });
  try {
    await writeSnapshot(staging, out);
    await loadSnapshot(staging); // self-check before promoting
    await fs.rm(destDir, { recursive: true, force: true });
    await fs.rename(staging, destDir);
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}
