import type { ToolMap } from "./policy.js";
import { z } from "zod";
import * as path from "node:path";
import { ensureStore, cacheSnapshotDir, refreshStatus, type DataStore } from "../data.js";
import { config } from "../config.js";
import { allowFullText, allowStructured } from "../exposure.js";
import { CORPORA, type CorpusName, type SnapshotData } from "../types.js";
import { entityGraph, entityEdges, entitySchema, entityTypes, edgeSchema, evidenceSchema, graphIndex, resolveEntities } from "../entityGraph.js";
import { researchFilterError, researchFilters, selectResearchItems } from "../researchItemQuery.js";
import { foldCached, fold, foldedMatches } from "../text.js";
import { GRAPH_UI_META } from "./apps.js";
import { assertSnapshotSource, snapshotId } from "../snapshotIdentity.js";
import { loadSnapshot, readSnapshotPointer } from "../snapshot.js";
import { itemUrl, itemSetUrl } from "../urls.js";
import { canonicalTypedId, parseTypedId, stripTypedId } from "../typedIds.js";
import { READ_ONLY, capLimit, capOffset, limitEcho, queryErrorResult, textResult, errorResult, exposureRestrictedResult, pageOf, type Server } from "./_shared.js";
import { refreshSchema } from "./outputSchemas.js";

const offsetSchema = z.number().int().min(0).max(100_000).optional();
const querySchema = z.string().trim().min(1).max(1000);
const pageShape = { count: z.number(), total_matches: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional(),
  requested_limit: z.number().optional(), effective_limit: z.number().optional(), response_limited: z.boolean().optional() };
const counts = z.record(z.string(), z.number());

/** Matches scanned per document; `scanned_matches_capped` says when it was hit. */
const MATCH_CAP = 10_000;

// --- retained snapshot history (get_snapshot_changes) -----------------------------

type Loaded = { id: string; fetchedAt: string; data: SnapshotData };
/** Loaded generations by directory + pointer state; reloading every retained
 * snapshot from disk on each call cost ~1 s even with nothing to compare. */
let historyCache: { key: string; snapshots: Loaded[] } | null = null;
const diffCache = new Map<string, { corpus: CorpusName; id: number; change: "added" | "updated" | "deleted"; title: string; amira_url: string }[]>();

async function retainedSnapshots(store: DataStore): Promise<Loaded[]> {
  const dir = cacheSnapshotDir();
  const pointer = await readSnapshotPointer(dir).catch(() => null);
  const generations = pointer ? [pointer.current, ...pointer.previous] : [];
  const key = JSON.stringify([config.bundledDataDir, dir, generations, snapshotId(store.manifest)]);
  if (historyCache?.key === key) return historyCache.snapshots;
  const found = new Map<string, Loaded>();
  // The served store is one of the snapshots; never reload it.
  found.set(snapshotId(store.manifest), { id: snapshotId(store.manifest), fetchedAt: store.manifest.fetchedAt,
    data: { persons: store.persons, organisations: store.organisations, locations: store.locations, projects: store.projects,
      research_sections: store.sections, research_items: store.items, publications: store.publications, journals: store.journals,
      podcasts: store.podcasts, videos: store.videos, playlists: store.playlists, languages: store.languageIndex.all,
      item_sets: store.itemSets, subjects: store.subjects } });
  // Without retained generations the only other candidate is the bundled
  // snapshot, and it is the served one unless a refresh replaced it.
  const directories = [...(store.source === "cache" ? [config.bundledDataDir] : []),
    ...generations.map((g) => path.join(dir, "generations", g))];
  for (const directory of directories) {
    try {
      const out = await loadSnapshot(directory);
      assertSnapshotSource(out.manifest, config.apiBase);
      const id = snapshotId(out.manifest);
      if (!found.has(id)) found.set(id, { id, fetchedAt: out.manifest.fetchedAt, data: out.data });
    } catch { /* Missing, invalid or cross-instance snapshots cannot participate. */ }
  }
  const snapshots = [...found.values()].sort((a, b) => b.fetchedAt.localeCompare(a.fetchedAt));
  historyCache = { key, snapshots };
  diffCache.clear();
  return snapshots;
}

