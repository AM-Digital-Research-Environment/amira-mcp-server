// In-memory store over the Omeka snapshot.
//
// Two data planes, offline-first (issue #1 D2):
//   1. A snapshot BUNDLED in the .mcpb — the server is fully usable from it
//      alone, with no network access.
//   2. With live refresh on (default), a one-request probe checks the public
//      Omeka API at startup and periodically; only when stale does a full
//      re-crawl run, staged + atomically promoted into the cache (D9), then
//      hot-swapped into memory.
//
// Whichever of {bundled, cache} carries the NEWER manifest wins at startup, so
// an old cache can never shadow a fresher bundled snapshot or vice versa.

import { config } from "./config.js";
import { FULLTEXT_SOURCE, type FulltextMaps } from "./fulltextMaps.js";
import { pickSemantic, semanticManifestEntry, servableSemantic, type SemanticNeighbours } from "./semantic.js";
import {
  crawlSnapshot, isStale, KEY_NOT_ACCEPTED, loadSnapshot, probeCuratorAuth, probeRemote, writeSnapshotAtomic, type CrawlOutput,
} from "./snapshot.js";
import { LanguageIndex } from "./languages.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { fold, newFoldCaches, setFoldCacheProvider } from "./text.js";
import { stripTypedId } from "./typedIds.js";
import * as path from "node:path";
import fs from "node:fs/promises";
import { assertSnapshotSource, snapshotCacheDir } from "./snapshotIdentity.js";
import { publicView } from "./visibility.js";
import { omekaKey, redactSecrets } from "./access.js";
import type {
  ItemSetRec,
  JournalRec,
  LinkedRef,
  LocationRec,
  OrganisationRec,
  PersonRec,
  PlaylistRec,
  PodcastRec,
  ProjectRec,
  PublicationRec,
  ResearchItemRec,
  SectionRec,
  SnapshotData,
  SnapshotManifest,
  SubjectRec,
  University,
  VideoRec,
} from "./types.js";

export const UNIVERSITY_LABELS: Record<University, string> = {
  ubt: "University of Bayreuth",
  unilag: "University of Lagos",
  ujkz: "Université Joseph Ki-Zerbo",
  ufba: "Federal University of Bahia",
  external: "External collection",
};

export class DataStore {
  readonly source: "bundled" | "cache";
  readonly manifest: SnapshotManifest;

  readonly items: ResearchItemRec[];
  readonly projects: ProjectRec[];
  readonly persons: PersonRec[];
  readonly organisations: OrganisationRec[];
  readonly locations: LocationRec[];
  readonly sections: SectionRec[];
  readonly publications: PublicationRec[];
  readonly journals: JournalRec[];
  readonly podcasts: PodcastRec[];
  readonly videos: VideoRec[];
  readonly playlists: PlaylistRec[];
  readonly itemSets: ItemSetRec[];
  /** Subject authorities (empty when serving a v4 snapshot). */
  readonly subjects: SubjectRec[];
  readonly languageIndex: LanguageIndex;
  /** Folded copies of this snapshot's large texts (src/text.ts). */
  readonly folds = newFoldCaches();
  /** DRE Visualizations' ILAM full-text map products, when the snapshot carries them (src/fulltextMaps.ts). */
  readonly fulltextMaps: FulltextMaps | null;
  /** Nearest neighbours from DRE Visualizations' corpus vectors, when the snapshot carries them (src/semantic.ts). */
  readonly semantic: SemanticNeighbours | null;

