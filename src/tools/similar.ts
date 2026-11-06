// Semantic neighbours (#12): get_similar_items, and the opt-in `include_similar`
// block of the detail tools. Neighbours come from the semantic neighbours the
// crawl computed out of DRE Visualizations' corpus vectors (src/semantic.ts).
// Cross-type: a research item can surface a publication, a podcast episode or a
// project. Every neighbour is a record in the served snapshot, cited by its
// amira_url.
//
// Each neighbour is explained (phase 2): the subjects, places, people or
// project it ALSO shares with the source, read from the catalogue links, or
// `basis: "wording_only"` when the pair shares none of them. Research sections
// are left out: with 13 broad ones, nearly every pair shares one. An agent
// can then weigh a recommendation instead of taking similar wording for a link.
import { z } from "zod";
import type { ToolMap } from "./policy.js";
import { ensureStore, type DataStore } from "../data.js";
import { allowStructured } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
import { SEMANTIC_KINDS, semanticIndex, semanticRecord, type SemanticIndex, type SemanticKind, type SemanticRecord } from "../semantic.js";
import { fold } from "../text.js";
import { parseTypedId } from "../typedIds.js";
import type { LinkedRef } from "../types.js";
import { itemUrl } from "../urls.js";
import { READ_ONLY, capLimit, errorResult, exposureRestrictedResult, limitEcho, textResult, type Server } from "./_shared.js";

/** Neighbours an `include_similar` block lists; get_similar_items goes to 10. */
const DETAIL_LIMIT = 5;
/** Labels named per shared category; `shared_counts` gives the full numbers. */
const SHARED_LABELS = 3;

const CATEGORIES = ["subjects", "places", "people", "project"] as const;
type Category = (typeof CATEGORIES)[number];
type Links = Record<Category, Map<string, string>>;

/** The catalogue links of a record, keyed by Omeka id (or folded label when unlinked). */
function linksOf(store: DataStore, r: SemanticRecord): Links {
  return store.cachedRecent(`semantic-links:${r.o_id}`, () => {
    const links: Links = { subjects: new Map(), places: new Map(), people: new Map(), project: new Map() };
    const add = (category: Category, refs: (LinkedRef | { label: string; o_id: number | null } | null | undefined)[]) => {
      for (const ref of refs) {
        if (!ref?.label && ref?.o_id == null) continue;
        links[category].set(ref.o_id != null ? `id:${ref.o_id}` : `label:${fold(ref.label)}`, ref.label);
      }
    };
    const person = (c: { name: string; o_id: number | null }) => ({ label: c.name, o_id: c.o_id });
    if (r.kind === "research_item") {
      const it = store.getItem(String(r.o_id))!;
      add("subjects", it.subjects);
      // A place shares its country: Lagos and Ibadan items both name Nigeria.
      add("places", it.places.flatMap((p) => store.placeChainRefs(p)));
      add("people", it.contributors.map(person));
      add("project", [it.project]);
    } else if (r.kind === "publication") {
      const p = store.getPublication(String(r.o_id))!;
      add("subjects", p.subjects);
      add("people", [...p.authors, ...p.editors]);
    } else if (r.kind === "podcast") {
      add("people", store.getPodcast(r.o_id)!.people.map(person));
    } else if (r.kind === "video") {
      add("people", store.getVideo(r.o_id)!.speakers.map(person));
    } else if (r.kind === "project") {
      const p = store.getProjectByOId(r.o_id)!;
      add("people", [...p.pis, ...p.members]);
      add("project", [{ label: p.name, o_id: p.o_id }]);
    } else {
      const s = store.getSectionByOId(r.o_id)!;
      add("people", [...s.pis, ...s.members]);
    }
    return links;
  }, 256);
}

/** What a neighbour shares with the source beyond wording. */
function explain(store: DataStore, source: SemanticRecord, neighbour: SemanticRecord) {
  const a = linksOf(store, source), b = linksOf(store, neighbour);
  const shared: Partial<Record<Category, string[]>> = {};
  const counts: Partial<Record<Category, number>> = {};
  for (const category of CATEGORIES) {
    const labels = [...a[category]].filter(([key]) => b[category].has(key)).map(([, label]) => label);
    if (!labels.length) continue;
    shared[category] = labels.slice(0, SHARED_LABELS);
    if (labels.length > SHARED_LABELS) counts[category] = labels.length;
  }
  return Object.keys(shared).length
    ? { basis: "shared_metadata" as const, shared, ...(Object.keys(counts).length ? { shared_counts: counts } : {}) }
    : { basis: "wording_only" as const };
}

const view = (r: SemanticRecord) => ({ id: String(r.o_id), omeka_id: r.o_id, type: r.kind, title: r.title, amira_url: itemUrl(r.o_id) });

