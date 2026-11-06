// get_semantic_map (#12, phase 2): the collection as groups of records close in
// meaning. The groups come from seeded spherical k-means over the verified
// corpus vectors, computed at crawl time (src/semantic.ts); this tool only
// describes them. Groups are UNNAMED: each is described by its size, type mix,
// most frequent subjects, countries and projects, and the records closest to
// its centre, so an agent characterises a group from its contents instead of
// inventing a label. Group ids hold for one snapshot only.
import { z } from "zod";
import type { ToolMap } from "./policy.js";
import { ensureStore, type DataStore } from "../data.js";
import { allowStructured } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
import { SEMANTIC_KINDS, semanticIndex, type SemanticIndex, type SemanticRecord } from "../semantic.js";
import { fold } from "../text.js";
import type { LinkedRef } from "../types.js";
import { itemUrl } from "../urls.js";
import { READ_ONLY, capLimit, capOffset, errorResult, exposureRestrictedResult, limitEcho, pageOf, textResult, type Server } from "./_shared.js";
import { noNeighboursReason, resolveSemanticSeed } from "./similar.js";

const TOP = 5;
const EXAMPLES = 3;

const view = (r: SemanticRecord) => ({ title: r.title, type: r.kind, omeka_id: r.o_id, amira_url: itemUrl(r.o_id) });

/** Most frequent linked values across a group, counting each record once. */
function tally(rows: LinkedRef[][], n: number) {
  const counts = new Map<string, { label: string; o_id: number | null; count: number }>();
  for (const refs of rows) {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!ref?.label) continue;
      const key = ref.o_id != null ? `id:${ref.o_id}` : `label:${fold(ref.label)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const row = counts.get(key) ?? { label: ref.label, o_id: ref.o_id, count: 0 };
      row.count++;
      counts.set(key, row);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, n)
    .map((r) => ({ name: r.label, count: r.count, ...(r.o_id != null ? { amira_url: itemUrl(r.o_id) } : {}) }));
}

/** What a group holds, read from its members' catalogue links. */
function describeGroup(store: DataStore, id: number, members: SemanticRecord[]) {
  return store.cachedRecent("semantic-group", String(id), () => {
    const byType: Record<string, number> = {};
    const subjects: LinkedRef[][] = [], countries: LinkedRef[][] = [], projects: LinkedRef[][] = [];
    for (const r of members) {
      byType[r.kind] = (byType[r.kind] ?? 0) + 1;
      if (r.kind === "research_item") {
        const it = store.getItem(String(r.o_id))!;
        subjects.push(it.subjects);
        countries.push(it.places.map((p) => store.placeChainRefs(p).at(-1)!));
        projects.push(it.project ? [it.project] : []);
      } else if (r.kind === "publication") {
        subjects.push(store.getPublication(String(r.o_id))!.subjects);
      } else if (r.kind === "project") {
        projects.push([{ label: r.title, o_id: r.o_id }]);
      }
    }
    return {
      group: id,
      size: members.length,
      by_type: byType,
      top_subjects: tally(subjects, TOP),
      top_countries: tally(countries, 3),
      top_projects: tally(projects, 3),
      closest_to_centre: members.slice(0, EXAMPLES).map(view),
    };
  }, 128);
}

const NOTE = "Groups of records whose catalogue descriptions read alike (k-means over EmbeddingGemma 2 vectors). They are unnamed: " +
  "describe a group by its subjects, countries, projects and records, and do not present it as a curated category. Group ids hold for this snapshot only.";

function space(index: SemanticIndex) {
  return { release: index.source.tag, model: index.source.model, generated_at: index.source.generated_at };
}

export function registerSemanticMapTools(server: Server, tools: ToolMap): void {
  tools.get_semantic_map = server.registerTool("get_semantic_map", {
    title: "Semantic map of the collection",
    description: "The collection as unnamed groups of records close in meaning (k-means over EmbeddingGemma 2 vectors): size, type mix, " +
      "top subjects, countries and projects, records nearest the centre. `group` lists one; `id` finds a record's group.",
    annotations: READ_ONLY,
    inputSchema: z.strictObject({
      group: z.number().int().min(1).optional().describe("A group id: list its records, nearest the centre first"),
      id: z.union([z.string().min(1).max(256), z.number().int().positive()]).optional().describe("A record (omeka_id or typed id): its group"),
      types: z.array(z.enum(SEMANTIC_KINDS)).min(1).max(SEMANTIC_KINDS.length).optional().describe("With group/id: only these record types"),
      limit: z.number().int().min(1).optional().describe("Groups (default 10, max 30) or records (default 20, max 100)"),
      offset: z.number().int().min(0).max(100_000).optional(),
    }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_semantic_map");
    const store = await ensureStore();
    const index = semanticIndex(store);
    if (!index?.groups.size) {
      return errorResult("semantic_unavailable", "This snapshot carries no semantic map (no verified corpus-vector release).", {
        suggested_tool: "get_collection_overview",
      });
    }
    if (args.group !== undefined && args.id !== undefined) {
      return errorResult("invalid_argument", "Pass `group` or `id`, not both.");
    }
    const offset = capOffset(args.offset);
    const note = guidanceEnabled() ? { note: NOTE } : {};

    let groupId = args.group;
    let seed: SemanticRecord | undefined;
    if (args.id !== undefined) {
      const found = resolveSemanticSeed(store, args.id, "get_semantic_map");
      if ("error" in found) return found.error;
      seed = found.record;
      groupId = index.groupOf.get(seed.o_id);
      if (groupId === undefined) {
        const reason = noNeighboursReason(index, seed.o_id) ?? "It is not in any group of this build.";
        return errorResult("not_on_map", `'${seed.title}' is on no group of the semantic map. ${reason}`, { suggested_tool: "get_semantic_map" });
      }
    }

    if (groupId === undefined) {
      const limit = capLimit(args.limit, 10, 30);
      const all = [...index.groups.entries()];
      const clustered = all.reduce((n, [, m]) => n + m.length, 0);
      return textResult(pageOf(all, offset, limit, ([id, members]) => describeGroup(store, id, members), {
        space: space(index), groups: all.length, records_on_map: clustered, low_signal_records: index.lowSignal.size,
        ...limitEcho(args.limit, 30, limit), ...note,
      }));
    }

    const members = index.groups.get(groupId);
    if (!members) {
      return errorResult("not_found", `No group ${groupId}; groups run from 1 to ${Math.max(...index.groups.keys())}.`, {
        suggested_tool: "get_semantic_map",
      });
    }
    const limit = capLimit(args.limit, 20, 100);
    const wanted = args.types ? new Set<string>(args.types) : null;
    const listed = members.filter((r) => !wanted || wanted.has(r.kind));
    return textResult(pageOf(listed, offset, limit, view, {
      space: space(index),
      ...describeGroup(store, groupId, members),
      ...(seed ? { record: { ...view(seed), rank_in_group: members.findIndex((r) => r.o_id === seed!.o_id) + 1 } } : {}),
      ...limitEcho(args.limit, 100, limit), ...note,
    }));
  });
}