function snapshotDiff(before: Loaded, after: Loaded, corpora: readonly CorpusName[]) {
  const key = `${before.id}:${after.id}:${corpora.join(",")}`;
  const hit = diffCache.get(key);
  if (hit) return hit;
  const changes = [];
  for (const corpus of corpora) {
    const old = new Map((before.data[corpus] ?? []).map((r) => [r.o_id, r]));
    const current = new Map((after.data[corpus] ?? []).map((r) => [r.o_id, r]));
    for (const id of [...new Set([...old.keys(), ...current.keys()])].sort((a, b) => a - b)) {
      const prev = old.get(id), next = current.get(id), rec = next ?? prev!;
      const change = !prev ? "added" as const : !next ? "deleted" as const : JSON.stringify(prev) !== JSON.stringify(next) ? "updated" as const : null;
      if (change) changes.push({ corpus, id, change, title: "name" in rec ? rec.name : rec.title,
        amira_url: corpus === "item_sets" ? itemSetUrl(id) : itemUrl(id) });
    }
  }
  diffCache.set(key, changes);
  if (diffCache.size > 16) diffCache.delete(diffCache.keys().next().value!);
  return changes;
}

export function registerResearchTools(server: Server, tools: ToolMap): void {
  tools.resolve_entity = server.registerTool("resolve_entity", {
    title: "Resolve an entity", annotations: READ_ONLY,
    description: "Resolve a label or typed ID to cited candidates. Returns ambiguity instead of merging names. Use a returned id with get_entity_graph or get_* tools.",
    inputSchema: z.strictObject({ query: querySchema, type: z.enum(entityTypes).optional(),
      limit: z.number().int().min(1).optional(), offset: offsetSchema }),
    outputSchema: z.object({ ...pageShape, results: z.array(entitySchema), ambiguous: z.boolean(), snapshot_id: z.string() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "resolve_entity");
    const store = await ensureStore();
    const limit = capLimit(args.limit, 20, 50);
    const found = resolveEntities(store, args.query, args.type);
    return textResult(pageOf(found, capOffset(args.offset), limit, (e) => e,
      { ambiguous: found.length > 1, snapshot_id: snapshotId(store.manifest), ...limitEcho(args.limit, 50, limit) }));
  });

  tools.get_entity_graph = server.registerTool("get_entity_graph", {
    title: "Explore an entity graph", annotations: READ_ONLY,
    _meta: GRAPH_UI_META,
    description: "One-hop graph from a typed ID: explicit catalogue links and derived co-occurrence with distinct-record counts and cited evidence. Pass edge_id to page its evidence; pin snapshot_id across pages.",
    inputSchema: z.strictObject({ seed: z.string().min(1).max(256), max_nodes: z.number().int().min(2).optional().describe("Default 40, max 100"),
      max_edges: z.number().int().min(1).optional().describe("Default 50, max 200"), edge_id: z.string().max(64).optional(), snapshot_id: z.string().max(64).optional(), offset: offsetSchema,
      limit: z.number().int().min(1).optional().describe("Evidence page size, default 20, max 50") }),
    outputSchema: z.object({ snapshot_id: z.string(), seed: z.string(), nodes: z.array(entitySchema).optional(), edges: z.array(edgeSchema).optional(),
      total_edges: z.number().optional(), truncated: z.boolean().optional(), bounds: z.object({ max_nodes: z.number(), max_edges: z.number(), hops: z.number() }).optional(),
      results: z.array(evidenceSchema).optional(), count: z.number().optional(), total_matches: z.number().optional(), offset: z.number().optional(),
      has_more: z.boolean().optional(), next_offset: z.number().optional(), requested_limit: z.number().optional(), effective_limit: z.number().optional(),
      response_limited: z.boolean().optional() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_entity_graph");
    const store = await ensureStore();
    const id = snapshotId(store.manifest);
    if (args.snapshot_id && args.snapshot_id !== id) return errorResult("snapshot_changed", "The snapshot changed. Reload the graph before paging evidence.");
    // `item:` / `pub:` ids from search and fetch work as seeds too.
    const seed = canonicalTypedId(args.seed);
    if (!graphIndex(store).entities.has(seed)) return errorResult("not_found", "Use a typed id returned by resolve_entity (e.g. person:123, research_item:7392).", { suggested_tool: "resolve_entity" });
    if (args.edge_id) {
      const edge = entityEdges(store, seed).find((e) => e.edge.id === args.edge_id);
      if (!edge) return errorResult("not_found", "This edge is absent from the seed's current graph.");
      const limit = capLimit(args.limit, 20, 50);
      return textResult(pageOf([...edge.evidence.values()], capOffset(args.offset), limit, (e) => e,
        { seed, snapshot_id: id, ...limitEcho(args.limit, 50, limit) }));
    }
    return textResult(entityGraph(store, seed, capLimit(args.max_nodes, 40, 100), capLimit(args.max_edges, 50, 200)));
  });

  tools.get_text_passages = server.registerTool("get_text_passages", {
    title: "Find cited text passages", annotations: READ_ONLY,
    description: "Find literal accent-insensitive keyword passages in selected publication/video/podcast IDs. Original UTF-16 offsets, bounded context, and citations. Requires full text exposure; no semantic ranking.",
    inputSchema: z.strictObject({ ids: z.array(z.string().max(64)).min(1).max(10).describe("publication:, video: or podcast: ids"),
      keyword: querySchema, radius: z.number().int().min(20).max(500).optional(), offset: offsetSchema,
      limit: z.number().int().min(1).optional().describe("Default 10, max 20") }),
    outputSchema: z.object({ ...pageShape, results: z.array(z.object({ id: z.string(), title: z.string(), amira_url: z.string(),
      start: z.number(), end: z.number(), match_start: z.number(), match_end: z.number(), text: z.string() })),
      snapshot_id: z.string(), scanned_matches_capped: z.boolean(), unavailable_ids: z.array(z.string()) }),
  }, async (args) => {
    if (!allowFullText()) return exposureRestrictedResult("full", "get_text_passages");
    const store = await ensureStore();
    const limit = capLimit(args.limit, 10, 20);
    const offset = capOffset(args.offset);
    const radius = args.radius ?? 160;
    const needle = fold(args.keyword);
    const unavailable: string[] = [];
    // Count every document's matches first (cheap: memoised folded copies),
    // then materialise offsets only for the requested page.
    const docs: { id: string; title: string; o_id: number; text: string; total: number }[] = [];
    let capped = false;
    for (const raw of new Set(args.ids)) {
      const parsed = parseTypedId(raw);
      const rec = parsed?.kind === "publication" ? store.getPublication(parsed.key)
        : parsed?.kind === "video" ? store.getVideo(Number(parsed.key))
        : parsed?.kind === "podcast" ? store.getPodcast(Number(parsed.key)) : undefined;
      const text = rec && ("fulltext" in rec ? rec.fulltext : rec.transcript);
      if (!text || !rec || !parsed) { unavailable.push(raw); continue; }
      const id = `${parsed.kind}:${parsed.key}`;
      if (!foldCached(text).includes(needle)) continue;
      const { total, capped: hit } = foldedMatches(text, args.keyword, { take: 0, cap: MATCH_CAP });
      capped ||= hit;
      docs.push({ id, title: rec.title, o_id: rec.o_id, text, total });
    }
    const total = docs.reduce((n, d) => n + d.total, 0);
    const results = [];
    let skip = offset;
    for (const doc of docs) {
      if (results.length >= limit) break;
      if (skip >= doc.total) { skip -= doc.total; continue; }
      const { ranges } = foldedMatches(doc.text, args.keyword, { skip, take: limit - results.length, cap: MATCH_CAP });
      skip = 0;
      for (const match of ranges) {
        const start = Math.max(0, match.start - radius), end = Math.min(doc.text.length, match.end + radius);
        results.push({ id: doc.id, title: doc.title, amira_url: itemUrl(doc.o_id), start, end, match_start: match.start, match_end: match.end, text: doc.text.slice(start, end) });
      }
    }
    const hasMore = offset + results.length < total;
    return textResult({ count: results.length, total_matches: total, offset, has_more: hasMore,
      ...(hasMore ? { next_offset: offset + results.length } : {}), ...limitEcho(args.limit, 20, limit),
      results, snapshot_id: snapshotId(store.manifest), scanned_matches_capped: capped, unavailable_ids: unavailable });
  });

  tools.compare_collections = server.registerTool("compare_collections", {
    title: "Compare project collections", annotations: READ_ONLY,
    description: "Compare 2–4 projects or item sets with identical research-item filters. Reports denominators, missingness, dates and top types/languages; collections can overlap.",
    inputSchema: z.strictObject({ cohorts: z.array(z.strictObject({ type: z.enum(["project", "collection"]), id: z.string().min(1).max(256) })).min(2).max(4),
      filters: researchFilters.optional() }),
    outputSchema: z.object({ snapshot_id: z.string(), overlap_note: z.string(), cohorts: z.array(z.object({ type: z.string(), id: z.number(), name: z.string(),
      amira_url: z.string(), total_items: z.number(), matched_items: z.number(), missing: counts, resource_types: counts, languages: counts,
      date_range: z.object({ earliest: z.number(), latest: z.number() }).nullable() })) }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "compare_collections");
    const refused = researchFilterError(args.filters ?? {});
    if (refused) return queryErrorResult(refused);
    const store = await ensureStore();
    const selected = new Set(selectResearchItems(store, args.filters ?? {}).filtered.map((it) => it.o_id));
    const cohorts = [];
    for (const cohort of args.cohorts) {
      const key = stripTypedId(cohort.id, cohort.type === "project" ? ["project"] : ["collection"]);
      const rec = cohort.type === "project" ? store.getProject(key) : store.getItemSet(Number(key));
      if (!rec) return errorResult("not_found", `Unknown ${cohort.type} id: ${cohort.id}`);
      const all = cohort.type === "project" ? store.itemsForProject(rec.o_id) : store.items.filter((it) => it.item_sets.includes(rec.o_id));
      const items = all.filter((it) => selected.has(it.o_id));
      const types = new Map<string, number>(), languages = new Map<string, number>();
      const missing = { date: 0, language: 0, place: 0, resource_type: 0, media: 0 };
      const years: number[] = [];
      for (const it of items) {
        if (it.type) types.set(it.type, (types.get(it.type) ?? 0) + 1); else missing.resource_type++;
        for (const label of new Set(it.languages.map((l) => l.label))) languages.set(label, (languages.get(label) ?? 0) + 1);
        if (!it.languages.length) missing.language++;
        if (!it.places.length) missing.place++;
        if (!it.has_media) missing.media++;
        if (it.year_min == null) missing.date++; else years.push(it.year_min, it.year_max ?? it.year_min);
      }
      const ranked = (map: Map<string, number>) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]).slice(0, 30));
      cohorts.push({ type: cohort.type, id: rec.o_id, name: "name" in rec ? rec.name : rec.title,
        amira_url: cohort.type === "project" ? itemUrl(rec.o_id) : itemSetUrl(rec.o_id), total_items: all.length, matched_items: items.length,
        missing, resource_types: ranked(types), languages: ranked(languages), date_range: years.length ? { earliest: Math.min(...years), latest: Math.max(...years) } : null });
    }
    return textResult({ snapshot_id: snapshotId(store.manifest), cohorts, overlap_note: "Counts are distinct items within each cohort; cohorts may overlap. Language totals may exceed items; category lists show the top 30." });
  });

  tools.get_data_quality = server.registerTool("get_data_quality", {
    title: "Inspect data coverage", annotations: READ_ONLY,
    description: "Snapshot coverage and missing metadata, unresolved loaded-authority links, and sanitized refresh status. Missing catalogue metadata is not evidence of real-world absence.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ snapshot_id: z.string(), fetched_at: z.string(), schema_version: z.number(), counts, missing: counts,
      unresolved_entities: z.number(), literal_entities: z.number(), refresh: refreshSchema }),
  }, async () => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_data_quality");
    const store = await ensureStore();
    const quality = store.cached("quality", () => {
      const entities = [...graphIndex(store).entities.values()];
      return { snapshot_id: snapshotId(store.manifest), fetched_at: store.manifest.fetchedAt, schema_version: store.manifest.schemaVersion,
        counts: Object.fromEntries(CORPORA.map((c) => [c, store.manifest.counts[c] ?? 0])),
        missing: { item_date: store.items.filter((i) => i.year_min == null).length,
          item_place: store.items.filter((i) => !i.places.length).length, item_language: store.items.filter((i) => !i.languages.length).length,
          item_media: store.items.filter((i) => !i.has_media).length,
          location_coordinates: store.locations.filter((l) => l.latitude == null || l.longitude == null).length,
          person_identifier: store.persons.filter((p) => !p.identifiers?.length).length,
          publication_fulltext: store.publications.filter((p) => !p.fulltext).length,
          podcast_transcript: store.podcasts.filter((p) => !p.transcript).length, video_transcript: store.videos.filter((v) => !v.transcript).length },
        unresolved_entities: entities.filter((e) => e.omeka_id != null && !e.resolved).length,
        literal_entities: entities.filter((e) => e.omeka_id == null).length };
    });
    return textResult({ ...quality, refresh: refreshStatus() });
  });

  tools.get_snapshot_changes = server.registerTool("get_snapshot_changes", {
    title: "Compare retained snapshots", annotations: READ_ONLY,
    description: "Page added/updated/deleted records between retained snapshots from this Omeka instance. Lists available snapshot IDs when fewer than two exist. For recent additions without history, use added_since on the search tools.",
    inputSchema: z.strictObject({ from_id: z.string().max(64).optional(), to_id: z.string().max(64).optional(),
      corpus: z.enum(CORPORA).optional(), offset: offsetSchema, limit: z.number().int().min(1).optional().describe("Default 30, max 100") }),
    outputSchema: z.object({ status: z.enum(["ready", "history_unavailable"]), snapshots: z.array(z.object({ id: z.string(), fetched_at: z.string() })),
      from_id: z.string().optional(), to_id: z.string().optional(), results: z.array(z.object({ corpus: z.string(), id: z.number(),
        change: z.enum(["added", "updated", "deleted"]), title: z.string(), amira_url: z.string() })).optional(),
      count: z.number().optional(), total_matches: z.number().optional(), offset: z.number().optional(), has_more: z.boolean().optional(), next_offset: z.number().optional(),
      requested_limit: z.number().optional(), effective_limit: z.number().optional(), response_limited: z.boolean().optional() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_snapshot_changes");
    const store = await ensureStore();
    const available = await retainedSnapshots(store);
    const meta = available.map((s) => ({ id: s.id, fetched_at: s.fetchedAt }));
    if (available.length < 2) return textResult({ status: "history_unavailable", snapshots: meta });
    const toId = args.to_id ?? available[0]!.id, fromId = args.from_id ?? available[1]!.id;
    const before = available.find((s) => s.id === fromId), after = available.find((s) => s.id === toId);
    if (!before || !after) return errorResult("snapshot_unavailable", "One selected snapshot is no longer retained. Reload the snapshot list.");
    const changes = snapshotDiff(before, after, args.corpus ? [args.corpus] : CORPORA);
    const limit = capLimit(args.limit, 30, 100);
    return textResult(pageOf(changes, capOffset(args.offset), limit, (c) => c,
      { status: "ready", snapshots: meta, from_id: fromId, to_id: toId, ...limitEcho(args.limit, 100, limit) }));
  });
}