  private readonly itemByDreId = new Map<string, ResearchItemRec>();
  private readonly itemByOId = new Map<number, ResearchItemRec>();
  private readonly projectByDreId = new Map<string, ProjectRec>();
  private readonly projectByOId = new Map<number, ProjectRec>();
  private readonly personByName = new Map<string, PersonRec>();
  private readonly personByOId = new Map<number, PersonRec>();
  private readonly orgByName = new Map<string, OrganisationRec>();
  private readonly orgByOId = new Map<number, OrganisationRec>();
  private readonly locationByOId = new Map<number, LocationRec>();
  private readonly locationByName = new Map<string, LocationRec>();
  private readonly sectionByName = new Map<string, SectionRec>();
  private readonly sectionByOId = new Map<number, SectionRec>();
  private readonly publicationByPubId = new Map<string, PublicationRec>();
  private readonly publicationByOId = new Map<number, PublicationRec>();
  private readonly journalByOId = new Map<number, JournalRec>();
  private readonly podcastByOId = new Map<number, PodcastRec>();
  private readonly videoByOId = new Map<number, VideoRec>();
  private readonly playlistByOId = new Map<number, PlaylistRec>();
  private readonly itemSetByOId = new Map<number, ItemSetRec>();
  private readonly itemsByProjectOId = new Map<number, ResearchItemRec[]>();
  private readonly subjectByOId = new Map<number, SubjectRec>();
  private readonly subjectByName = new Map<string, SubjectRec>();
  private readonly memo = new Map<string, unknown>();
  /** One LRU per namespace, each with its own bound. */
  private readonly lru = new Map<string, Map<string, unknown>>();
  /** Snapshot-owned, lazy derived data. Cache keys must include exposure when relevant. */
  cached<T>(key: string, build: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, build());
    return this.memo.get(key) as T;
  }
  /** Whether a `cached` entry has been built (warm-up checks, tests). */
  isBuilt(key: string): boolean {
    return this.memo.has(key);
  }
  /** Like `cached`, for per-argument data (a graph seed, a record's links):
   * keeps only the `max` most recently used entries of `namespace`. Each
   * namespace has its own bound: one shared map let a namespace with a large
   * bound keep a heavy one (graph edges) far past its own. */
  cachedRecent<T>(namespace: string, key: string, build: () => T, max = 64): T {
    let lru = this.lru.get(namespace);
    if (!lru) {
      lru = new Map();
      this.lru.set(namespace, lru);
    }
    if (lru.has(key)) {
      const value = lru.get(key) as T;
      lru.delete(key);
      lru.set(key, value);
      return value;
    }
    const value = build();
    lru.set(key, value);
    for (const oldest of lru.keys()) {
      if (lru.size <= max) break;
      lru.delete(oldest);
    }
    return value;
  }
  /** Entries currently held by one `cachedRecent` namespace (tests, metrics). */
  recentSize(namespace: string): number {
    return this.lru.get(namespace)?.size ?? 0;
  }

  constructor(source: "bundled" | "cache", data: SnapshotData, manifest: SnapshotManifest, fulltextMaps: FulltextMaps | null = null,
    semantic: SemanticNeighbours | null = null) {
    this.source = source;
    this.manifest = manifest;
    this.fulltextMaps = fulltextMaps;
    this.semantic = semantic;
    this.items = data.research_items;
    this.projects = data.projects;
    this.persons = data.persons;
    this.organisations = data.organisations;
    this.locations = data.locations;
    this.sections = data.research_sections;
    this.publications = data.publications;
    this.journals = data.journals;
    this.podcasts = data.podcasts;
    this.videos = data.videos;
    this.playlists = data.playlists;
    this.itemSets = data.item_sets;
    this.subjects = data.subjects ?? [];
    this.languageIndex = new LanguageIndex(data.languages);

    // Every by-name map is keyed on the FOLDED name (src/text.ts), so a lookup
    // for "Côte d'Ivoire" reaches a record stored as "Cote d'Ivoire".
    for (const it of this.items) {
      this.itemByDreId.set(fold(it.dre_id), it);
      this.itemByOId.set(it.o_id, it);
      const pid = it.project?.o_id;
      if (pid != null) {
        const list = this.itemsByProjectOId.get(pid);
        if (list) list.push(it);
        else this.itemsByProjectOId.set(pid, [it]);
      }
    }
    for (const p of this.projects) {
      this.projectByDreId.set(fold(p.dre_id), p);
      this.projectByOId.set(p.o_id, p);
    }
    for (const p of this.persons) {
      this.personByName.set(fold(p.name), p);
      this.personByOId.set(p.o_id, p);
    }
    for (const o of this.organisations) {
      this.orgByName.set(fold(o.name), o);
      this.orgByOId.set(o.o_id, o);
    }
    // Acronyms and variants ("UJKZ") resolve too, without shadowing a real name.
    for (const o of this.organisations) {
      for (const alt of o.alt_names ?? []) if (!this.orgByName.has(fold(alt))) this.orgByName.set(fold(alt), o);
    }
    for (const s of this.subjects) {
      this.subjectByOId.set(s.o_id, s);
      if (!this.subjectByName.has(fold(s.name))) this.subjectByName.set(fold(s.name), s);
    }
    for (const l of this.locations) {
      this.locationByOId.set(l.o_id, l);
      this.locationByName.set(fold(l.name), l);
    }
    for (const s of this.sections) {
      this.sectionByName.set(fold(s.name), s);
      this.sectionByOId.set(s.o_id, s);
    }
    for (const p of this.publications) {
      this.publicationByPubId.set(fold(p.pub_id), p);
      for (const id of p.identifiers ?? []) this.publicationByPubId.set(fold(id), p);
      this.publicationByOId.set(p.o_id, p);
    }
    for (const j of this.journals) this.journalByOId.set(j.o_id, j);
    for (const p of this.podcasts) this.podcastByOId.set(p.o_id, p);
    for (const v of this.videos) this.videoByOId.set(v.o_id, v);
    for (const p of this.playlists) this.playlistByOId.set(p.o_id, p);
    for (const s of this.itemSets) this.itemSetByOId.set(s.o_id, s);
  }

  getItem(key: string): ResearchItemRec | undefined {
    const k = fold(key.trim());
    const byDre = this.itemByDreId.get(k);
    if (byDre) return byDre;
    const asOId = Number(k);
    return Number.isInteger(asOId) ? this.itemByOId.get(asOId) : undefined;
  }
  getProject(dreIdOrOId: string): ProjectRec | undefined {
    const k = fold(dreIdOrOId.trim());
    return this.projectByDreId.get(k) ?? (Number.isInteger(Number(k)) ? this.projectByOId.get(Number(k)) : undefined);
  }
  getProjectByOId(oId: number): ProjectRec | undefined {
    return this.projectByOId.get(oId);
  }
  projectOf(item: ResearchItemRec): ProjectRec | undefined {
    return item.project?.o_id != null ? this.projectByOId.get(item.project.o_id) : undefined;
  }
  getPersonByName(name: string): PersonRec | undefined {
    return this.personByName.get(fold(name.trim()));
  }
  getPersonByOId(oId: number): PersonRec | undefined {
    return this.personByOId.get(oId);
  }
  getOrganisation(name: string): OrganisationRec | undefined {
    return this.orgByOId.get(Number(name)) ?? this.orgByName.get(fold(name.trim()));
  }
  getOrganisationByOId(oId: number): OrganisationRec | undefined {
    return this.orgByOId.get(oId);
  }
  /** Subject authority by id or exact (folded) heading. */
  getSubject(key: number | string): SubjectRec | undefined {
    return typeof key === "number" ? this.subjectByOId.get(key) : this.subjectByName.get(fold(key.trim()));
  }
  getSection(name: string): SectionRec | undefined {
    return this.sectionByName.get(fold(name.trim()));
  }
  getSectionByOId(oId: number): SectionRec | undefined {
    return this.sectionByOId.get(oId);
  }
  /** A section by exact (folded) name, Omeka id or typed id (`section:218`). */
  resolveSection(nameOrId: string): SectionRec | undefined {
    const byName = this.getSection(nameOrId);
    if (byName) return byName;
    const id = Number(stripTypedId(nameOrId, ["section"]));
    return Number.isSafeInteger(id) ? this.sectionByOId.get(id) : undefined;
  }
  getPublication(pubIdOrOId: string): PublicationRec | undefined {
    const k = fold(pubIdOrOId.trim());
    const byPubId = this.publicationByPubId.get(k);
    if (byPubId) return byPubId;
    const asOId = Number(k);
    return Number.isInteger(asOId) ? this.publicationByOId.get(asOId) : undefined;
  }
  getJournal(oId: number): JournalRec | undefined {
    return this.journalByOId.get(oId);
  }
  getPodcast(oId: number): PodcastRec | undefined {
    return this.podcastByOId.get(oId);
  }
  getVideo(oId: number): VideoRec | undefined {
    return this.videoByOId.get(oId);
  }
  getPlaylist(oId: number): PlaylistRec | undefined {
    return this.playlistByOId.get(oId);
  }
  itemsForProject(projectOId: number): ResearchItemRec[] {
    return this.itemsByProjectOId.get(projectOId) ?? [];
  }
  /** Section names of the item's parent project. */
  sectionsOfItem(item: ResearchItemRec): string[] {
    return this.sectionRefsOfItem(item).map((s) => s.label);
  }
  /** Section references (with ids) of the item's parent project. */
  sectionRefsOfItem(item: ResearchItemRec): LinkedRef[] {
    return this.projectOf(item)?.sections ?? [];
  }
  /** Projects linked to a section — by id, falling back to the label for unlinked refs. */
  projectsOfSection(section: SectionRec): ProjectRec[] {
    return this.cached(`section-projects:${section.o_id}`, () => this.projects.filter((p) =>
      p.sections.some((x) => x.o_id != null ? x.o_id === section.o_id : fold(x.label) === fold(section.name))));
  }

  /** Ancestor authority references (region, country, …), nearest first. */
  locationAncestorRefs(oId: number | null): LinkedRef[] {
    return this.cached(`ancestors:${oId}`, () => {
      const out: LinkedRef[] = [];
      const seen = new Set<number>(oId == null ? [] : [oId]);
      let cur = oId != null ? this.locationByOId.get(oId) : undefined;
      while (cur?.parent?.o_id != null && !seen.has(cur.parent.o_id) && out.length < 6) {
        seen.add(cur.parent.o_id);
        const parent = this.locationByOId.get(cur.parent.o_id);
        out.push({ label: parent?.name ?? cur.parent.label, o_id: cur.parent.o_id });
        cur = parent;
      }
      return out;
    });
  }
  locationAncestors(oId: number | null): string[] {
    return this.locationAncestorRefs(oId).map((ref) => ref.label);
  }
  placeChainRefs(ref: LinkedRef): LinkedRef[] {
    return [ref, ...this.locationAncestorRefs(ref.o_id)];
  }
  /** A place ref + all its ancestors (self first) — for location matching. */
  placeChain(ref: LinkedRef): string[] {
    return [ref.label, ...this.locationAncestors(ref.o_id)];
  }
  /** The COUNTRY a place belongs to: the root of its ancestor chain (cities sit
   * directly under countries in this data; a country is its own root). */
  countryOf(ref: LinkedRef): string {
    const chain = this.placeChain(ref);
    return chain[chain.length - 1]!;
  }
  getLocation(oId: number): LocationRec | undefined {
    return this.locationByOId.get(oId);
  }
  getLocationByName(name: string): LocationRec | undefined {
    return this.locationByName.get(fold(name.trim()));
  }
  getItemSet(oId: number): ItemSetRec | undefined {
    return this.itemSetByOId.get(oId);
  }
}

