// Cross-cutting helpers shared by every tool module: result formatting (compact
// JSON — D10), input capping, paginate-then-map, text matching, large-text
// windowing (transcripts + publication full text), and the summary/ref mappers
// that attach a citable `amira_url` to every record.
import type { DataStore } from "../data.js";
import { UNIVERSITY_LABELS } from "../data.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { fold, foldCached, foldedIndexOf } from "../text.js";
import { allowFullText, allowStructured, exposureMessage } from "../exposure.js";
import type {
  LinkedRef,
  PersonRec,
  PodcastRec,
  ProjectRec,
  PublicationRec,
  ResearchItemRec,
  SectionRec,
  VideoRec,
} from "../types.js";

export type Server = import("@modelcontextprotocol/server").McpServer;

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// --- result / annotation helpers --------------------------------------------

export function annotate(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/** Standard tool result: COMPACT JSON text (pretty-printing cost ~24% of every
 * response pre-1.0) plus structuredContent for structured-data clients. */
export function textResult(payload: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Uniform structured error (report §error-handling): `{ error: { code, message,
 * suggested_tool?, available_values? } }`. `code` is a stable machine token
 * (`not_found`, `invalid_id`, …); `message` stays human-readable.
 */
export function errorResult(
  code: string,
  message: string,
  extra: { suggested_tool?: string; available_values?: unknown[] } = {},
): ReturnType<typeof textResult> {
  const error: Record<string, unknown> = { code, message };
  if (extra.suggested_tool) error.suggested_tool = extra.suggested_tool;
  if (extra.available_values && extra.available_values.length) error.available_values = extra.available_values;
  return textResult({ error });
}

// --- input capping (lenient clamp, not rejection) ---------------------------

export function capLimit(v: number | undefined, def: number, max: number): number {
  if (v === undefined || Number.isNaN(v)) return def;
  return Math.max(1, Math.min(Math.floor(v), max));
}

export function capOffset(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.max(0, Math.floor(v));
}

/**
 * Surface a capped limit (report §effective-limit): when the caller asks for
 * more than `max`, echo both the request and what was actually applied. Returns
 * `{}` when the request was honoured, so uncapped responses stay noise-free.
 */
export function limitEcho(requested: number | undefined, max: number, effective: number): Record<string, unknown> {
  if (requested !== undefined && Number.isFinite(requested) && Math.floor(requested) > max) {
    return { requested_limit: Math.floor(requested), effective_limit: effective };
  }
  return {};
}

export function capText(text: string, limit = CHARACTER_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit), truncated: true };
}

// --- large-text windowing (transcripts, publication full text) ---------------
//
// One implementation behind get_podcast/get_video (`transcript`),
// get_publication (`fulltext`) and the ChatGPT `fetch` adapter, so the opt-in +
// offset/max paging contract can never drift between tools again (the v1.4.2
// lesson). Content is exposure-gated: under AMIRA_EXPOSURE below `full`, the
// existence flags stay but the text itself is reported as access-disabled.

export type WindowField = "transcript" | "fulltext";

export interface WindowOpts {
  include?: boolean;
  offset?: number;
  maxChars?: number;
  /**
   * Chars still available after the surrounding document body (the `fetch`
   * adapter, which wraps the window in a metadata header and then caps the
   * whole thing). Sizing the slice against what is LEFT keeps
   * `<field>_returned_chars` honest; capping the concatenation afterwards
   * trimmed the tail silently and made `offset + returned_chars` skip exactly
   * the header's worth of characters on the next page.
   */
  budget?: number;
}

/** Below this many free chars an appended window is not worth emitting. */
const MIN_WINDOW = 200;

function windowSlice(text: string, opts: WindowOpts): { slice: string; offset: number } {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const max = Math.max(
    1,
    Math.min(Math.floor(opts.maxChars ?? CHARACTER_LIMIT), CHARACTER_LIMIT, opts.budget ?? CHARACTER_LIMIT),
  );
  return { slice: text.slice(offset, offset + max), offset };
}

