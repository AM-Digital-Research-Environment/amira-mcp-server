// A second, deliberately naive implementation of accent-insensitive match
// offsets: a full per-character map from folded units back to the original
// string. test/unit/properties.test.mjs uses it as an oracle for
// foldedMatches (src/text.ts), whose sparse shift index is the one the server
// ships. Moved here from src/text.ts, where nothing but that test used it.

/**
 * Original UTF-16 offsets of the folded matches of `needle` in `text`,
 * including decomposed accents and surrogate pairs: at most `limit`, starting
 * at or after original offset `from`. `fold` is the server's fold (lib.fold).
 *
 * Each character is folded on its own: `fold(char)` has the length of the
 * server's mark-stripped character, because NFD has removed the only
 * expanding lowercase mapping (İ); only contextual lowercase mappings (Greek
 * final sigma) differ from folding the whole text, and the property test's
 * fragments hold none.
 */
export function foldedRanges(fold, text, needle, limit = 20, from = 0) {
  const query = fold(needle);
  if (!query) return [];
  let normalized = "";
  const starts = [], ends = [];
  let offset = 0;
  let baseUnits = 0; // index of the first folded unit of the last character that produced any
  for (const char of text) {
    const folded = fold(char);
    if (folded) baseUnits = ends.length;
    for (let i = 0; i < folded.length; i++) { starts.push(offset); ends.push(offset + char.length); }
    // A mark that folds away belongs to the preceding character: every unit that
    // character produced (œ → "oe") now ends after the mark, as in foldedMatches.
    if (!folded) for (let i = baseUnits; i < ends.length; i++) ends[i] = offset + char.length;
    normalized += folded;
    offset += char.length;
  }
  const result = [];
  let cursor = 0;
  while (result.length < limit) {
    const index = normalized.indexOf(query, cursor);
    if (index < 0) break;
    const start = starts[index];
    if (start >= from) result.push({ start, end: ends[index + query.length - 1] });
    cursor = index + query.length;
  }
  return result;
}