// -----------------------------------------------------------------------------
// Singleton + background refresh
// -----------------------------------------------------------------------------

let current: DataStore | null = null;

/** Builds a store's derived indexes before it serves (src/warm.ts, wired in
 * src/mcpServer.ts: importing it here would close an import cycle). */
let warmup: ((store: DataStore, signal?: AbortSignal) => Promise<void>) | null = null;
export function setStoreWarmup(fn: (store: DataStore, signal?: AbortSignal) => Promise<void>): void {
  warmup = fn;
}

/** The store a tool call is serving, for the length of the call (src/tools/policy.ts). */
const storeScope = new AsyncLocalStorage<DataStore>();
/** Run `fn` against `store`: its fold caches, even after a refresh swaps `current`. */
export function withStore<T>(store: DataStore, fn: () => T): T {
  return storeScope.run(store, fn);
}
setFoldCacheProvider(() => (storeScope.getStore() ?? current)?.folds);
let loading: Promise<DataStore> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshController: AbortController | null = null;
let stopped = false;
const refreshState = { last_attempt: null as string | null, last_success: null as string | null,
  error_class: null as string | null, in_flight: false };
export function refreshStatus() {
  return {
    ...refreshState,
    enabled: config.liveRefresh,
    ...(config.access === "curator"
      ? { data_verified_at: curator.verifiedAt ? new Date(curator.verifiedAt).toISOString() : null, blocked: curator.blocked }
      : {}),
  };
}
export async function stopBackgroundRefresh(): Promise<void> {
  stopped = true;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (curator.retryTimer) clearTimeout(curator.retryTimer);
  curator.retryTimer = null;
  refreshController?.abort();
  await refreshInFlight;
}