/**
 * Detail-tool shape: `has_<field>` + `<field>_length` always; the windowed text
 * plus offset/returned/truncated when opted in; a paging hint (or an
 * access-disabled marker under restricted exposure) when not.
 */
export function textWindowFields(field: WindowField, text: string | null, opts: WindowOpts): Record<string, unknown> {
  const total = text?.length ?? 0;
  const has = total > 0;
  if (!allowFullText()) {
    return { [`has_${field}`]: has, [`${field}_length`]: total, ...(has ? { [`${field}_access`]: "disabled" } : {}) };
  }
  if (!opts.include) {
    return {
      [`has_${field}`]: has,
      [`${field}_length`]: total,
      ...(has
        ? { [`${field}_hint`]: `Set include_${field}=true for the text (page long ones with ${field}_offset / ${field}_max_chars).` }
        : {}),
    };
  }
  const { slice, offset } = windowSlice(text ?? "", opts);
  return {
    [`has_${field}`]: has,
    [field]: has ? slice : null,
    [`${field}_length`]: total,
    [`${field}_offset`]: offset,
    [`${field}_returned_chars`]: slice.length,
    [`${field}_truncated`]: offset + slice.length < total || undefined,
  };
}

/**
 * Fetch-adapter shape: the text to APPEND to the document body (or an omission
 * marker) plus the same paging metadata, mirroring textWindowFields.
 */
export function textWindowAppend(
  field: WindowField,
  label: string,
  text: string | null,
  opts: WindowOpts,
): { append: string | null; meta: Record<string, unknown> } {
  const total = text?.length ?? 0;
  const has = total > 0;
  if (!allowFullText()) {
    return {
      append: has ? `\n[${label} exists (${total} chars) but access is disabled by the server's exposure policy.]` : null,
      meta: { [`has_${field}`]: has, [`${field}_included`]: false, [`${field}_length`]: total, ...(has ? { [`${field}_access`]: "disabled" } : {}) },
    };
  }
  if (!opts.include || !has) {
    return {
      append: has
        ? `\n[${label} omitted (${total} chars) — call fetch again with include_${field}=true to append it (page long ones with ${field}_offset / ${field}_max_chars).]`
        : null,
      meta: {
        [`has_${field}`]: has,
        [`${field}_included`]: false,
        [`${field}_length`]: total,
        ...(has
          ? { [`${field}_hint`]: `Set include_${field}=true to append the ${label.toLowerCase()} (page long ones with ${field}_offset / ${field}_max_chars).` }
          : {}),
      },
    };
  }
  // Asked for, but the document header already spent the caller's max_chars.
  // Say so rather than appending a slice that capText would then trim.
  if (opts.budget !== undefined && opts.budget < MIN_WINDOW) {
    return {
      append: `\n[${label} exists (${total} chars) but does not fit within max_chars — raise max_chars, or read it from the detail tool.]`,
      meta: {
        [`has_${field}`]: true,
        [`${field}_included`]: false,
        [`${field}_length`]: total,
        [`${field}_hint`]: `Raise max_chars (the record's metadata alone filled it) to append the ${label.toLowerCase()}.`,
      },
    };
  }
  const { slice, offset } = windowSlice(text ?? "", opts);
  return {
    append: `\n${label}:\n${slice}`,
    meta: {
      [`has_${field}`]: true,
      [`${field}_included`]: true,
      [`${field}_length`]: total,
      [`${field}_offset`]: offset,
      [`${field}_returned_chars`]: slice.length,
      [`${field}_truncated`]: offset + slice.length < total || undefined,
    },
  };
}

/** Structured refusal when an opt-in text is hidden by the exposure level. */
export function textAccessDisabledResult(field: WindowField): ReturnType<typeof textResult> {
  return errorResult("text_access_disabled", `The ${field} is hidden at this exposure level. ${exposureMessage("full")}`);
}

/** Structured refusal for a whole tool/filter gated by the exposure level. */
export function exposureRestrictedResult(needs: "descriptive" | "structured" | "full", what: string): ReturnType<typeof textResult> {
  return errorResult("exposure_restricted", `${what} is not available: ${exposureMessage(needs)}`);
}

