// In-memory store over the Omeka snapshot (ROADMAP §2.3).
//
// Two data planes, offline-first (issue #1 D2):
//   1. A snapshot BUNDLED in the .mcpb — the server is fully usable from it
//      alone, with no network access.
//   2. With live refresh on (default), a one-request probe checks the public
//      Omeka API; only when stale does a full re-crawl run, staged + atomically
//      promoted into the cache (D9), then hot-swapped into memory.
//
// Whichever of {bundled, cache} carries the NEWER manifest wins at startup, so
// an old cache can never shadow a fresher bundled snapshot or vice versa.

import { config } from "./config.js";
import { crawlSnapshot, isStale, loadSnapshot, probeRemote, writeSnapshotAtomic, type CrawlOutput } from "./snapshot.js";
import { LanguageIndex } from "./languages.js";
import * as path from "node:path";
import type {
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
  readonly podcasts: PodcastRec[];
  readonly videos: VideoRec[];
  readonly playlists: PlaylistRec[];
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
  private readonly publicationByPubId = new Map<string, PublicationRec>();
  private readonly podcastByOId = new Map<number, PodcastRec>();
  private readonly videoByOId = new Map<number, VideoRec>();
  private readonly playlistByOId = new Map<number, PlaylistRec>();
  private readonly itemsByProjectOId = new Map<number, ResearchItemRec[]>();

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
    this.podcasts = data.podcasts;
    this.videos = data.videos;
    this.playlists = data.playlists;
    this.languageIndex = new LanguageIndex(data.languages);

    for (const it of this.items) {
      this.itemByDreId.set(it.dre_id.toLowerCase(), it);
      this.itemByOId.set(it.o_id, it);
      const pid = it.project?.o_id;
      if (pid != null) {
        const list = this.itemsByProjectOId.get(pid);
        if (list) list.push(it);
        else this.itemsByProjectOId.set(pid, [it]);
      }
    }
    for (const p of this.projects) {
      this.projectByDreId.set(p.dre_id.toLowerCase(), p);
      this.projectByOId.set(p.o_id, p);
    }
    for (const p of this.persons) {
      this.personByName.set(p.name.toLowerCase(), p);
      this.personByOId.set(p.o_id, p);
    }
    for (const o of this.organisations) {
      this.orgByName.set(o.name.toLowerCase(), o);
      this.orgByOId.set(o.o_id, o);
    }
    for (const l of this.locations) {
      this.locationByOId.set(l.o_id, l);
      this.locationByName.set(l.name.toLowerCase(), l);
    }
    for (const s of this.sections) this.sectionByName.set(s.name.toLowerCase(), s);
    for (const p of this.publications) this.publicationByPubId.set(p.pub_id.toLowerCase(), p);
    for (const p of this.podcasts) this.podcastByOId.set(p.o_id, p);
    for (const v of this.videos) this.videoByOId.set(v.o_id, v);
    for (const p of this.playlists) this.playlistByOId.set(p.o_id, p);
  }

  getItem(key: string): ResearchItemRec | undefined {
    const k = key.trim().toLowerCase();
    const byDre = this.itemByDreId.get(k);
    if (byDre) return byDre;
    const asOId = Number(k);
    return Number.isInteger(asOId) ? this.itemByOId.get(asOId) : undefined;
  }
  getProject(dreIdOrOId: string): ProjectRec | undefined {
    const k = dreIdOrOId.trim().toLowerCase();
    return this.projectByDreId.get(k) ?? (Number.isInteger(Number(k)) ? this.projectByOId.get(Number(k)) : undefined);
  }
  projectOf(item: ResearchItemRec): ProjectRec | undefined {
    return item.project?.o_id != null ? this.projectByOId.get(item.project.o_id) : undefined;
  }
  getPersonByName(name: string): PersonRec | undefined {
    return this.personByName.get(name.trim().toLowerCase());
  }
  getPersonByOId(oId: number): PersonRec | undefined {
    return this.personByOId.get(oId);
  }
  getOrganisation(name: string): OrganisationRec | undefined {
    return this.orgByName.get(name.trim().toLowerCase());
  }
  getSection(name: string): SectionRec | undefined {
    return this.sectionByName.get(name.trim().toLowerCase());
  }
  getPublication(pubIdOrOId: string): PublicationRec | undefined {
    const k = pubIdOrOId.trim().toLowerCase();
    return (
      this.publicationByPubId.get(k) ??
      this.publications.find((p) => Number.isInteger(Number(k)) && p.o_id === Number(k))
    );
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
    return this.projectOf(item)?.sections.map((s) => s.label) ?? [];
  }

  /** Ancestor labels of a place (region, country, …), nearest first. */
  locationAncestors(oId: number | null): string[] {
    const out: string[] = [];
    const seen = new Set<number>();
    let cur = oId != null ? this.locationByOId.get(oId) : undefined;
    while (cur?.parent?.o_id != null && !seen.has(cur.parent.o_id) && out.length < 6) {
      seen.add(cur.parent.o_id);
      const parent = this.locationByOId.get(cur.parent.o_id);
      out.push(parent?.name ?? cur.parent.label);
      cur = parent;
    }
    return out;
  }
  /** A place ref + all its ancestors (self first) — for location matching. */
  placeChain(ref: LinkedRef): string[] {
    return [ref.label, ...this.locationAncestors(ref.o_id)];
  }
  getLocation(oId: number): LocationRec | undefined {
    return this.locationByOId.get(oId);
  }
  getLocationByName(name: string): LocationRec | undefined {
    return this.locationByName.get(name.trim().toLowerCase());
  }
}