export function cacheSnapshotDir(): string {
  return snapshotCacheDir(config.cacheDir, config.apiBase, config.access);
}

// --- curator mode (#26) ---------------------------------------------------------
//
// Curator data is served only while it is known to be current and the service
// key is accepted:
//   - it never comes from the bundled snapshot, only from the curator cache
//     partition (AMIRA_CACHE_DIR, on tmpfs) or a fresh authenticated crawl;
//   - `verifiedAt` records when Omeka last confirmed it (a crawl, or a probe
//     that found nothing newer). Past AMIRA_CURATOR_MAX_STALE_HOURS without a
//     confirmation (Omeka unreachable), requests are refused until a refresh
//     succeeds;
//   - when Omeka answers 401/403 to the key, the store is dropped, the cache
//     wiped, and requests are refused until a later refresh succeeds.
const curator = {
  verifiedAt: 0,
  blocked: false,
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  /** Initial-load throttle: a failed crawl is not retried by every request. */
  nextAttempt: 0,
  lastError: null as Error | null,
};
/** After a 401/403 or a failed first crawl, retry this soon (capped by the refresh interval). */
const CURATOR_RETRY_MS = 5 * 60_000;
const INITIAL_RETRY_MS = 60_000;

const maxStaleMs = (): number => config.curatorMaxStaleHours * 3_600_000;
const curatorStale = (): boolean => config.access === "curator" && Date.now() - curator.verifiedAt > maxStaleMs();

