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
import { crawlSnapshot, isStale, loadSnapshot, probeRemote, writeSnapshotAtomic, type CrawlOutput } from "./snapshot.js";
import { LanguageIndex } from "./languages.js";
import { clearFoldCache, fold } from "./text.js";
import * as path from "node:path";
import { assertSnapshotSource, snapshotCacheDir } from "./snapshotIdentity.js";
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
  private readonly lru = new Map<string, unknown>();
  /** Snapshot-owned, lazy derived data. Cache keys must include exposure when relevant. */
  cached<T>(key: string, build: () => T): T {
    if (!this.memo.has(key)) this.memo.set(key, build());
    return this.memo.get(key) as T;
  }
  /** Like `cached`, for per-argument data (a graph seed, a snapshot pair): keeps
   * only the `max` most recently used entries so the memo cannot grow unbounded. */
  cachedRecent<T>(key: string, build: () => T, max = 64): T {
    if (this.lru.has(key)) {
      const value = this.lru.get(key) as T;
      this.lru.delete(key);
      this.lru.set(key, value);
      return value;
    }
    const value = build();
    this.lru.set(key, value);
    if (this.lru.size > max) this.lru.delete(this.lru.keys().next().value!);
    return value;
  }

  constructor(source: "bundled" | "cache", data: SnapshotData, manifest: SnapshotManifest) {
    this.source = source;
    this.manifest = manifest;
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
let loading: Promise<DataStore> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshController: AbortController | null = null;
let stopped = false;
const refreshState = { last_attempt: null as string | null, last_success: null as string | null,
  error_class: null as string | null, in_flight: false };
export function refreshStatus() { return { ...refreshState, enabled: config.liveRefresh }; }
export async function stopBackgroundRefresh(): Promise<void> {
  stopped = true;
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  refreshController?.abort();
  await refreshInFlight;
}

export function cacheSnapshotDir(): string {
  return snapshotCacheDir(config.cacheDir, config.apiBase);
}

async function tryLoad(dir: string, source: "bundled" | "cache"): Promise<DataStore | null> {
  try {
    const { data, manifest } = await loadSnapshot(dir);
    assertSnapshotSource(manifest, config.apiBase);
    return new DataStore(source, data, manifest);
  } catch (err) {
    if (source === "bundled") {
      console.error(`[amira] bundled snapshot unusable: ${(err as Error).message}`);
    }
    return null;
  }
}

async function loadInitial(): Promise<DataStore> {
  const [partitioned, bundled, legacy] = await Promise.all([
    tryLoad(cacheSnapshotDir(), "cache"),
    tryLoad(config.bundledDataDir, "bundled"),
    tryLoad(path.join(config.cacheDir, "current"), "cache"),
  ]);
  const cache = partitioned ?? legacy;
  // Newest manifest wins; ties go to the cache (it descends from a refresh).
  if (cache && bundled) return cache.manifest.fetchedAt >= bundled.manifest.fetchedAt ? cache : bundled;
  const store = cache ?? bundled;
  if (!store) throw new Error("no usable data snapshot (bundled data missing or corrupt)");
  return store;
}

export async function ensureStore(): Promise<DataStore> {
  if (current) return current;
  if (!loading) {
    loading = loadInitial()
      .then((store) => {
        current = store;
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
 * Read this (not a captured reference) so callers see post-refresh swaps. */
export function currentStore(): DataStore | null {
  return current;
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
  try {
    const local = current?.manifest;
    if (!local) return;
    refreshState.last_attempt = new Date().toISOString();
    const signal = AbortSignal.any([refreshController!.signal, AbortSignal.timeout(15 * 60_000)]);
    const probe = await probeRemote(config.apiBase, signal);
    const forced = Date.now() - Date.parse(local.fetchedAt) >= config.fullRefreshHours * 3_600_000;
    if (!isStale(local, probe) && !forced) {
      refreshState.last_success = new Date().toISOString(); refreshState.error_class = null; return;
    }

    console.error(`[amira] snapshot stale (local ${local.maxModified ?? "?"} < remote ${probe.maxModified ?? "?"}); refreshing…`);
    const out: CrawlOutput = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`), signal);
    signal.throwIfAborted();
    await writeSnapshotAtomic(cacheSnapshotDir(), out, signal);
    const published = await loadSnapshot(cacheSnapshotDir());
    assertSnapshotSource(published.manifest, config.apiBase);
    current = new DataStore("cache", published.data, published.manifest);
    clearFoldCache(); // the folded copies belong to the snapshot just replaced
    refreshState.last_success = new Date().toISOString();
    refreshState.error_class = null;
    console.error(`[amira] refreshed snapshot (fetchedAt=${out.manifest.fetchedAt}, ${out.data.research_items.length} research items)`);
  } catch (err) {
    refreshState.error_class = (err as Error).name === "AbortError" ? "cancelled"
      : (err as Error).name === "TimeoutError" ? "timeout" : "refresh_failed";
    console.error(`[amira] live refresh skipped: ${(err as Error).message}`);
  }
}