// --- pagination (slice first, map only the page) ------------------------------

export interface Page<T> {
  count: number;
  total_matches: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  results: T[];
  [k: string]: unknown;
}

/** Paginate `all`, mapping ONLY the returned page through `toSummary`. */
export function pageOf<T, S>(
  all: T[],
  offset: number,
  limit: number,
  toSummary: (t: T) => S,
  extra: Record<string, unknown> = {},
): Page<S> {
  const total = all.length;
  const slice = all.slice(offset, offset + limit);
  const hasMore = offset + slice.length < total;
  const env: Page<S> = {
    ...extra,
    count: slice.length,
    total_matches: total,
    offset,
    has_more: hasMore,
    results: slice.map(toSummary),
  };
  if (hasMore) env.next_offset = offset + limit;
  return env;
}

/** Echo only the filters the caller actually passed (no null noise — D10).
 * Pagination knobs are not filters, so limit/offset never appear here. */
export function filtersEcho(filters: Record<string, unknown>): Record<string, unknown> {
  const set = Object.fromEntries(
    Object.entries(filters).filter(([k, v]) => v !== undefined && v !== null && k !== "limit" && k !== "offset"),
  );
  return Object.keys(set).length ? { filters: set } : {};
}

// --- text matching ----------------------------------------------------------

// Every comparison is accent- AND case-insensitive (src/text.ts): the same
// concept is spelled "Côte d'Ivoire" in the subject authority and "Cote
// d'Ivoire" in item titles, and a model cannot know which corpus stores which.

export function containsCI(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return foldCached(haystack).includes(fold(needle));
}

export function anyContainsCI(arr: (string | null | undefined)[] | undefined, needle: string): boolean {
  if (!arr) return false;
  const n = fold(needle);
  return arr.some((s) => !!s && foldCached(s).includes(n));
}

export function equalsCI(a: string | null | undefined, b: string): boolean {
  return !!a && fold(a) === fold(b);
}

export const refLabels = (refs: LinkedRef[] | undefined): string[] => (refs ?? []).map((r) => r.label);

/** Truncate free text to a short preview for list/summary views. */
export function brief(text: string | null | undefined, n = 280): string | null {
  if (!text) return null;
  return text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`;
}

/**
 * A short context window around the first occurrence of `query` in `text`, with
 * ellipses where it was clipped — so a transcript hit shows WHY it matched
 * without shipping the whole transcript (report §5). Returns null when absent.
 */
export function matchSnippet(text: string | null | undefined, query: string, radius = 140): string | null {
  if (!text || !query) return null;
  const i = foldedIndexOf(text, query);
  if (i === -1) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + query.length + radius);
  let snip = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snip = `…${snip}`;
  if (end < text.length) snip = `${snip}…`;
  return snip;
}

/**
 * Classify a record date against the present (report §6): a date in the future
 * is `scheduled` (e.g. an episode page published ahead of release), an empty or
 * unparseable date is `unknown`, everything else is `published`.
 */
export function dateStatus(date: string | null | undefined): "published" | "scheduled" | "unknown" {
  if (!date) return "unknown";
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "unknown";
  return t > Date.now() ? "scheduled" : "published";
}

// --- entity summaries (search results) -----------------------------------------

/** "1953" / "1950–1960" from an item's content-date year range. */
export function yearLabel(it: ResearchItemRec): string | null {
  if (it.year_min == null) return null;
  return it.year_max != null && it.year_max !== it.year_min ? `${it.year_min}–${it.year_max}` : String(it.year_min);
}

/** Search-result summary of a research item. */
export function itemSummary(it: ResearchItemRec, store: DataStore): Record<string, unknown> {
  const project = store.projectOf(it);
  return {
    id: String(it.o_id),
    omeka_id: it.o_id,
    title: it.title,
    type: it.type,
    date: yearLabel(it),
    // Relational metadata (project, people, subjects, places) is structured-level.
    ...(allowStructured()
      ? {
          project: it.project?.label ?? null,
          project_omeka_id: project?.o_id ?? null,
          university: UNIVERSITY_LABELS[it.university],
          contributors: it.contributors.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`),
          subjects: refLabels(it.subjects),
          place: it.places[0]?.label ?? null,
        }
      : {}),
    amira_url: itemUrl(it.o_id),
  };
}

