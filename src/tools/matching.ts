import { fold, foldCached, foldedIndexOf } from "../text.js";
import type { LinkedRef } from "../types.js";
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
