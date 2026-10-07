// Diacritic-insensitive text matching (one definition, used by every keyword
// comparison in the tool layer).
//
// WHY: the collection is francophone-Africa-heavy and its authority records are
// not consistently accented against the free text. Before v1.7.0 a plain
// `toLowerCase().includes()` made the right spelling depend on which tool you
// asked — measured on the bundled snapshot:
//
//   keyword "Côte d'Ivoire" -> search_research_items 0 / list_subjects 1
//   keyword "Cote d'Ivoire" -> search_research_items 1 / list_subjects 0
//
// A model has no way to know which form a given corpus stores, so it silently
// got nothing. Every comparison now folds BOTH sides: NFD-decompose, drop the
// combining marks, lowercase.
//
// PERFORMANCE: folding a 95,000-char publication full text costs three passes
// and three allocations, and the same full texts and transcripts are re-scanned
// for every term of every query. Results are therefore memoised above
// LARGE_TEXT. The cache is keyed by the string itself — the snapshot already
// holds those strings alive, so the only extra cost is the folded copy of texts
// that were actually searched — and it is cleared when a refresh swaps the
// snapshot (see data.ts).

// U+0300–U+036F, the combining-diacritic block NFD decomposition produces.
const COMBINING_MARKS = /[̀-ͯ]/g;

// Typographic variants that NFD leaves alone. The publication metadata alone
// holds 517 curly apostrophes against 182 straight ones, so "Sankara's Agenda"
// found nothing while "Sankara’s Agenda" found 12. Ligatures and the sharp s
// expand (œ → oe, ß → ss); the offset helpers below already handle width changes.
const TYPOGRAPHIC: Record<string, string> = {
  "’": "'", "‘": "'", "ʼ": "'", "´": "'", "`": "'", "′": "'", "‛": "'",
  "“": '"', "”": '"', "„": '"', "«": '"', "»": '"', "″": '"', "‟": '"',
  "‐": "-", "‑": "-", "‒": "-", "–": "-", "—": "-", "―": "-", "−": "-",
  "\u00a0": " ", "\u202f": " ", "\u2009": " ",
  "œ": "oe", "Œ": "OE", "æ": "ae", "Æ": "AE", "ß": "ss", "ẞ": "SS",
};
const TYPOGRAPHIC_RE = new RegExp(`[${Object.keys(TYPOGRAPHIC).join("")}]`, "g");

/** Normalise typographic variants, NFD, drop combining marks — but no lowercasing.
 * The mapping runs before NFD, so a spacing accent (´) reads as an apostrophe, and
 * again after it, so a ligature that only appears once its accent is split off
 * (precomposed Ǽ → Æ + ◌́) folds like the plain one: composed and decomposed text
 * must fold identically. */
function stripMarks(s: string): string {
  const map = (t: string) => t.replace(TYPOGRAPHIC_RE, (c) => TYPOGRAPHIC[c]!);
  return map(map(s).normalize("NFD").replace(COMBINING_MARKS, ""));
}

/** Lowercase + strip diacritics + normalise quotes, dashes and ligatures. */
export function fold(s: string): string {
  return stripMarks(s).toLowerCase();
}

/** Above this length a haystack is worth memoising (transcripts, full text). */
const LARGE_TEXT = 2_000;

const foldedCache = new Map<string, string>();
interface OffsetShift { start: number; end: number; original: number; delta: number }
const offsetCache = new Map<string, OffsetShift[]>();

// Store only characters whose normalization changes UTF-16 length. Most texts
// need a handful of shifts, rather than two offsets for every character.
function originalStart(text: string, index: number): number {
  let shifts = offsetCache.get(text);
  if (!shifts) {
    shifts = [];
    let delta = 0;
    for (const match of text.matchAll(/[^\u0000-\u007f]/gu)) {
      const char = match[0];
      const width = stripMarks(char).length;
      if (width === char.length) continue;
      const start = match.index - delta;
      delta += char.length - width;
      shifts.push({ start, end: start + width, original: match.index, delta });
    }
    offsetCache.set(text, shifts);
  }
  let lo = 0, hi = shifts.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (shifts[mid]!.end <= index) lo = mid + 1;
    else hi = mid;
  }
  const next = shifts[lo];
  if (next && next.start <= index) return next.original;
  return index + (lo ? shifts[lo - 1]!.delta : 0);
}

