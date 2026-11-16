import { schemaOnce } from "./schemaOnce.js";
import { recordArg } from "./records.js";
import type { ToolMap } from "./policy.js";
// Cluster Chronicles — the Africa Multiple cluster's writer-in-residence
// programme (item set 50105): one record per work, of several forms (essays,
// poems, photographs and drawings, events, a video). An essay or poem carries
// its verbatim text (bibo:content): searchable here (with a match snippet),
// never in summaries, opt-in and pageable in get_chronicle like a transcript.
// Every abstract was written by a language model, and the record says which.
import { z } from "zod";
import { callStore } from "./callStore.js";
import { pastEndHint } from "./listHints.js";
import type { DataStore } from "../data.js";
import type { ChronicleRec, LinkedRef } from "../types.js";
import { config } from "../config.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
import { duplicatePointer } from "../namesakes.js";
import { recordByOId } from "../recordKinds.js";
import { personMatches } from "../names.js";
import { chronicleCredits } from "../personCredits.js";
import { closestValues, emptyKeyword, keywordMatches, parseKeyword } from "../matching.js";
import { invalidYearRange, placeMatcher } from "../researchItemQuery.js";
import { INVALID_YEAR_RANGE } from "../errorCodes.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import {
  READ_ONLY,
  capOffset,
  chronicleSummary,
  containsCI,
  emptySearchHint,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  idParam,
  limitParam,
  matchSnippet,
  offsetParam,
  pageOf,
  refLabels,
  refLinks,
  textAccessDisabledResult,
  textParam,
  textResult,
  textWindowFields,
  textWindowParams,
  type Server,
} from "./_shared.js";

/** The forms the collection holds today, for the filter description. */
const FORMS = "essay, poem, still image, event, video";

/** Common words for a form, mapped to the stored one. */
const FORM_ALIASES: Record<string, string> = { photo: "still image", photograph: "still image", image: "still image", drawing: "still image" };

/** A form filter value: the stored form, a common synonym, or the class term (`fabio:Essay`). */
function formMatches(c: ChronicleRec, value: string): boolean {
  const v = value.trim().toLowerCase();
  return equalsCI(c.form, FORM_ALIASES[v] ?? v) || equalsCI(c.resource_class ?? "", v);
}

const LIMIT = limitParam(20, 100);

/** Search arguments, as the schema below parses them. */
interface SearchArgs {
  keyword?: string; person?: string; form?: string; subject?: string; place?: string; language?: string;
  year_from?: number; year_to?: number; limit?: number; offset?: number;
}

/**
 * For a search that found nothing: the closed-vocabulary filters (`form`,
 * `language`) whose value no chronicle carries at all, with the stored values
 * nearest to it (or all of them, when few).
 */
function chronicleDidYouMean(store: DataStore, args: SearchArgs): { filter: string; values: string[] }[] {
  const out: { filter: string; values: string[] }[] = [];
  const { form, language } = args;
  if (form && !store.chronicles.some((c) => formMatches(c, form))) {
    const values = closestValues(form, store.chronicles.map((c) => c.form));
    if (values.length) out.push({ filter: "form", values });
  }
  if (language && !store.chronicles.some((c) => store.languageIndex.matches(c.languages, language))) {
    const values = closestValues(language, store.chronicles.flatMap((c) => refLabels(c.languages)));
    if (values.length) out.push({ filter: "language", values });
  }
  return out;
}

/** Curator mode: `has_restricted_text` when the work's text is private (absent in public mode). */
function restrictedTextFlag(c: ChronicleRec): Record<string, unknown> {
  return config.access === "curator" && c.restricted?.fulltext ? { has_restricted_text: true } : {};
}

/** A typed reference to a related record: a chronicle, a video, a podcast… */
function relationRef(store: DataStore, ref: LinkedRef): Record<string, unknown> {
  const kind = ref.o_id != null ? recordByOId(store, ref.o_id)?.kind ?? null : null;
  return { title: ref.label, kind, ...(kind && ref.o_id != null ? { id: `${kind}:${ref.o_id}` } : {}), amira_url: itemUrlOrNull(ref.o_id) };
}

/** Curator mode: for a credited or depicted person who is a retired private duplicate, the pointer to its public namesake. */
function pointer(store: DataStore, oId: number | null): Record<string, unknown> {
  return oId != null ? duplicatePointer(store, store.getPersonByOId(oId), "person") : {};
}

