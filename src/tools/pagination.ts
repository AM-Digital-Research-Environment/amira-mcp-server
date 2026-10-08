import { CHARACTER_LIMIT } from "./responses.js";
import { guidanceEnabled } from "../guidance.js";
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

// --- pagination (slice first, map only the page) ------------------------------

export interface Page<T> {
  count: number;
  total_matches: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  /** True when the page stopped short of `limit` to stay within PAGE_CHAR_BUDGET. */
  response_limited?: boolean;
  results: T[];
  [k: string]: unknown;
}

/**
 * Serialized size budget for one page of results. Hosts move large tool results
 * out of the conversation — Claude Code stores any text result over 50,000
 * characters in a file — and a full page of 100 research items measured 59,808.
 * The budget holds for any future snapshot, whatever a record's length.
 */
export const PAGE_CHAR_BUDGET = 40_000;

/** Paginate `all`, mapping ONLY the returned page through `toSummary`, and stop
 * early (with `response_limited`) when the page would exceed the budget. */
export function pageOf<T, S>(
  all: T[],
  offset: number,
  limit: number,
  toSummary: (t: T) => S,
  extra: Record<string, unknown> = {},
): Page<S> {
  const total = all.length;
  const results: S[] = [];
  let chars = 0;
  let limited = false;
  for (const record of all.slice(offset, offset + limit)) {
    const summary = toSummary(record);
    const size = JSON.stringify(summary).length + 1;
    if (results.length && chars + size > PAGE_CHAR_BUDGET) {
      limited = true;
      break;
    }
    results.push(summary);
    chars += size;
  }
  const hasMore = offset + results.length < total;
  const env: Page<S> = {
    ...extra,
    count: results.length,
    total_matches: total,
    offset,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + results.length;
  if (limited) env.response_limited = true;
  return env;
}

/** Echo only the filters the caller actually passed (no null noise — D10).
 * Pagination knobs are not filters, so limit/offset never appear here. */
export function filtersEcho(filters: Record<string, unknown>): Record<string, unknown> {
  const set = Object.fromEntries(
    Object.entries(filters).filter(([k, v]) => v !== undefined && v !== null && v !== "" && k !== "limit" && k !== "offset"),
  );
  return Object.keys(set).length ? { filters: set } : {};
}

/**
 * `{ hint }` for a filtered search that found nothing: a bare empty list reads
 * as "the collection holds nothing", when one filter may be excluding
 * everything. Guidance, so AMIRA_GUIDANCE=off withholds it; a search that
 * matches, or one without filters, never carries it.
 */
export function emptySearchHint(total: number, filters: Record<string, unknown>): Record<string, unknown> {
  if (total > 0 || !guidanceEnabled() || !("filters" in filtersEcho(filters))) return {};
  return { hint: "No record matches all these filters. Drop or broaden them one at a time to find the one that excludes everything." };
}