/** SLIM item reference for profile/related views (detail is one get away). */
export function itemRef(it: ResearchItemRec): Record<string, unknown> {
  return {
    id: String(it.o_id),
    omeka_id: it.o_id,
    title: it.title,
    type: it.type,
    date: yearLabel(it),
    amira_url: itemUrl(it.o_id),
  };
}

export function projectSummary(p: ProjectRec, itemCount?: number): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    name: p.name,
    university: UNIVERSITY_LABELS[p.university],
    research_sections: refLabels(p.sections),
    principal_investigators: refLabels(p.pis),
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
    amira_url: itemUrl(p.o_id),
  };
}

export function personSummary(p: PersonRec): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    name: p.name,
    affiliations: refLabels(p.affiliations),
    amira_url: itemUrl(p.o_id),
  };
}

/**
 * Funding phase from a section's date range: the cluster redefined its sections
 * between AM 1.0 (2019–2025) and AM 2.0 (2026–2032); the synthetic "External"
 * grouping is not a phase.
 */
export function fundingPhase(s: SectionRec): string | null {
  if (equalsCI(s.name, "External")) return null;
  const year = Number((s.date.start ?? "").slice(0, 4));
  if (!Number.isFinite(year) || year === 0) return null;
  return year >= 2026 ? "AM 2.0 (2026–2032)" : "AM 1.0 (2019–2025)";
}

export function sectionSummary(
  s: SectionRec,
  counts: { projectCount?: number; itemCount?: number } = {},
): Record<string, unknown> {
  return {
    name: s.name,
    funding_phase: fundingPhase(s),
    date: s.date,
    principal_investigators: refLabels(s.pis),
    member_count: s.members.length,
    id: String(s.o_id),
    omeka_id: s.o_id,
    ...(counts.projectCount !== undefined ? { project_count: counts.projectCount } : {}),
    ...(counts.itemCount !== undefined ? { item_count: counts.itemCount } : {}),
    description: brief(s.description),
    website: s.url,
    amira_url: itemUrl(s.o_id),
  };
}

export function publicationSummary(p: PublicationRec): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    title: p.title,
    type: p.type,
    year: p.year,
    // Authors and venue are structured-level metadata.
    ...(allowStructured() ? { authors: refLabels(p.authors), venue: p.venue } : {}),
    doi: p.doi,
    // The publication's own canonical link (DOI, else repository permalink).
    url: p.doi ?? p.urls[0] ?? null,
    has_fulltext: !!p.fulltext,
    amira_url: itemUrl(p.o_id),
  };
}

export function podcastSummary(p: PodcastRec): Record<string, unknown> {
  return {
    id: p.o_id,
    omeka_id: p.o_id,
    title: p.title,
    episode: p.episode,
    date: p.date,
    date_status: dateStatus(p.date),
    ...(allowStructured()
      ? { series: p.series?.label ?? null, people: p.people.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`) }
      : {}),
    url: p.url,
    has_transcript: !!p.transcript,
    amira_url: itemUrl(p.o_id),
  };
}

export function videoSummary(v: VideoRec): Record<string, unknown> {
  return {
    id: v.o_id,
    omeka_id: v.o_id,
    title: v.title,
    date: v.date,
    date_status: dateStatus(v.date),
    ...(allowStructured() ? { playlists: refLabels(v.playlists), speakers: v.speakers.map((c) => c.name) } : {}),
    url: v.url,
    has_transcript: !!v.transcript,
    amira_url: itemUrl(v.o_id),
  };
}

export function subjectEntry(label: string, oId: number | null, count: number): Record<string, unknown> {
  return { subject: label, ...(oId != null ? { id: String(oId), omeka_id: oId } : {}), item_count: count, amira_url: itemUrlOrNull(oId) };
}