function curatorUnavailable(): Error {
  return new Error(curator.blocked
    ? `Curator data unavailable: ${KEY_NOT_ACCEPTED}. Private data was dropped; requests are refused until a refresh succeeds.`
    : `Curator data unavailable: not verified against Omeka for more than ${config.curatorMaxStaleHours} h. ` +
      "Requests are refused until a refresh succeeds.");
}

/** The key was refused (401/403) or silently ignored (the authentication probe
 * found nothing private): drop the store, wipe the cache, refuse until a refresh succeeds. */
async function revokeCuratorData(status: number | undefined): Promise<void> {
  current = null;
  curator.blocked = true;
  curator.verifiedAt = 0;
  await fs.rm(cacheSnapshotDir(), { recursive: true, force: true })
    .catch((err: Error) => console.error(`[amira] curator cache could not be wiped: ${err.message}`));
  console.error(`[amira] ${status ? `Omeka answered HTTP ${status} to the curator key` : KEY_NOT_ACCEPTED}: dropped the in-memory ` +
    "snapshot and wiped the curator cache; refusing requests until a refresh succeeds");
  scheduleCuratorRetry();
}

function scheduleCuratorRetry(): void {
  if (stopped || !config.liveRefresh || curator.retryTimer) return;
  const interval = config.refreshIntervalHours > 0 ? config.refreshIntervalHours * 3_600_000 : CURATOR_RETRY_MS;
  curator.retryTimer = setTimeout(() => {
    curator.retryTimer = null;
    triggerBackgroundRefresh();
  }, Math.min(CURATOR_RETRY_MS, interval));
  curator.retryTimer.unref?.();
}