/** `fold`, memoised for large haystacks. Needles should use `fold` directly. */
export function foldCached(s: string): string {
  if (s.length < LARGE_TEXT) return fold(s);
  const hit = foldedCache.get(s);
  if (hit !== undefined) return hit;
  const folded = fold(s);
  foldedCache.set(s, folded);
  return folded;
}

/** Drop memoised folds — call when the snapshot behind them is replaced. */
export function clearFoldCache(): void {
  foldedCache.clear();
  offsetCache.clear();
}

/**
 * Index of `needle` in `haystack`, accent- and case-insensitively, in terms of
 * the ORIGINAL string's offsets — or -1.
 *
 * Folding usually preserves length (a precomposed "é" folds to "e"), but not
 * always: text already in NFD form contracts, and a few lowercase mappings
 * expand. When the lengths differ the folded offset would slice the original in
 * the wrong place, so use a sparse index of normalization length changes.
 */
export function foldedIndexOf(haystack: string, needle: string): number {
  const folded = foldCached(haystack);
  const index = folded.indexOf(fold(needle));
  if (index < 0 || !needle) return index;
  return originalStart(haystack, index);
}

/** Original end offset of the character that produced folded position `index`,
 * including a surrogate pair and any combining marks that folded away. */
function originalEnd(text: string, index: number): number {
  const start = originalStart(text, index);
  let end = start + ((text.codePointAt(start) ?? 0) > 0xffff ? 2 : 1);
  while (end < text.length && /[̀-ͯ]/.test(text[end]!)) end++;
  return end;
}

/**
 * Every accent-insensitive match of `needle` as ORIGINAL offsets, paged without
 * rebuilding a per-character index: the folded copy and the sparse offset index
 * are both memoised per text. `total` counts every match up to `cap`.
 */
export function foldedMatches(
  text: string, needle: string, opts: { skip?: number; take?: number; cap?: number } = {},
): { total: number; capped: boolean; ranges: { start: number; end: number }[] } {
  const query = fold(needle);
  const cap = opts.cap ?? 100_000;
  if (!query) return { total: 0, capped: false, ranges: [] };
  const folded = foldCached(text);
  const skip = opts.skip ?? 0, take = opts.take ?? Infinity;
  const ranges: { start: number; end: number }[] = [];
  let total = 0, cursor = 0;
  for (;;) {
    const index = folded.indexOf(query, cursor);
    if (index < 0) break;
    if (total >= skip && ranges.length < take) {
      ranges.push({ start: originalStart(text, index), end: originalEnd(text, index + query.length - 1) });
    }
    total++;
    if (total >= cap) return { total, capped: true, ranges };
    cursor = index + query.length;
  }
  return { total, capped: false, ranges };
}

/** Original UTF-16 offsets, including decomposed accents and surrogate pairs. */
export function foldedRanges(text: string, needle: string, limit = 20, from = 0): { start: number; end: number }[] {
  const query = fold(needle);
  if (!query) return [];
  let normalized = "";
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  let baseUnits = 0; // index of the first folded unit of the last character that produced any
  for (const char of text) {
    const folded = stripMarks(char);
    if (folded) baseUnits = ends.length;
    for (let i = 0; i < folded.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    // A mark that folds away belongs to the preceding character: every unit that
    // character produced (œ → "oe") now ends after the mark, as in foldedMatches.
    if (!folded) for (let i = baseUnits; i < ends.length; i++) ends[i] = offset + char.length;
    normalized += folded;
    offset += char.length;
  }
  // Lowercase the whole sequence so contextual mappings (Greek final sigma)
  // agree with fold(). NFD has removed the only expanding lowercase mapping, İ.
  normalized = normalized.toLowerCase();
  const result: { start: number; end: number }[] = [];
  let cursor = 0;
  while (result.length < limit) {
    const index = normalized.indexOf(query, cursor);
    if (index < 0) break;
    const start = starts[index]!;
    if (start >= from) result.push({ start, end: ends[index + query.length - 1]! });
    cursor = index + query.length;
  }
  return result;
}