/**
 * A record's neighbours, explained, or the reason it has none. The shape both
 * get_similar_items and the detail tools' `similar` block return.
 */
function neighbours(store: DataStore, index: SemanticIndex, record: SemanticRecord, limit: number, types?: readonly string[]) {
  const reason = noNeighboursReason(index, record.o_id);
  const list = index.neighbours.get(record.o_id);
  if (reason || !list) {
    return { count: 0, results: [], no_neighbours: index.lowSignal.has(record.o_id) ? "low_signal" as const : "not_in_release" as const,
      reason: reason! };
  }
  const wanted = types ? new Set<string>(types) : null;
  const results = list.filter((n) => !wanted || wanted.has(n.record.kind)).slice(0, limit)
    .map((n) => ({ ...view(n.record), score: n.score, ...explain(store, record, n.record) }));
  return { count: results.length, results };
}

const NOTE = "Scores are cosine similarities of catalogue descriptions. `shared` lists what a pair also shares in the catalogue; " +
  "`wording_only` means similar wording and nothing more: not evidence of a documented relation.";

/**
 * The `similar` block of a detail tool (`include_similar: true`): up to five
 * explained neighbours, or why there are none. Never an error: the record
 * itself was found.
 */
export function similarBlock(store: DataStore, kind: SemanticKind, oId: number): Record<string, unknown> {
  if (!allowStructured()) return { unavailable: "Similar records need the structured exposure level." };
  const index = semanticIndex(store);
  if (!index) return { unavailable: "This snapshot carries no semantic neighbours." };
  const record = semanticRecord(store, oId, [kind]);
  if (!record) return { unavailable: "This record is not embedded." };
  return { release: index.source.tag, ...neighbours(store, index, record, DETAIL_LIMIT), ...(guidanceEnabled() ? { note: NOTE } : {}) };
}

/**
 * An embedded record from an omeka_id, a typed id (`publication:29919`) or a
 * research item's dre:id, or the error to return. Shared by get_similar_items
 * and find_related's `record` pivot.
 */
export function resolveSemanticSeed(store: DataStore, value: string | number, otherTool: string):
  { record: SemanticRecord } | { error: ReturnType<typeof errorResult> } {
  const raw = String(value).trim();
  const typed = parseTypedId(raw);
  if (typed && !(SEMANTIC_KINDS as readonly string[]).includes(typed.kind)) {
    return { error: errorResult("not_embedded", `Only ${SEMANTIC_KINDS.join(", ")} records are embedded, not ${typed.kind} records.`, {
      suggested_tool: otherTool,
    }) };
  }
  const kinds = typed ? [typed.kind as SemanticKind] : SEMANTIC_KINDS;
  const key = typed?.key ?? raw;
  // A research item's dre:id also identifies it.
  const oId = /^\d+$/.test(key) ? Number(key) : store.getItem(key)?.o_id;
  const record = oId == null ? undefined : semanticRecord(store, oId, kinds);
  if (!record) {
    return { error: errorResult("not_found", `No research item, publication, video, podcast, project or section with id '${raw}'.`, {
      suggested_tool: "resolve_entity",
    }) };
  }
  return { record };
}

/** Why a record has no neighbours, or null when it has some. */
export function noNeighboursReason(index: SemanticIndex, oId: number): string | null {
  if (index.lowSignal.has(oId)) return "Too little own text (title, abstract or description, subjects, places) to compare reliably, so it has no neighbours.";
  if (!index.neighbours.has(oId)) return `Not in corpus-vector build ${index.source.tag} (generated ${index.source.generated_at}), probably added since.`;
  return null;
}

/** The opt-in flag the detail tools share. */
export const includeSimilarSchema = z.boolean().optional().describe("Add up to 5 similar records, each explained");

export function registerSimilarTools(server: Server, tools: ToolMap): void {
  tools.get_similar_items = server.registerTool("get_similar_items", {
    title: "Find similar records",
    description: "Records whose catalogue descriptions read most alike (EmbeddingGemma 2 vectors), across research items, publications, " +
      "videos, podcasts, projects and sections. Each says what else it shares (subjects, places, people, project) or wording_only.",
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
    const seed = resolveSemanticSeed(store, args.id, "find_related");
    if ("error" in seed) return seed.error;
    const { record } = seed;
    const limit = capLimit(args.limit, 5, 10);
    const found = neighbours(store, index, record, limit, args.types);
    return textResult({
      source: view(record),
      space: { release: index.source.tag, model: index.source.model, generated_at: index.source.generated_at },
      ...found,
      ...(found.count ? limitEcho(args.limit, 10, limit) : {}),
      ...(found.count && guidanceEnabled() ? { note: NOTE } : {}),
    });
  });
}
