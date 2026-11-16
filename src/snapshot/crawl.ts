// The Omeka crawl: every corpus, item set and media file, transformed into
// typed snapshot records inside one consistency window.

import { config } from "../config.js";
import {
  transformChronicle,
  transformItemSet,
  transformJournal,
  transformMedia,
  transformSubject,
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
} from "../transform.js";
import { classId, oid, type OmekaItem } from "../omekaJSON.js";
import { splitVisibility, withVisibility } from "../visibility.js";
import type { AccessMode } from "../snapshotIdentity.js";
import { fulltextManifestEntry, type FulltextMaps } from "../fulltextMaps.js";
import { computeNeighbours, semanticManifestEntry, type SemanticNeighbours } from "../semantic.js";
import {
  CORPORA,
  SNAPSHOT_SCHEMA_VERSION,
  type MediaRec,
  type CorpusName,
  type ProjectRec,
  type SnapshotData,
  type SnapshotManifest,
  type University,
} from "../types.js";
import { fetchFulltextMaps, fetchSemanticRelease } from "./enrichments.js";
import { fetchJSON, sleep } from "./http.js";
import { probeCuratorAuth, probeRemote } from "./probe.js";

const PER_PAGE = 100;
const PAGE_CONCURRENCY = 4;

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
  // Cluster Chronicles: the writer-in-residence works (template 34, mixed resource classes).
  chronicles: "item_set_id=50105",
  languages: "item_set_id=19",
  // Subject authorities: curated LCSH headings and free tags (template 6).
  subjects: "item_set_id=1852",
};

export interface CrawlOutput {
  data: SnapshotData;
  manifest: SnapshotManifest;
  /** Public derived files of DRE Visualizations' ILAM full-text map (src/fulltextMaps.ts); optional. */
  fulltext?: FulltextMaps | null;
  /** Nearest neighbours computed from DRE Visualizations' corpus vectors (src/semantic.ts); optional. */
  semantic?: SemanticNeighbours | null;
}

/** Crawl everything and transform to snapshot records. Throws on ANY shortfall.
 *
 * Every resource passes through `splitVisibility` first, so private values never
 * reach a public field. Public mode then drops private resources and private
 * values (the anonymous API should not have sent any); curator mode keeps them,
 * marked `visibility: "private"` and grouped under `restricted`. */