export function registerChronicleTools(server: Server, tools: ToolMap): void {
  // === search_chronicles ====================================================
  tools.search_chronicles = server.registerTool(
    "search_chronicles",
    {
      title: "Search Cluster Chronicles",
      description: "Search Cluster Chronicles works (writer-in-residence essays, poems, photos, events) by chronicler, form, year, subject, place or keyword. Text-only hits include snippets.",
      annotations: READ_ONLY,
      inputSchema: schemaOnce("search_chronicles:in", () => z.strictObject({
        keyword: textParam().optional()
          .describe("Every word must occur in the title, abstract or text; quote a phrase to match it exactly"),
        person: textParam().optional().describe("A chronicler, other credited person or person depicted; either name order works"),
        form: z.string().max(100).optional().describe(`Form: ${FORMS}`),
        subject: textParam().optional().describe("Subject, partial"),
        place: textParam().optional().describe("Place at any level ('Kenya' includes Kakamega) or a venue, partial"),
        language: textParam().optional().describe("Name or ISO code"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Earliest year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Latest year"),
        limit: LIMIT.schema,
        offset: offsetParam,
      })),
    },
    async (args: SearchArgs) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", INVALID_YEAR_RANGE);
      const store = callStore();
      const { limit, echo } = LIMIT.resolve(args.limit);
      const offset = capOffset(args.offset);
      for (const key of ["person", "subject", "place", "language"] as const) {
        if (args[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
      }
      const { keyword, person, form, subject, place, language, year_from, year_to } = args;
      const parsed = keyword ? parseKeyword(keyword) : null;
      const query = parsed && !emptyKeyword(parsed) ? parsed : null;
      const matchesPlace = place ? placeMatcher(store, place, "any") : null;
      const curator = config.access === "curator";
      /** Matched only in the public text, or (curator mode) only in a private one. */
      const textOnly = new Set<number>();
      const restrictedOnly = new Set<number>();
      const filtered = store.chronicles.filter((c) => {
        if (query) {
          const meta = [c.title, ...c.alt_titles, allowDescriptive() ? c.abstract : null, allowDescriptive() ? c.description : null];
          if (!keywordMatches(query, meta)) {
            if (allowFullText() && c.text && keywordMatches(query, [...meta, c.text])) textOnly.add(c.o_id);
            else if (curator && allowFullText() && c.restricted?.fulltext && keywordMatches(query, [...meta, c.restricted.fulltext])) restrictedOnly.add(c.o_id);
            else return false;
          }
        }
        if (year_from !== undefined && (c.year ?? -Infinity) < year_from) return false;
        if (year_to !== undefined && (c.year ?? Infinity) > year_to) return false;
        if (form && !formMatches(c, form)) return false;
        if (person && !chronicleCredits(c).some((p) => personMatches(p.name, person))) return false;
        if (subject && !c.subjects.some((s) => containsCI(s.label, subject))) return false;
        if (matchesPlace && place && !c.places.some((p) => matchesPlace(p) || containsCI(p.label, place))) return false;
        if (language && !store.languageIndex.matches(c.languages, language)) return false;
        return true;
      });
      // Newest residency first; within one, the chronicler's own numbering.
      filtered.sort((a, b) => (b.date ?? "").slice(0, 4).localeCompare((a.date ?? "").slice(0, 4)) ||
        (a.number ?? Infinity) - (b.number ?? Infinity) || (a.date ?? "").localeCompare(b.date ?? "") || a.o_id - b.o_id);

      const didYouMean = !filtered.length && guidanceEnabled() ? chronicleDidYouMean(store, args) : [];
      const summary = (c: ChronicleRec) => ({ ...chronicleSummary(c), ...restrictedTextFlag(c) });
      const page = pageOf(filtered, offset, limit,
        (c) => textOnly.has(c.o_id) && keyword
          ? { ...summary(c), matched_in: "text", text_snippet: matchSnippet(c.text, keyword) }
          : restrictedOnly.has(c.o_id) && keyword
            ? { ...summary(c), matched_in: "restricted_text", text_snippet: matchSnippet(c.restricted?.fulltext, keyword) }
            : summary(c),
        { ...echo, ...filtersEcho(args as Record<string, unknown>), ...(didYouMean.length ? { did_you_mean: didYouMean } : {}) });
      return textResult({ ...page, ...emptySearchHint(filtered.length, args as Record<string, unknown>), ...pastEndHint(page) });
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
        id: idParam(1000).describe("Id from search_chronicles, e.g. 50109, or chronicle:50109"),
        include_text: z.boolean().optional().describe("Default false — set true to include the full text of an essay or poem"),
        ...textWindowParams,
      })),
    },
    async ({ id, include_text, text_offset, text_max_chars }) => {
      const store = callStore();
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
              people: c.people.map((p) => ({ name: p.name, role: p.role, amira_url: itemUrlOrNull(p.o_id), ...pointer(store, p.o_id) })),
              depicts: refLinks(c.depicts).map((r) => ({ ...r, ...pointer(store, r.omeka_id) })),
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
        ...restrictedTextFlag(c),
        amira_url: itemUrl(c.o_id),
      });
    },
  );
}
