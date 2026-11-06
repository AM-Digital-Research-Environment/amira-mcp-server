// get_similar_items (#12, phase 1): nearest neighbours by meaning, from the
// semantic neighbours the crawl computed out of DRE Visualizations' corpus
// vectors (src/semantic.ts). Cross-type: a research item can surface a
// publication, a podcast episode or a project. Every neighbour is a record in
// the served snapshot and is cited by its amira_url.
import { z } from "zod";
import type { ToolMap } from "./policy.js";
import { ensureStore } from "../data.js";
import { allowStructured } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
import { SEMANTIC_KINDS, semanticIndex, semanticRecord, type SemanticKind } from "../semantic.js";
import { parseTypedId } from "../typedIds.js";
import { itemUrl } from "../urls.js";
import { READ_ONLY, capLimit, errorResult, exposureRestrictedResult, limitEcho, textResult, type Server } from "./_shared.js";

export function registerSimilarTools(server: Server, tools: ToolMap): void {
  tools.get_similar_items = server.registerTool("get_similar_items", {
    title: "Find similar records",
    description: "Records whose catalogue descriptions read most alike (EmbeddingGemma 2 vectors), across research items, publications, " +
      "videos, podcasts, projects and sections. Similar wording, not a documented link.",
    annotations: READ_ONLY,
    inputSchema: z.strictObject({
      id: z.union([z.string().min(1).max(256), z.number().int().positive()]).describe("omeka_id, or a typed id such as publication:29919"),
      types: z.array(z.enum(SEMANTIC_KINDS)).min(1).max(SEMANTIC_KINDS.length).optional().describe("Only these record types"),
      limit: z.number().int().min(1).optional().describe("Default 5, max 10"),
    }),
  }, async (args) => {
    if (!allowStructured()) return exposureRestrictedResult("structured", "get_similar_items");
    const store = await ensureStore();
    const index = semanticIndex(store);
    if (!index) {
      return errorResult("semantic_unavailable", "This snapshot carries no semantic neighbours (no verified corpus-vector release).", {
        suggested_tool: "find_related",
      });
    }
    const raw = String(args.id).trim();
    const typed = parseTypedId(raw);
    if (typed && !(SEMANTIC_KINDS as readonly string[]).includes(typed.kind)) {
      return errorResult("not_embedded", `Only ${SEMANTIC_KINDS.join(", ")} records are embedded, not ${typed.kind} records.`, {
        suggested_tool: "find_related",
      });
    }
    const kinds = typed ? [typed.kind as SemanticKind] : SEMANTIC_KINDS;
    const key = typed?.key ?? raw;
    // A research item's dre:id also identifies it.
    const oId = /^\d+$/.test(key) ? Number(key) : store.getItem(key)?.o_id;
    const record = oId == null ? undefined : semanticRecord(store, oId, kinds);
    if (!record) {
      return errorResult("not_found", `No research item, publication, video, podcast, project or section with id '${raw}'.`, {
        suggested_tool: "resolve_entity",
      });
    }
    const limit = capLimit(args.limit, 5, 10);
    const view = (r: { kind: SemanticKind; o_id: number; title: string }) =>
      ({ id: String(r.o_id), omeka_id: r.o_id, type: r.kind, title: r.title, amira_url: itemUrl(r.o_id) });
    const head = {
      source: view(record),
      space: { release: index.source.tag, model: index.source.model, generated_at: index.source.generated_at },
    };
    const note = guidanceEnabled()
      ? { note: "Scores are cosine similarities of catalogue descriptions. Similar wording is not evidence of a documented relation." }
      : {};
    if (index.lowSignal.has(record.o_id)) {
      return textResult({ ...head, count: 0, results: [], no_neighbours: "low_signal",
        reason: "Too little own text (title, abstract or description, subjects, places) to compare reliably, so it has no neighbours." });
    }
    const list = index.neighbours.get(record.o_id);
    if (!list) {
      return textResult({ ...head, count: 0, results: [], no_neighbours: "not_in_release",
        reason: `Not in corpus-vector build ${index.source.tag} (generated ${index.source.generated_at}), probably added since.` });
    }
    const wanted = args.types ? new Set<string>(args.types) : null;
    const results = list.filter((n) => !wanted || wanted.has(n.record.kind)).slice(0, limit)
      .map((n) => ({ ...view(n.record), score: n.score }));
    return textResult({ ...head, count: results.length, results, ...limitEcho(args.limit, 10, limit), ...note });
  });
}