/** Crawl with the key and publish to the curator cache; the published snapshot. */
async function curatorCrawl(signal?: AbortSignal): Promise<CrawlOutput> {
  omekaKey(); // throws (naming only the variable) when the key file is missing or malformed
  const out = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`), signal,
    { semanticRelease: config.semanticRelease, access: "curator" });
  const published = (await writeSnapshotAtomic(cacheSnapshotDir(), out, signal)) ?? await loadSnapshot(cacheSnapshotDir());
  assertSnapshotSource(published.manifest, config.apiBase, "curator");
  return published;
}

interface Loaded { source: "bundled" | "cache"; out: CrawlOutput }

async function tryLoad(dir: string, source: "bundled" | "cache"): Promise<Loaded | null> {
  try {
    const out = await loadSnapshot(dir);
    assertSnapshotSource(out.manifest, config.apiBase, config.access);
    return { source, out: config.access === "public" ? publicOnly(out, source) : out };
  } catch (err) {
    if (source === "bundled" || config.access === "curator") {
      console.error(`[amira] ${source === "bundled" ? "bundled" : "cached"} snapshot unusable: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Public mode, defence in depth: drop private records and values a public-labelled snapshot should never hold. */
function publicOnly(out: CrawlOutput, source: string): CrawlOutput {
  const { data, dropped } = publicView(out.data);
  if (data === out.data) return out;
  console.error(`[amira] public mode: removed ${dropped} private record(s) and every private value from the ${source} snapshot`);
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length])) as SnapshotManifest["counts"];
  return { ...out, data, manifest: { ...out.manifest, counts } };
}

/**
 * A store over `loaded`, serving `semantic` (already checked against the
 * setting). The manifest entry is rewritten to match what is served, since the
 * snapshot id names the semantic space.
 */
function storeOf(source: "bundled" | "cache", loaded: CrawlOutput, semantic: SemanticNeighbours | null): DataStore {
  const { semanticNeighbours: _stored, ...manifest } = loaded.manifest;
  return new DataStore(source, loaded.data, semantic ? { ...manifest, semanticNeighbours: semanticManifestEntry(semantic) } : manifest,
    loaded.fulltext, semantic);
}

/**
 * Pick the snapshot to serve at startup: the newest manifest, ties to the cache
 * (it descends from a refresh). Its neighbours come from whichever candidate
 * offers the best servable set: a cache written by a server older than 1.33.0,
 * or while GitHub was unreachable, carries none, and being newer it used to hide
 * the bundled neighbours until the next upstream change.
 */
export function chooseInitial(cache: Loaded | null, bundled: Loaded | null, semanticSetting: string): DataStore | null {
  const winner = cache && bundled ? (cache.out.manifest.fetchedAt >= bundled.out.manifest.fetchedAt ? cache : bundled) : cache ?? bundled;
  if (!winner) return null;
  const other = winner === cache ? bundled : cache;
  const semantic = pickSemantic([servableSemantic(winner.out.semantic, semanticSetting), servableSemantic(other?.out.semantic, semanticSetting)]);
  if (semantic && semantic !== winner.out.semantic) {
    console.error(`[amira] serving semantic neighbours ${semantic.source.tag} from the ${other!.source} snapshot`);
  }
  return storeOf(winner.source, winner.out, semantic);
}