export async function crawlSnapshot(apiBase: string, log: (msg: string) => void = () => {}, signal?: AbortSignal,
  opts: { semanticRelease?: string; access?: AccessMode; fetchBase?: string } = {}): Promise<CrawlOutput> {
  const access = opts.access ?? config.access;
  // `apiBase` is the instance's public identity, recorded in the manifest;
  // requests go to `fetchBase` (AMIRA_API_BASE), which may be internal.
  const fetchBase = opts.fetchBase ?? apiBase;
  let droppedPrivate = 0;
  /** Public mode: every private resource seen, so links to one are dropped too (filled once the crawl is complete). */
  const hidden = new Set<number>();
  /** Transform the resources a mode may hold, with their visibility. */
  const visible = <T extends object>(items: OmekaItem[], transform: (it: OmekaItem) => T): T[] => {
    const out: T[] = [];
    for (const raw of items) {
      const split = splitVisibility(raw, access === "public" ? hidden : undefined);
      if (access === "public" && !split.isPublic) {
        droppedPrivate++;
        continue;
      }
      const rec = transform(split.item);
      out.push(access === "curator" ? withVisibility(rec, split.isPublic, split.restricted) : rec);
    }
    return out;
  };
  // The full-text map is an optional enrichment from another repository: a
  // failure there must never block an AMIRA refresh, so the snapshot ships without it.
  // Fetched before the first probe, so it cannot widen the Omeka consistency window.
  const fulltext = await fetchFulltextMaps(signal).catch((err: Error) => {
    signal?.throwIfAborted();
    log(`full-text map skipped: ${err.message}`);
    return null;
  });
  if (fulltext) log(`fetched full-text map ${fulltext.source.tag}: ${fulltext.map.items.length} articles`);
  // Corpus vectors, likewise optional and fetched before the first probe. A
  // release that fails verification is never used: the snapshot ships without
  // neighbours, and the callers keep the ones already served.
  const release = await fetchSemanticRelease(opts.semanticRelease ?? "latest", log, signal).catch((err: Error) => {
    signal?.throwIfAborted();
    log(`semantic neighbours skipped: ${err.message}`);
    return null;
  });
  if (release) log(`verified corpus vectors ${release.tag}: ${release.manifest.count} rows, ${release.manifest.model}`);

  // Curator mode: the key must be accepted before the crawl, and still after it
  // (a key revoked mid-crawl would otherwise mix anonymous pages in).
  if (access === "curator") await probeCuratorAuth(fetchBase, signal);
  const before = await probeRemote(fetchBase, signal);
  const labels = await fetchPropertyLabels(fetchBase, signal);
  const classTerms = new Map<number, string>();
  const ctx: TransformContext = {
    roleLabel: (term) => labels[term] ?? null,
    classTerm: (id) => (id == null ? null : (classTerms.get(id) ?? null)),
  };

  const raw = {} as Record<CorpusName, OmekaItem[]>;
  for (const corpus of CORPORA) {
    if (corpus === "item_sets") continue;
    const { items } = await crawlItems(fetchBase, CORPUS_QUERIES[corpus], signal);
    raw[corpus] = items;
    log(`crawled ${corpus}: ${items.length}`);
  }

  // Item sets (collections) live on their own endpoint.
  const itemSetsRaw: OmekaItem[] = [];
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<OmekaItem[]>(`${fetchBase}/item_sets?sort_by=id&sort_order=asc&per_page=${PER_PAGE}&page=${p}`, signal);
    itemSetsRaw.push(...body);
    if (body.length < PER_PAGE) break;
    await sleep(100, signal);
  }
  raw.item_sets = itemSetsRaw;
  if (new Set(itemSetsRaw.map((item) => item["o:id"])).size !== itemSetsRaw.length ||
      itemSetsRaw.length !== before.totalItemSets) throw new Error("Item sets changed during the crawl");
  log(`crawled item_sets: ${itemSetsRaw.length}`);

  // Media live on their own endpoint too: one paginated pass (~17 pages) gives
  // every file's MIME type and URLs, joined to its owner below. Per-item media
  // requests would cost one request per digitised item.
  const mediaByOwner = new Map<number, MediaRec[]>();
  let mediaCount = 0;
  for (let p = 1; ; p++) {
    const { body } = await fetchJSON<OmekaItem[]>(`${fetchBase}/media?sort_by=id&sort_order=asc&per_page=${PER_PAGE}&page=${p}`, signal);
    for (const raw of body) {
      const isPublic = raw["o:is_public"] !== false;
      if (access === "public" && !isPublic) {
        droppedPrivate++;
        hidden.add(oid(raw));
        continue;
      }
      const { owner, record } = transformMedia(splitVisibility(raw).item);
      if (owner == null) continue;
      if (!isPublic) record.visibility = "private";
      const list = mediaByOwner.get(owner);
      if (list) list.push(record); else mediaByOwner.set(owner, [record]);
      mediaCount++;
    }
    if (body.length < PER_PAGE) break;
    await sleep(100, signal);
  }
  log(`crawled media: ${mediaCount}`);
  const mediaOf = (oId: number): MediaRec[] => mediaByOwner.get(oId) ?? [];

  if (access === "public") {
    for (const list of Object.values(raw)) for (const it of list) if (it["o:is_public"] === false) hidden.add(oid(it));
  }

  // Resolve the publication and chronicle classes (a handful of ids).
  const pubClassIds = new Set<number>();
  for (const it of [...raw.publications, ...raw.chronicles]) {
    const c = classId(it);
    if (c != null) pubClassIds.add(c);
  }
  for (const id of pubClassIds) {
    const { body } = await fetchJSON<Record<string, unknown>>(`${fetchBase}/resource_classes/${id}`, signal);
    classTerms.set(id, String(body["o:term"]));
  }

  // Projects before items: items derive their university from their project.
  const projects = visible(raw.projects, transformProject);
  const projectByOId = new Map<number, ProjectRec>(projects.map((p) => [p.o_id, p]));
  const universityOfProject = (oId: number | null): University =>
    (oId != null ? projectByOId.get(oId)?.university : undefined) ?? "external";

  const data: SnapshotData = {
    persons: visible(raw.persons, transformPerson),
    organisations: visible(raw.organisations, transformOrganisation),
    locations: visible(raw.locations, transformLocation),
    projects,
    research_sections: visible(raw.research_sections, transformSection),
    research_items: visible(raw.research_items, (it) => ({ ...transformResearchItem(it, ctx, universityOfProject), media: mediaOf(oid(it)) })),
    publications: visible(raw.publications, (it) => ({ ...transformPublication(it, ctx, classId(it)), media: mediaOf(oid(it)) })),
    journals: visible(raw.journals, transformJournal),
    podcasts: visible(raw.podcasts, (it) => ({ ...transformPodcast(it, ctx), media: mediaOf(oid(it)) })),
    videos: visible(raw.videos, (it) => transformVideo(it, ctx)),
    playlists: visible(raw.playlists, transformPlaylist),
    languages: visible(raw.languages, transformLanguage),
    item_sets: visible(raw.item_sets, transformItemSet),
    subjects: visible(raw.subjects, transformSubject),
    chronicles: visible(raw.chronicles, (it) => ({ ...transformChronicle(it, ctx), media: mediaOf(oid(it)) })),
  };
  if (droppedPrivate) log(`public mode: dropped ${droppedPrivate} private resource(s) the API returned`);
  // Curator mode: every private item, inside the crawled corpora or not, so a
  // link to any of them is classified (src/tools/curator.ts). Inside the window.
  const privateItemIds = access === "curator"
    ? (await crawlItems(fetchBase, "is_public=0", signal)).items.map(oid).sort((a, b) => a - b) : undefined;

  const probe = await probeRemote(fetchBase, signal);
  if (access === "curator") await probeCuratorAuth(fetchBase, signal);
  if (before.maxModified !== probe.maxModified || before.totalItems !== probe.totalItems || before.itemSetsSignature !== probe.itemSetsSignature) {
    throw new Error("Omeka items changed during the crawl; keeping the previous snapshot. Retry after the upstream sync finishes.");
  }
  // CPU only (no requests), so it runs after the consistency window closes.
  const semantic = release ? await computeNeighbours(release, data, { signal }) : null;
  if (semantic) log(`computed semantic neighbours: ${Object.keys(semantic.neighbours).length} records, ${semantic.low_signal.length} low-signal`);
  const manifest: SnapshotManifest = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    fetchedAt: new Date().toISOString(),
    apiBase,
    access,
    ...(privateItemIds ? { privateItemIds } : {}),
    // Compare like with like: the runtime probe covers ALL items, including
    // authorities outside the crawled corpora. A corpus-only max would cause
    // repeated full crawls whenever such an authority was modified last.
    maxModified: probe.maxModified,
    totalItemsOnInstance: probe.totalItems,
    itemSetsSignature: probe.itemSetsSignature,
    counts: Object.fromEntries(CORPORA.map((c) => [c, data[c].length])) as Record<CorpusName, number>,
    ...(fulltext ? { fulltextMaps: fulltextManifestEntry(fulltext) } : {}),
    ...(semantic ? { semanticNeighbours: semanticManifestEntry(semantic) } : {}),
  };
  return { data, manifest, fulltext, semantic };
}
