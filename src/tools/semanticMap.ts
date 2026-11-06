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
import { RefTally } from "../matching.js";
import { recordLinks } from "../recordLinks.js";
import { SEMANTIC_KINDS, semanticIndex, semanticRef, semanticSpace, type SemanticRecord } from "../semantic.js";
import { itemUrl } from "../urls.js";
import { READ_ONLY, capLimit, capOffset, errorResult, exposureRestrictedResult, limitEcho, pageOf, textResult, type Server } from "./_shared.js";
import { noNeighboursReason, resolveSemanticSeed, semanticUnavailable } from "./similar.js";

const TOP = 5;
const EXAMPLES = 3;

/** The most frequent values of a tally, each cited when it is an authority. */
const top = (tally: RefTally, n: number) =>
  tally.top(n).map((r) => ({ name: r.label, count: r.count, ...(r.o_id != null ? { amira_url: itemUrl(r.o_id) } : {}) }));

/** What a group holds, read from its members' catalogue links (src/recordLinks.ts). */
function describeGroup(store: DataStore, id: number, members: SemanticRecord[]) {
  return store.cachedRecent("semantic-group", String(id), () => {
    const byType: Record<string, number> = {};
    const subjects = new RefTally(), countries = new RefTally(), projects = new RefTally();
    for (const r of members) {
      byType[r.kind] = (byType[r.kind] ?? 0) + 1;
      const links = recordLinks(store, r.kind, r.o_id);
      subjects.add(links.subjects);
      countries.add(links.countries);
      projects.add(links.projects);
    }
    return {
      group: id,
      size: members.length,
      by_type: byType,
      top_subjects: top(subjects, TOP),
      top_countries: top(countries, 3),
      top_projects: top(projects, 3),
      closest_to_centre: members.slice(0, EXAMPLES).map(semanticRef),
    };
  }, 128);
}

const NOTE = "Groups of records whose catalogue descriptions read alike (k-means over EmbeddingGemma 2 vectors). They are unnamed: " +
  "describe a group by its subjects, countries, projects and records, and do not present it as a curated category. Group ids hold for this snapshot only.";

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
    if (!index?.groups.size) return semanticUnavailable("semantic map", "get_collection_overview");
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
        space: semanticSpace(index), groups: all.length, records_on_map: clustered, low_signal_records: index.lowSignal.size,
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
    return textResult(pageOf(listed, offset, limit, semanticRef, {
      space: semanticSpace(index),
      ...describeGroup(store, groupId, members),
      ...(seed ? { record: { ...semanticRef(seed), rank_in_group: members.findIndex((r) => r.o_id === seed!.o_id) + 1 } } : {}),
      ...limitEcho(args.limit, 100, limit), ...note,
    }));
  });
}
