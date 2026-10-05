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

/** Lowercase + strip diacritics, for accent-insensitive comparison. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS, "").toLowerCase();
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
      const width = char.normalize("NFD").replace(COMBINING_MARKS, "").length;
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

/** Original UTF-16 offsets, including decomposed accents and surrogate pairs. */
export function foldedRanges(text: string, needle: string, limit = 20, from = 0): { start: number; end: number }[] {
  const query = fold(needle);
  if (!query) return [];
  let normalized = "";
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const folded = char.normalize("NFD").replace(COMBINING_MARKS, "");
    for (let i = 0; i < folded.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    if (!folded && ends.length) ends[ends.length - 1] = offset + char.length;
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
