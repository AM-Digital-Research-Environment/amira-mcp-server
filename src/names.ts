// Person-name matching that is order-independent and diacritic-insensitive.
//
// People are stored "Surname, Forename" (e.g. "Baumann, Oliver"), but users
// (and other systems) often write "Forename Surname" ("Oliver Baumann"). These
// helpers let a query in either order — and with or without accents/hyphens —
// match the stored form, so person search/lookup/filtering "just works".

import { fold } from "./text.js";

/** Lowercase, accent-stripped, comma/dot/hyphen-split tokens of a name. */
export function nameTokens(name: string): string[] {
  return fold(name) // shared with every other keyword comparison (src/text.ts)
    .replace(/[.,;'\-]/g, " ") // commas, dots, hyphens, apostrophes -> space
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Order-independent identity key — "Baumann, Oliver" and "Oliver Baumann" share it. */
export function nameKey(name: string): string {
  return [...nameTokens(name)].sort().join(" ");
}

/** True if two names denote the same person regardless of token order/accents. */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = nameKey(a);
  return ka.length > 0 && ka === nameKey(b);
}

/**
 * Fuzzy, order-independent match for search/filter: every token of `query` must
 * match a token of `candidate` (equal or prefix). So "Oliver Baumann",
 * "Baumann, Oliver", "Baumann" and "Oliver" all match "Baumann, Oliver".
 */
export function nameMatchesQuery(candidate: string | null | undefined, query: string): boolean {
  if (!candidate) return false;
  const ct = nameTokens(candidate);
  const qt = nameTokens(query);
  if (qt.length === 0 || ct.length === 0) return false;
  return qt.every((q) => ct.some((c) => c === q || c.startsWith(q)));
}

/**
 * The person filter every tool applies to a credited name: an order-independent
 * token match ("Oliver Baumann" = "Baumann, Oliver") or, for partial input, an
 * accent-insensitive substring. One definition instead of seven copies.
 */
export function personMatches(candidate: string | null | undefined, query: string): boolean {
  if (!candidate) return false;
  return nameMatchesQuery(candidate, query) || fold(candidate).includes(fold(query.trim()));
}

// --- near misses ---------------------------------------------------------------
//
// A misspelt name matches nobody: "Rudigr Seeman" returned an empty list from
// search_persons and resolve_entity, and finding "Seesemann, Rüdiger" was left to
// the model. These helpers rank the authority names a query is a typo away from,
// so the tools can offer them when a person search comes back empty.

/**
 * Edit distance counting an adjacent transposition as one edit (optimal string
 * alignment): "rudigr" is one edit from "rudiger", "seeman" three from
 * "seesemann". Gives up once every alignment costs more than `max`, returning
 * `max + 1`.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, before[j - 2]! + 1);
      row.push(d);
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
    before = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** Edits a token pair may differ by and still read as a typo: one per three
 * characters of the longer token, so tokens under three characters must match. */
const typoTolerance = (a: string, b: string): number => Math.floor(Math.max(a.length, b.length) / 3);

/** Longest query, in tokens, that is scored; every pairing of tokens is tried. */
const MAX_QUERY_TOKENS = 6;

function nearMissScore(name: string[], query: string[]): number | null {
  if (!query.length || query.length > Math.min(name.length, MAX_QUERY_TOKENS)) return null;
  const used = new Array<boolean>(name.length).fill(false);
  let best: number | null = null;
  const pair = (i: number, edits: number, chars: number): void => {
    if (i === query.length) {
      if (best === null || edits / chars < best) best = edits / chars;
      return;
    }
    const q = query[i]!;
    for (let j = 0; j < name.length; j++) {
      if (used[j]) continue;
      const c = name[j]!;
      const tolerance = typoTolerance(q, c);
      const d = editDistance(q, c, tolerance);
      if (d > tolerance) continue;
      used[j] = true;
      pair(i + 1, edits + d, chars + Math.max(q.length, c.length));
      used[j] = false;
    }
  };
  pair(0, 0, 0);
  return best;
}

/**
 * How near a person query comes to a stored name, in either name order and
 * ignoring accents: every query token pairs with a different token of the name
 * within the typo tolerance, and the name may carry extra tokens (a middle
 * name). Returns the edits per character compared (0 = the same tokens), or
 * null when the name is not a near miss.
 */
export function nameNearMiss(candidate: string, query: string): number | null {
  return nearMissScore(nameTokens(candidate), nameTokens(query));
}

/**
 * The records whose name or a name variant is a near miss for `query`, closest
 * first (ties by name), at most `limit` of them.
 */
export function nearMissNames<T extends { name: string; alt_names?: string[] }>(records: readonly T[], query: string, limit = 5): T[] {
  const tokens = nameTokens(query);
  const scored: { record: T; score: number }[] = [];
  for (const record of records) {
    let score: number | null = null;
    for (const name of [record.name, ...(record.alt_names ?? [])]) {
      const s = nearMissScore(nameTokens(name), tokens);
      if (s !== null && (score === null || s < score)) score = s;
    }
    if (score !== null) scored.push({ record, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.record.name.localeCompare(b.record.name))
    .slice(0, limit)
    .map(({ record }) => record);
}
