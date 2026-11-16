// Hints for list results that came back empty for a reason the caller can fix.
import { guidanceEnabled } from "../guidance.js";
import { parseTypedId } from "../typedIds.js";

/** `{ hint }` for a resolve_entity query that matched nothing because of its form: an
 * unknown typed id, or several queries in one string ("A; B"). `{}` otherwise. */
export function unresolvedQueryHint(query: string): Record<string, unknown> {
  if (!guidanceEnabled()) return {};
  const typed = parseTypedId(query);
  if (typed) return { hint: `Unknown id: no ${typed.kind} has the id '${typed.key}'. Search by name instead, or check the id.` };
  if (/[;|\n]/.test(query)) {
    return { hint: "resolve_entity takes one query; this looks like several. Resolve each name in its own call." };
  }
  return {};
}

/** `{ hint }` when the page is empty only because `offset` lies past the last match; otherwise `{}`. */
export function pastEndHint(page: { count: number; total_matches: number; offset: number }): Record<string, unknown> {
  if (page.count > 0 || page.total_matches === 0 || !guidanceEnabled()) return {};
  return { hint: `offset ${page.offset} is past the end: there are ${page.total_matches} matches. Use an offset below ${page.total_matches}.` };
}
