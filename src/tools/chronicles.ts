// Cluster Chronicles — the Africa Multiple cluster's writer-in-residence
// programme (item set 50105): one record per work, of several forms (essays,
// poems, photographs and drawings, events, a video). An essay or poem carries
// its verbatim text (bibo:content): searchable here (with a match snippet),
// never in summaries, opt-in and pageable in get_chronicle like a transcript.
// Every abstract was written by a language model, and the record says which.
import { z } from "zod";
import { schemaOnce } from "./schemaOnce.js";
import { recordArg } from "./records.js";
import type { ToolMap } from "./policy.js";
import { ensureStore, type DataStore } from "../data.js";
import type { ChronicleRec, LinkedRef } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import { recordByOId } from "../recordKinds.js";
import { personMatches } from "../names.js";
import { emptyKeyword, keywordMatches, parseKeyword } from "../matching.js";
import { invalidYearRange, placeMatcher } from "../researchItemQuery.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import {
  READ_ONLY,
  capLimit,
  capOffset,
  chronicleSummary,
  containsCI,
  emptySearchHint,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitEcho,
  matchSnippet,
  pageOf,
  refLabels,
  refLinks,
  textAccessDisabledResult,
  textResult,
  textWindowFields,
  type Server,
} from "./_shared.js";

/** The forms the collection holds today, for the filter description. */
const FORMS = "essay, poem, still image, event, video";

/** A form filter value: the friendly form, a common synonym, or the class term. */
function formMatches(c: ChronicleRec, value: string): boolean {
  const v = value.trim().toLowerCase();
  const alias: Record<string, string> = { photo: "still image", photograph: "still image", image: "still image", drawing: "still image" };
  return equalsCI(c.form, alias[v] ?? v) || equalsCI(c.resource_class ?? "", v);
}

/** A typed reference to a related record: a chronicle, a video, a podcast… */
function relationRef(store: DataStore, ref: LinkedRef): Record<string, unknown> {
  const kind = ref.o_id != null ? recordByOId(store, ref.o_id)?.kind ?? null : null;
  return { title: ref.label, kind, ...(kind && ref.o_id != null ? { id: `${kind}:${ref.o_id}` } : {}), amira_url: itemUrlOrNull(ref.o_id) };
}