// -----------------------------------------------------------------------------
// Singleton + background refresh
// -----------------------------------------------------------------------------

let current: DataStore | null = null;
let loading: Promise<DataStore> | null = null;

function cacheSnapshotDir(): string {
  return path.join(config.cacheDir, "current");
}

async function tryLoad(dir: string, source: "bundled" | "cache"): Promise<DataStore | null> {
  try {
    const { data, manifest } = await loadSnapshot(dir);
    return new DataStore(source, data, manifest);
  } catch (err) {
    if (source === "bundled") {
      console.error(`[amira] bundled snapshot unusable: ${(err as Error).message}`);
    }
    return null;
  }
}

async function loadInitial(): Promise<DataStore> {
  const [cache, bundled] = await Promise.all([
    tryLoad(cacheSnapshotDir(), "cache"),
    tryLoad(config.bundledDataDir, "bundled"),
  ]);
  // Newest manifest wins; ties go to the cache (it descends from a refresh).
  if (cache && bundled) return cache.manifest.fetchedAt >= bundled.manifest.fetchedAt ? cache : bundled;
  const store = cache ?? bundled;
  if (!store) throw new Error("no usable data snapshot (bundled data missing or corrupt)");
  return store;
}

export async function ensureStore(): Promise<DataStore> {
  if (current) return current;
  if (!loading) {
    loading = loadInitial().then((store) => {
      current = store;
      if (config.liveRefresh) void backgroundRefresh();
      return store;
    });
  }
  return loading;
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
    const probe = await probeRemote(config.apiBase);
    if (!isStale(local, probe)) return;

    console.error(`[amira] snapshot stale (local ${local.maxModified ?? "?"} < remote ${probe.maxModified ?? "?"}); refreshing…`);
    const out: CrawlOutput = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`));
    await writeSnapshotAtomic(cacheSnapshotDir(), out);
    current = new DataStore("cache", out.data, out.manifest);
    console.error(`[amira] refreshed snapshot (fetchedAt=${out.manifest.fetchedAt}, ${out.data.research_items.length} research items)`);
  } catch (err) {
    console.error(`[amira] live refresh skipped: ${(err as Error).message}`);
  }
}
