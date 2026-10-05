import { z } from "zod";
import * as path from "node:path";
import { ensureStore, cacheSnapshotDir, refreshStatus } from "../data.js";
import { config } from "../config.js";
import { allowFullText, allowStructured } from "../exposure.js";
import { CORPORA } from "../types.js";
import { entityGraph, entityEdges, entitySchema, entityTypes, edgeSchema, evidenceSchema, graphIndex, resolveEntities } from "../entityGraph.js";
import { researchFilters, selectResearchItems, invalidYearRange } from "../researchItemQuery.js";
import { foldedRanges } from "../text.js";
import { assertSnapshotSource, snapshotId } from "../snapshotIdentity.js";
import { loadSnapshot, readSnapshotPointer } from "../snapshot.js";
import { itemUrl, itemSetUrl } from "../urls.js";
import { annotate, textResult, errorResult, exposureRestrictedResult, pageOf, type Server } from "./_shared.js";

const offsetSchema = z.number().int().min(0).max(10_000).optional();
const querySchema = z.string().trim().min(1).max(1000);
const pageShape = { count: z.number(), total_matches: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional() };
const counts = z.record(z.string(), z.number());

export function registerResearchTools(server: Server): void {
  server.registerTool("resolve_entity", {
    title: "Resolve an entity", annotations: annotate("Resolve an entity"),
    description: "Resolve a label or typed ID to cited candidates. Returns ambiguity instead of merging names. Use a returned id with get_entity_graph.",
    inputSchema: z.strictObject({ query: querySchema, type: z.enum(entityTypes).optional(), limit: z.number().int().min(1).max(50).optional(), offset: offsetSchema }),
    outputSchema: z.object({ ...pageShape, results: z.array(entitySchema), ambiguous: z.boolean(), snapshot_id: z.string() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "resolve_entity");
    const store = await ensureStore();
    const found = resolveEntities(store, args.query, args.type);
    return textResult(pageOf(found, args.offset ?? 0, args.limit ?? 20, (e) => e, { ambiguous: found.length > 1, snapshot_id: snapshotId(store.manifest) }));
  });

  server.registerTool("get_entity_graph", {
    title: "Explore an entity graph", annotations: annotate("Explore an entity graph"),
    _meta: { ui: { resourceUri: "ui://amira/graph", visibility: ["model", "app"] } },
    description: "One-hop graph from a typed resolve_entity ID: explicit catalogue links and derived co-occurrence with distinct-record counts and cited evidence. Pass edge_id to page its evidence; pin snapshot_id across pages.",
    inputSchema: z.strictObject({ seed: z.string().min(1).max(256), max_nodes: z.number().int().min(2).max(100).optional(),
      max_edges: z.number().int().min(1).max(200).optional(), edge_id: z.string().max(64).optional(), snapshot_id: z.string().max(64).optional(), offset: offsetSchema,
      limit: z.number().int().min(1).max(50).optional() }),
    outputSchema: z.object({ snapshot_id: z.string(), seed: z.string(), nodes: z.array(entitySchema).optional(), edges: z.array(edgeSchema).optional(),
      total_edges: z.number().optional(), truncated: z.boolean().optional(), bounds: z.object({ max_nodes: z.number(), max_edges: z.number(), hops: z.number() }).optional(),
      results: z.array(evidenceSchema).optional(), count: z.number().optional(), total_matches: z.number().optional(), offset: z.number().optional(),
      has_more: z.boolean().optional(), next_offset: z.number().optional() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_entity_graph");
    const store = await ensureStore();
    const id = snapshotId(store.manifest);
    if (args.snapshot_id && args.snapshot_id !== id) return errorResult("snapshot_changed", "The snapshot changed. Reload the graph before paging evidence.");
    if (!graphIndex(store).entities.has(args.seed)) return errorResult("not_found", "Use a typed id returned by resolve_entity.", { suggested_tool: "resolve_entity" });
    if (args.edge_id) {
      const edge = entityEdges(store, args.seed).find((e) => e.edge.id === args.edge_id);
      if (!edge) return errorResult("not_found", "This edge is absent from the seed's current graph.");
      return textResult(pageOf([...edge.evidence.values()], args.offset ?? 0, args.limit ?? 20, (e) => e, { seed: args.seed, snapshot_id: id }));
    }
    return textResult(entityGraph(store, args.seed, args.max_nodes ?? 40, args.max_edges ?? 50));
  });

  server.registerTool("get_text_passages", {
    title: "Find cited text passages", annotations: annotate("Find cited text passages"),
    description: "Find literal accent-insensitive keyword passages in selected publication/video/podcast IDs. Original UTF-16 offsets, bounded context, and citations. Requires full text exposure; no semantic ranking.",
    inputSchema: z.strictObject({ ids: z.array(z.string().regex(/^(publication|video|podcast):[1-9]\d*$/).max(64)).min(1).max(10),
      keyword: querySchema, radius: z.number().int().min(20).max(500).optional(), offset: offsetSchema,
      limit: z.number().int().min(1).max(20).optional() }),
    outputSchema: z.object({ ...pageShape, results: z.array(z.object({ id: z.string(), title: z.string(), amira_url: z.string(),
      start: z.number(), end: z.number(), match_start: z.number(), match_end: z.number(), text: z.string() })),
      snapshot_id: z.string(), scanned_matches_capped: z.boolean(), unavailable_ids: z.array(z.string()) }),
  }, async (args) => {
    if (!allowFullText()) return exposureRestrictedResult("full", "get_text_passages");
    const store = await ensureStore();
    const results = [], unavailable: string[] = [];
    let capped = false;
    for (const id of new Set(args.ids)) {
      const [type, key] = id.split(":");
      const rec = type === "publication" ? store.getPublication(key!) : type === "video" ? store.getVideo(Number(key)) : store.getPodcast(Number(key));
      const text = rec && ("fulltext" in rec ? rec.fulltext : rec.transcript);
      if (!text || !rec) { unavailable.push(id); continue; }
      const matches = foldedRanges(text, args.keyword, 1001);
      if (matches.length > 1000) capped = true;
      for (const match of matches.slice(0, 1000)) {
        const start = Math.max(0, match.start - (args.radius ?? 160)), end = Math.min(text.length, match.end + (args.radius ?? 160));
        results.push({ id, title: rec.title, amira_url: itemUrl(rec.o_id), start, end, match_start: match.start, match_end: match.end, text: text.slice(start, end) });
      }
    }
    return textResult(pageOf(results, args.offset ?? 0, args.limit ?? 10, (r) => r,
      { snapshot_id: snapshotId(store.manifest), scanned_matches_capped: capped, unavailable_ids: unavailable }));
  });

  server.registerTool("compare_collections", {
    title: "Compare project collections", annotations: annotate("Compare project collections"),
    description: "Compare 2–4 projects or item sets with identical research-item filters. Reports denominators, missingness, dates and top types/languages; collections can overlap.",
    inputSchema: z.strictObject({ cohorts: z.array(z.strictObject({ type: z.enum(["project", "collection"]), id: z.string().min(1).max(256) })).min(2).max(4),
      filters: researchFilters.optional() }),
    outputSchema: z.object({ snapshot_id: z.string(), overlap_note: z.string(), cohorts: z.array(z.object({ type: z.string(), id: z.number(), name: z.string(),
      amira_url: z.string(), total_items: z.number(), matched_items: z.number(), missing: counts, resource_types: counts, languages: counts,
      date_range: z.object({ earliest: z.number(), latest: z.number() }).nullable() })) }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "compare_collections");
    if (invalidYearRange(args.filters?.year_from, args.filters?.year_to)) return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
    const store = await ensureStore();
    const selected = new Set(selectResearchItems(store, args.filters ?? {}).filtered.map((it) => it.o_id));
    const cohorts = [];
    for (const cohort of args.cohorts) {
      const rec = cohort.type === "project" ? store.getProject(cohort.id) : store.getItemSet(Number(cohort.id));
      if (!rec) return errorResult("not_found", `Unknown ${cohort.type} id: ${cohort.id}`);
      const all = store.items.filter((it) => cohort.type === "project" ? it.project?.o_id === rec.o_id : it.item_sets.includes(rec.o_id));
      const items = all.filter((it) => selected.has(it.o_id));
      const types = new Map<string, number>(), languages = new Map<string, number>();
      const missing = { date: 0, language: 0, place: 0, resource_type: 0 };
      const years: number[] = [];
      for (const it of items) {
        if (it.type) types.set(it.type, (types.get(it.type) ?? 0) + 1); else missing.resource_type++;
        for (const label of new Set(it.languages.map((l) => l.label))) languages.set(label, (languages.get(label) ?? 0) + 1);
        if (!it.languages.length) missing.language++;
        if (!it.places.length) missing.place++;
        if (it.year_min == null) missing.date++; else years.push(it.year_min, it.year_max ?? it.year_min);
      }
      const ranked = (map: Map<string, number>) => Object.fromEntries([...map].sort((a, b) => b[1] - a[1]).slice(0, 30));
      cohorts.push({ type: cohort.type, id: rec.o_id, name: "name" in rec ? rec.name : rec.title,
        amira_url: cohort.type === "project" ? itemUrl(rec.o_id) : itemSetUrl(rec.o_id), total_items: all.length, matched_items: items.length,
        missing, resource_types: ranked(types), languages: ranked(languages), date_range: years.length ? { earliest: Math.min(...years), latest: Math.max(...years) } : null });
    }
    return textResult({ snapshot_id: snapshotId(store.manifest), cohorts, overlap_note: "Counts are distinct items within each cohort; cohorts may overlap. Language totals may exceed items; category lists show the top 30." });
  });

  server.registerTool("get_data_quality", {
    title: "Inspect data coverage", annotations: annotate("Inspect data coverage"),
    description: "Snapshot coverage and missing metadata, unresolved loaded-authority links, and sanitized refresh status. Missing catalogue metadata is not evidence of real-world absence.",
    inputSchema: z.strictObject({}),
    outputSchema: z.object({ snapshot_id: z.string(), fetched_at: z.string(), counts, missing: counts,
      unresolved_entities: z.number(), literal_entities: z.number(), refresh: z.object({ enabled: z.boolean(), in_flight: z.boolean(),
        last_attempt: z.string().nullable(), last_success: z.string().nullable(), error_class: z.string().nullable() }) }),
  }, async () => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_data_quality");
    const store = await ensureStore();
    const quality = store.cached("quality", () => {
      const entities = [...graphIndex(store).entities.values()];
      return { snapshot_id: snapshotId(store.manifest), fetched_at: store.manifest.fetchedAt, counts: store.manifest.counts,
        missing: { item_date: store.items.filter((i) => i.year_min == null).length,
          item_place: store.items.filter((i) => !i.places.length).length, item_language: store.items.filter((i) => !i.languages.length).length,
          location_coordinates: store.locations.filter((l) => l.latitude == null || l.longitude == null).length,
          publication_fulltext: store.publications.filter((p) => !p.fulltext).length,
          podcast_transcript: store.podcasts.filter((p) => !p.transcript).length, video_transcript: store.videos.filter((v) => !v.transcript).length },
        unresolved_entities: entities.filter((e) => e.omeka_id != null && !e.resolved).length,
        literal_entities: entities.filter((e) => e.omeka_id == null).length };
    });
    return textResult({ ...quality, refresh: refreshStatus() });
  });

  server.registerTool("get_snapshot_changes", {
    title: "Compare retained snapshots", annotations: annotate("Compare retained snapshots"),
    description: "Page added/updated/deleted records between retained snapshots from this Omeka instance. Lists available snapshot IDs when fewer than two exist. Select from_id/to_id for stable paging.",
    inputSchema: z.strictObject({ from_id: z.string().max(64).optional(), to_id: z.string().max(64).optional(),
      corpus: z.enum(CORPORA).optional(), offset: offsetSchema, limit: z.number().int().min(1).max(100).optional() }),
    outputSchema: z.object({ status: z.enum(["ready", "history_unavailable"]), snapshots: z.array(z.object({ id: z.string(), fetched_at: z.string() })),
      from_id: z.string().optional(), to_id: z.string().optional(), results: z.array(z.object({ corpus: z.string(), id: z.number(),
        change: z.enum(["added", "updated", "deleted"]), title: z.string(), amira_url: z.string() })).optional(),
      count: z.number().optional(), total_matches: z.number().optional(), offset: z.number().optional(), has_more: z.boolean().optional(), next_offset: z.number().optional() }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_snapshot_changes");
    const dir = cacheSnapshotDir(), pointer = await readSnapshotPointer(dir);
    const directories = [config.bundledDataDir, ...(pointer ? [pointer.current, ...pointer.previous].map((g) => path.join(dir, "generations", g)) : [])];
    const snapshots = new Map<string, Awaited<ReturnType<typeof loadSnapshot>>>();
    for (const directory of directories) {
      try { const out = await loadSnapshot(directory); assertSnapshotSource(out.manifest, config.apiBase); snapshots.set(snapshotId(out.manifest), out); }
      catch { /* Missing, invalid or cross-instance snapshots cannot participate. */ }
    }
    const available = [...snapshots].sort((a, b) => b[1].manifest.fetchedAt.localeCompare(a[1].manifest.fetchedAt));
    const meta = available.map(([id, out]) => ({ id, fetched_at: out.manifest.fetchedAt }));
    if (available.length < 2) return textResult({ status: "history_unavailable", snapshots: meta });
    const toId = args.to_id ?? available[0]![0], fromId = args.from_id ?? available[1]![0];
    const before = snapshots.get(fromId), after = snapshots.get(toId);
    if (!before || !after) return errorResult("snapshot_unavailable", "One selected snapshot is no longer retained. Reload the snapshot list.");
    const changes = [];
    for (const corpus of args.corpus ? [args.corpus] : CORPORA) {
      const old = new Map(before.data[corpus].map((r) => [r.o_id, r]));
      const current = new Map(after.data[corpus].map((r) => [r.o_id, r]));
      for (const id of [...new Set([...old.keys(), ...current.keys()])].sort((a, b) => a - b)) {
        const prev = old.get(id), next = current.get(id), rec = next ?? prev!;
        const change = !prev ? "added" : !next ? "deleted" : JSON.stringify(prev) !== JSON.stringify(next) ? "updated" : null;
        if (change) changes.push({ corpus, id, change, title: "name" in rec ? rec.name : rec.title,
          amira_url: corpus === "item_sets" ? itemSetUrl(id) : itemUrl(id) });
      }
    }
    return textResult(pageOf(changes, args.offset ?? 0, args.limit ?? 30, (c) => c, { status: "ready", snapshots: meta, from_id: fromId, to_id: toId }));
  });
}
