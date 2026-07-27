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
}

/**
 * Index of `needle` in `haystack`, accent- and case-insensitively, in terms of
 * the ORIGINAL string's offsets — or -1.
 *
 * Folding usually preserves length (a precomposed "é" folds to "e"), but not
 * always: text already in NFD form contracts, and a few lowercase mappings
 * expand. When the lengths differ the folded offset would slice the original in
 * the wrong place, so fall back to a plain case-insensitive search.
 */
export function foldedIndexOf(haystack: string, needle: string): number {
  const folded = foldCached(haystack);
  if (folded.length === haystack.length) return folded.indexOf(fold(needle));
  return haystack.toLowerCase().indexOf(needle.toLowerCase());
}