export function registerChronicleTools(server: Server, tools: ToolMap): void {
  // === search_chronicles ====================================================
  tools.search_chronicles = server.registerTool(
    "search_chronicles",
    {
      title: "Search Cluster Chronicles",
      description: "Search Cluster Chronicles works (writer-in-residence essays, poems, photos, events) by chronicler, form, year, subject, place or keyword. Full text matches include snippets.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("search_chronicles:in", () => z.strictObject({
        keyword: z.string().max(1000).optional()
          .describe("Every word must occur in the title, abstract or text; quote a phrase to match it exactly"),
        person: z.string().max(1000).optional().describe("A chronicler, other credited person or person depicted; either name order works"),
        form: z.string().max(100).optional().describe(`Form: ${FORMS}`),
        subject: z.string().max(1000).optional().describe("Subject, partial"),
        place: z.string().max(1000).optional().describe("Place at any level ('Kenya' includes Kakamega) or a venue, partial"),
        language: z.string().max(1000).optional().describe("Name or ISO code"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Earliest year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Latest year"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      })),
    },
    async (args) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", "`year_from` must be less than or equal to `year_to`.");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      for (const key of ["person", "subject", "place", "language"] as const) {
        if (args[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
      }
      const parsed = args.keyword ? parseKeyword(args.keyword) : null;
      const query = parsed && !emptyKeyword(parsed) ? parsed : null;
      const matchesPlace = args.place ? placeMatcher(store, args.place, "any") : null;
      const textOnly = new Set<number>();
      const filtered = store.chronicles.filter((c) => {
        if (query) {
          const meta = [c.title, ...c.alt_titles, allowDescriptive() ? c.abstract : null, allowDescriptive() ? c.description : null];
          if (!keywordMatches(query, meta)) {
            if (!allowFullText() || !keywordMatches(query, [...meta, c.text])) return false;
            textOnly.add(c.o_id);
          }
        }
        if (args.year_from !== undefined && (c.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (c.year ?? Infinity) > args.year_to) return false;
        if (args.form && !formMatches(c, args.form)) return false;
        if (args.person && !c.people.some((p) => personMatches(p.name, args.person!)) &&
          !c.depicts.some((r) => personMatches(r.label, args.person!))) return false;
        if (args.subject && !c.subjects.some((s) => containsCI(s.label, args.subject!))) return false;
        if (matchesPlace && !c.places.some((p) => matchesPlace(p) || containsCI(p.label, args.place!))) return false;
        if (args.language && !store.languageIndex.matches(c.languages, args.language)) return false;
        return true;
      });
      // Newest residency first; within one, the chronicler's own numbering.
      filtered.sort((a, b) => (b.date ?? "").slice(0, 4).localeCompare((a.date ?? "").slice(0, 4)) ||
        (a.number ?? Infinity) - (b.number ?? Infinity) || (a.date ?? "").localeCompare(b.date ?? "") || a.o_id - b.o_id);

      return textResult({
        ...pageOf(filtered, offset, limit,
          (c) => textOnly.has(c.o_id)
            ? { ...chronicleSummary(c), matched_in: "text", text_snippet: matchSnippet(c.text, args.keyword!) }
            : chronicleSummary(c),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) }),
        ...emptySearchHint(filtered.length, args),
      });
    },
  );

  // === get_chronicle ========================================================
  tools.get_chronicle = server.registerTool(
    "get_chronicle",
    {
      title: "Get Cluster Chronicles work",
      description: "One Cluster Chronicles work: chroniclers and roles, people depicted, subjects, places, related works and recordings, images, links. Abstracts are AI-written (says which model). Text opt-in and pageable.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("get_chronicle:in", () => z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Id from search_chronicles, e.g. 50109, or chronicle:50109"),
        include_text: z.boolean().optional().describe("Default false — set true to include the full text of an essay or poem"),
        text_offset: z.number().int().min(0).optional().describe("Start offset into the text (chars), with include_text"),
        text_max_chars: z.number().int().min(1).optional().describe("Max text characters to return (default/max 25000)"),
      })),
    },
    async ({ id, include_text, text_offset, text_max_chars }) => {
      const store = await ensureStore();
      const found = recordArg(store, id, "chronicle",
        () => errorResult("not_found", `No Cluster Chronicles work with id ${id}.`, { suggested_tool: "search_chronicles" }));
      if ("error" in found) return found.error;
      const c = found.record;
      if (include_text && !allowFullText()) return textAccessDisabledResult("text");
      return textResult({
        id: String(c.o_id),
        omeka_id: c.o_id,
        title: c.title,
        ...(c.title_language ? { title_language: c.title_language } : {}),
        alternative_titles: c.alt_titles,
        form: c.form,
        resource_class: c.resource_class,
        series: c.series ? { title: c.series.label, amira_url: itemUrlOrNull(c.series.o_id) } : null,
        number: c.number,
        date: c.date,
        identifier: c.identifier,
        ...(allowDescriptive()
          ? {
              abstract: c.abstract,
              // The abstracts were written by a language model, not by the chronicler.
              ...(c.abstract && c.abstract_generated_by
                ? { abstract_ai_generated: true, abstract_generated_by: { name: c.abstract_generated_by.label, amira_url: itemUrlOrNull(c.abstract_generated_by.o_id) } }
                : {}),
              description: c.description,
            }
          : { abstract: null }),
        ...(allowStructured()
          ? {
              people: c.people.map((p) => ({ name: p.name, role: p.role, amira_url: itemUrlOrNull(p.o_id) })),
              depicts: refLinks(c.depicts),
              subjects: refLinks(c.subjects),
              places: refLinks(c.places),
              languages: refLabels(c.languages),
              related: c.relations.map((r) => relationRef(store, r)),
            }
          : {}),
        urls: c.urls,
        media: (c.media ?? []).map((m) => ({ type: m.type, url: m.url, source: m.source, ...(m.visibility ? { visibility: m.visibility } : {}) })),
        thumbnail: c.thumbnail,
        ...textWindowFields("text", c.text, { include: include_text, offset: text_offset, maxChars: text_max_chars }),
        amira_url: itemUrl(c.o_id),
      });
    },
  );
}