/** Curator mode: the cached curator snapshot when recent enough, otherwise a fresh authenticated crawl. */
async function loadInitialCurator(): Promise<DataStore> {
  if (curator.blocked) throw curatorUnavailable();
  if (Date.now() < curator.nextAttempt && curator.lastError) throw curator.lastError;
  try {
    omekaKey();
    const cached = await tryLoad(cacheSnapshotDir(), "cache");
    const fetched = cached ? Date.parse(cached.out.manifest.fetchedAt) : NaN;
    if (cached && Date.now() - fetched <= maxStaleMs()) {
      // Past the refresh interval, confirm the key before trusting the cache.
      // A refused key drops it; an unreachable Omeka is a transient failure,
      // and the cache serves within the staleness limit.
      if (Date.now() - fetched > config.refreshIntervalHours * 3_600_000) {
        await probeCuratorAuth(config.apiBase).catch((err: Error & { omekaAuth?: boolean }) => {
          if (err.omekaAuth) throw err;
          console.error(`[amira] curator authentication probe skipped: ${redactSecrets(err.message)}`);
        });
      }
      curator.verifiedAt = fetched;
      return chooseInitial(cached, null, config.semanticRelease)!;
    }
    if (cached) console.error(`[amira] curator cache older than ${config.curatorMaxStaleHours} h; crawling afresh`);
    if (!config.liveRefresh) throw new Error("no curator snapshot recent enough to serve, and live refresh is off");
    console.error("[amira] curator mode: crawling the Omeka API with the service key");
    const published = await curatorCrawl();
    curator.verifiedAt = Date.now();
    curator.lastError = null;
    return storeOf("cache", published, servableSemantic(published.semantic, config.semanticRelease));
  } catch (err) {
    const safe = new Error(`curator snapshot unavailable: ${redactSecrets((err as Error).message)}`);
    curator.lastError = safe;
    curator.nextAttempt = Date.now() + INITIAL_RETRY_MS;
    if ((err as { omekaAuth?: boolean }).omekaAuth) await revokeCuratorData((err as { status?: number }).status);
    throw safe;
  }
}

async function loadInitial(): Promise<DataStore> {
  if (config.access === "curator") return loadInitialCurator();
  const [partitioned, bundled, legacy] = await Promise.all([
    tryLoad(cacheSnapshotDir(), "cache"),
    tryLoad(config.bundledDataDir, "bundled"),
    tryLoad(path.join(config.cacheDir, "current"), "cache"),
  ]);
  const store = chooseInitial(partitioned ?? legacy, bundled, config.semanticRelease);
  if (!store) throw new Error("no usable data snapshot (bundled data missing or corrupt)");
  return store;
}

