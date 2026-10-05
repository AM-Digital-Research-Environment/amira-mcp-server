import { CHARACTER_LIMIT } from "./responses.js";
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