export async function ensureStore(): Promise<DataStore> {
  if (current) {
    if (curatorStale()) throw curatorUnavailable();
    return current;
  }
  if (config.access === "curator" && curator.blocked) throw curatorUnavailable();
  if (!loading) {
    loading = loadInitial()
      .then((store) => {
        current = store;
        // In the background: a request arriving first builds what it needs itself.
        void warmup?.(store).catch((err: Error) => console.error(`[amira] index warm-up failed: ${err.message}`));
        if (config.liveRefresh) startBackgroundRefresh();
        return store;
      })
      // Do NOT cache the rejection: a transient failure (a half-written cache
      // dir, a momentary EBUSY) used to be latched forever, because every later
      // caller awaited the same rejected promise and the HTTP surface pinned
      // /healthz at 503 with no path back. Clear it so the next call retries.
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/** The store currently being served, or null before the first load resolves.
 * Read this (not a captured reference) so callers see post-refresh swaps.
 * In curator mode, also null while the data may not be served (unverified for
 * too long, or the key refused). */
export function currentStore(): DataStore | null {
  return curatorStale() ? null : current;
}

/** Run one background refresh now and wait for it (tests; the timer runs the same). */
export async function refreshNow(): Promise<void> {
  triggerBackgroundRefresh();
  await refreshInFlight;
}

function startBackgroundRefresh(): void {
  if (stopped) return;
  triggerBackgroundRefresh();

  if (refreshTimer || config.refreshIntervalHours <= 0) return;
  const intervalMs = config.refreshIntervalHours * 60 * 60 * 1000;
  refreshTimer = setInterval(() => triggerBackgroundRefresh(), intervalMs);
  refreshTimer.unref?.();
}

function triggerBackgroundRefresh(): void {
  if (refreshInFlight || stopped) return;
  refreshController = new AbortController();
  refreshState.in_flight = true;
  refreshInFlight = backgroundRefresh().finally(() => {
    refreshInFlight = null;
    refreshController = null;
    refreshState.in_flight = false;
  });
}

/**
 * Probe the live API; on staleness, re-crawl into the cache (staged + atomic)
 * and hot-swap the in-memory store. Every failure is non-fatal — the loaded
 * snapshot keeps serving.
 */
async function backgroundRefresh(): Promise<void> {
  const curatorMode = config.access === "curator";
  try {
    const local = current?.manifest;
    // Curator mode without a store (the key was refused, or the first crawl
    // failed) crawls afresh; public mode always has a store to compare with.
    if (!local && !curatorMode) return;
    refreshState.last_attempt = new Date().toISOString();
    const signal = AbortSignal.any([refreshController!.signal, AbortSignal.timeout(15 * 60_000)]);
    if (local) {
      // Every curator refresh first proves the key still works: a key revoked
      // mid-life returns anonymous data, which the freshness probe alone would miss.
      if (curatorMode) await probeCuratorAuth(config.apiBase, signal);
      const probe = await probeRemote(config.apiBase, signal);
      const forced = Date.now() - Date.parse(local.fetchedAt) >= config.fullRefreshHours * 3_600_000;
      if (!isStale(local, probe) && !forced) {
        if (curatorMode) curator.verifiedAt = Date.now();
        refreshState.last_success = new Date().toISOString(); refreshState.error_class = null; return;
      }
      console.error(`[amira] snapshot stale (local ${local.maxModified ?? "?"} < remote ${probe.maxModified ?? "?"}); refreshing…`);
    }

    let published: CrawlOutput;
    if (curatorMode) {
      published = await curatorCrawl(signal);
    } else {
      const out: CrawlOutput = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`), signal,
        { semanticRelease: config.semanticRelease });
      signal.throwIfAborted();
      // The pinned full-text files never change: when GitHub was unreachable, keep the ones already served.
      if (!out.fulltext && current?.fulltextMaps?.source.tag === FULLTEXT_SOURCE.tag) out.fulltext = current.fulltextMaps;
      // No verified release this time: keep the neighbours already served (filtered to the new snapshot at load).
      // `current.semantic` already satisfies the setting, so a pinned build is never replaced by another.
      if (!out.semantic && current?.semantic) out.semantic = current.semantic;
      // The writer returns what it verified; only when another process published
      // a newer generation first is the served snapshot read back from disk.
      published = (await writeSnapshotAtomic(cacheSnapshotDir(), out, signal)) ?? await loadSnapshot(cacheSnapshotDir());
      assertSnapshotSource(published.manifest, config.apiBase, config.access);
      published = publicOnly(published, "refreshed");
    }
    signal.throwIfAborted();
    // Another process may have published first, under another setting or version.
    const next = storeOf("cache", published, servableSemantic(published.semantic, config.semanticRelease));
    // Built before the swap, so no request on the new snapshot pays for an index.
    await warmup?.(next, signal);
    signal.throwIfAborted();
    current = next;
    if (curatorMode) {
      curator.verifiedAt = Date.now();
      curator.blocked = false;
      curator.lastError = null;
      if (!refreshTimer && config.liveRefresh) startBackgroundRefresh();
    }
    refreshState.last_success = new Date().toISOString();
    refreshState.error_class = null;
    console.error(`[amira] refreshed snapshot (fetchedAt=${published.manifest.fetchedAt}, ${published.data.research_items.length} research items)`);
  } catch (err) {
    const auth = curatorMode && (err as { omekaAuth?: boolean }).omekaAuth;
    refreshState.error_class = auth ? "omeka_auth_refused" : (err as Error).name === "AbortError" ? "cancelled"
      : (err as Error).name === "TimeoutError" ? "timeout" : "refresh_failed";
    console.error(`[amira] live refresh skipped: ${redactSecrets((err as Error).message)}`);
    if (auth) await revokeCuratorData((err as { status?: number }).status);
    else if (curatorMode && !current) scheduleCuratorRetry();
  }
}
