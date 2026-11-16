// Core text matching shared by the query layer (researchItemQuery,
// publicationQuery, searchRanking) and the tools. No MCP types live here: the
// query modules return data and typed errors, and the tool layer renders them.
//
// Every comparison is accent- AND case-insensitive (src/text.ts): the same
// concept is spelled "Côte d'Ivoire" in the subject authority and "Cote
// d'Ivoire" in item titles, and a model cannot know which corpus stores which.
import { fold, foldCached, foldedIndexOf, foldedMatches } from "./text.js";
import { editDistance } from "./names.js";
import type { LinkedRef } from "./types.js";
import { itemUrlOrNull } from "./urls.js";

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

/**
 * The identity of a linked value: its authority id, else its FOLDED label, so
 * two unlinked spellings of one name ("Côte d'Ivoire", "Cote d'Ivoire") are one
 * value. Facets, find_related, the semantic map and the similarity
 * explanations all key on it; they once used three different label rules.
 */
export const refKey = (ref: LinkedRef): string => (ref.o_id != null ? `id:${ref.o_id}` : `label:${fold(ref.label)}`);

export interface TallyRow {
  /** The first label seen for this value. */
  label: string;
  o_id: number | null;
  /** Records carrying the value, each counted once. */
  count: number;
  /** The same count split by the field `add` was given (a corpus, a record kind). */
  by: Record<string, number>;
}

/** Distinct linked values across records, each record counted once per value. */
export class RefTally {
  private readonly counts = new Map<string, TallyRow>();
  /** Count the values one record links to (a value listed twice counts once). */
  add(refs: readonly LinkedRef[], field?: string): void {
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!ref?.label) continue;
      const key = refKey(ref);
      if (seen.has(key)) continue;
      seen.add(key);
      let row = this.counts.get(key);
      if (!row) {
        row = { label: ref.label, o_id: ref.o_id, count: 0, by: {} };
        this.counts.set(key, row);
      }
      row.count++;
      if (field) row.by[field] = (row.by[field] ?? 0) + 1;
    }
  }
  /** Every value, in first-seen order. */
  rows(): TallyRow[] {
    return [...this.counts.values()];
  }
  /** The `n` most frequent values; ties by label. */
  top(n: number): TallyRow[] {
    return this.rows().sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, n);
  }
}

/** Linked refs with their citation link: the instructions require an amira_url
 * for every person or record a reader may mention, so name lists carry these. */
export const refLinks = (refs: LinkedRef[] | undefined) =>
  (refs ?? []).map((r) => ({ label: r.label, omeka_id: r.o_id, amira_url: itemUrlOrNull(r.o_id) }));

/** A credit as one label: "Name (role)", or the name alone without a role. */
export const creditLabel = (c: { name: string; role?: string | null }): string => (c.role ? `${c.name} (${c.role})` : c.name);

/** Distinct MIME types of a record's media files. */
export function mediaTypes(media: { type: string | null }[] | undefined): string[] {
  return [...new Set((media ?? []).map((m) => m.type).filter((t): t is string => !!t))];
}

/** Truncate free text to a short preview for list/summary views. */
export function brief(text: string | null | undefined, n = 280): string | null {
  if (!text) return null;
  return text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`;
}

/** Occurrences of each anchor scanned when choosing a snippet window. */
const SNIPPET_SCAN = 50;

/**
 * A short context window around a match of `query` in `text`, with ellipses
 * where it was clipped — so a transcript hit shows WHY it matched without
 * shipping the whole transcript. A one-term query anchors on its first
 * occurrence. A multi-term query takes the window (at most `radius` wide)
 * holding the most DISTINCT terms, earliest on a tie, so the snippet shows the
 * words together rather than the first term alone (often a PDF's title page).
 * Bounded: at most SNIPPET_SCAN occurrences per term. Null when absent.
 */
export function matchSnippet(text: string | null | undefined, query: string, radius = 140): string | null {
  if (!text || !query) return null;
  const parsed = parseKeyword(query);
  const anchors = [...parsed.phrases, ...parsed.terms];
  if (anchors.length <= 1) {
    const anchor = anchors[0] ?? fold(query);
    const i = foldedIndexOf(text, anchor);
    return i === -1 ? null : clip(text, i, i + anchor.length, radius);
  }
  const hits: { start: number; end: number; term: number }[] = [];
  anchors.forEach((anchor, term) => {
    for (const r of foldedMatches(text, anchor, { take: SNIPPET_SCAN, cap: SNIPPET_SCAN }).ranges) hits.push({ ...r, term });
  });
  if (!hits.length) return null;
  hits.sort((a, b) => a.start - b.start);
  // Two pointers over the sorted hits: the span [lo, hi] at most `radius` wide
  // with the most distinct terms.
  const inWindow = new Map<number, number>();
  let best = { lo: 0, hi: 0, distinct: 0 };
  for (let lo = 0, hi = 0; hi < hits.length; hi++) {
    inWindow.set(hits[hi]!.term, (inWindow.get(hits[hi]!.term) ?? 0) + 1);
    while (hits[hi]!.start - hits[lo]!.start > radius) {
      const t = hits[lo]!.term, n = inWindow.get(t)! - 1;
      if (n) inWindow.set(t, n); else inWindow.delete(t);
      lo++;
    }
    if (inWindow.size > best.distinct) best = { lo, hi, distinct: inWindow.size };
  }
  const first = hits[best.lo]!, last = hits[best.hi]!;
  if (best.distinct === 1) return clip(text, first.start, first.end, radius);
  // Keep the snippet about as long as a one-term one: margins shrink as the span grows.
  const span = Math.max(last.end, first.end) - first.start;
  const margin = Math.max(Math.floor(radius / 2), radius - Math.floor(span / 2));
  return clip(text, first.start, Math.max(last.end, first.end), margin);
}

function clip(text: string, from: number, to: number, margin: number): string {
  const start = Math.max(0, from - margin);
  const end = Math.min(text.length, to + margin);
  let snip = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snip = `…${snip}`;
  if (end < text.length) snip = `${snip}…`;
  return snip;
}

/**
 * Classify a record date against the present: a date in the future is
 * `scheduled` (e.g. an episode page published ahead of release), an empty or
 * unparseable date is `unknown`, everything else is `published`.
 */
export function dateStatus(date: string | null | undefined): "published" | "scheduled" | "unknown" {
  if (!date) return "unknown";
  const t = Date.parse(date);
  if (Number.isNaN(t)) return "unknown";
  return t > Date.now() ? "scheduled" : "published";
}

// --- keyword queries ------------------------------------------------------------

// Function words in the collection's main languages (English, French, German,
// Portuguese). Dropped from multi-word queries so "Kunst und Architektur" does
// not require — or, in ranked search, reward — "und" (which also occurs inside
// "Urkunde"). Folded forms: "ete"/"etre"/"fur"/"uber" match the accented words.
export const STOPWORDS = new Set(
  (
    "the a an of in on at to for and or but with by from as is are was were be been which who whom whose what when " +
    "where why how do does did about into over across this that these those there here their them they our your you we it its not no " +
    "le la les un une des de du et ou mais avec par pour dans sur qui que quoi dont est sont ete etre ce ces cette aux au se sa son ses " +
    "der die das den dem des und oder ein eine einer eines einem einen im zu zur zum mit von fur auf ist sind war nicht als auch bei aus nach uber unter " +
    "os as um uma uns umas do da dos das em no na nos nas por para com ao aos pelo pela pelos pelas ou mas"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Folded content terms (>=2 chars, no stopwords, de-duplicated). */
export function tokenize(q: string): string[] {
  const toks = fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

export interface KeywordQuery {
  /** Folded "quoted phrases" — each must occur literally. */
  phrases: string[];
  /** Folded content words outside quotes — each must occur somewhere. */
  terms: string[];
}

/**
 * Parse a keyword filter. A single word keeps the old substring semantics. Several
 * words now match records containing EVERY word (in any field, any order) instead
 * of the literal phrase, which silently returned nothing for most multi-word
 * queries; a "quoted phrase" still matches literally. A query of only stopwords or
 * one-letter words falls back to the literal phrase.
 */
export function parseKeyword(query: string): KeywordQuery {
  const phrases: string[] = [];
  const rest = query.replace(/["“”„«»]([^"“”„«»]+)["“”„«»]/g, (_, phrase: string) => {
    const f = fold(phrase).trim();
    if (f) phrases.push(f);
    return " ";
  });
  const terms = tokenize(rest);
  if (!terms.length && !phrases.length) {
    // Quote marks are syntax, never content: an empty quoted keyword (`""`) is
    // an empty keyword, not a literal phrase of two quote characters.
    const literal = fold(rest).replace(QUOTES, " ").replace(/\s+/g, " ").trim();
    if (literal) phrases.push(literal);
  }
  return { phrases, terms };
}

const QUOTES = /["“”„«»]/g;

/** A keyword as one literal phrase: quote marks dropped, whitespace collapsed
 * (get_text_passages, a concordance, matches the phrase as written). */
export function literalPhrase(query: string): string {
  return query.replace(QUOTES, " ").replace(/\s+/g, " ").trim();
}

/**
 * The keyword predicate of the list tools and search_projects: the same
 * word semantics as search_research_items (every word somewhere among the
 * fields, a "quoted phrase" literally). A one-word keyword stays a substring
 * match. An empty keyword matches everything.
 */
export function keywordPredicate(query: string | undefined): (fields: (string | null | undefined)[]) => boolean {
  const parsed = query ? parseKeyword(query) : null;
  if (!parsed || emptyKeyword(parsed)) return () => true;
  return (fields) => keywordMatches(parsed, fields);
}

/**
 * Values of a closed vocabulary to offer when a filter value matched nothing:
 * the near ones (substring either way, a shared word, or a small edit
 * distance), else the whole vocabulary when it is short enough to list.
 */
export function closestValues(query: string, values: readonly string[], listAllUpTo = 30): string[] {
  const q = fold(query.trim());
  const unique = [...new Set(values.filter(Boolean))];
  if (!q) return unique.length <= listAllUpTo ? unique.sort((a, b) => a.localeCompare(b)) : [];
  const qWords = tokenize(q);
  const scored: [string, number][] = [];
  const maxEdits = Math.max(1, Math.floor(q.length / 4));
  for (const value of unique) {
    const v = fold(value);
    const words = tokenize(v);
    const score = v.includes(q) || q.includes(v) ? 3
      : qWords.some((w) => words.some((x) => x.startsWith(w) || w.startsWith(x))) ? 2
      : editDistance(q, v, maxEdits) <= maxEdits ? 1 : 0;
    if (score) scored.push([value, score]);
  }
  if (scored.length) return scored.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([v]) => v);
  return unique.length <= listAllUpTo ? unique.sort((a, b) => a.localeCompare(b)) : [];
}

/** True when every phrase and term of the query occurs in at least one of the
 * already-folded fields. */
export function keywordMatchesFolded(query: KeywordQuery, folded: string[]): boolean {
  const has = (needle: string) => folded.some((field) => field.includes(needle));
  return query.phrases.every(has) && query.terms.every(has);
}

/** `keywordMatchesFolded` over raw (unfolded) fields. */
export function keywordMatches(query: KeywordQuery, fields: (string | null | undefined)[]): boolean {
  const folded: string[] = [];
  for (const field of fields) if (field) folded.push(foldCached(field));
  return keywordMatchesFolded(query, folded);
}

/** True when the keyword has no content at all (whitespace or punctuation). */
export const emptyKeyword = (q: KeywordQuery): boolean => !q.phrases.length && !q.terms.length;

// --- places -------------------------------------------------------------------

/**
 * Equivalent country names. A group expands a query to every spelling in it;
 * a name in two groups ("congo") expands to both. The stored authority uses one
 * spelling ("Ivory Coast", "Democratic Republic of the Congo", "Eswatini",
 * "United States of America"), and a model asking for "Côte d'Ivoire" got 0.
 */
const PLACE_ALIASES: string[][] = [
  ["ivory coast", "cote d'ivoire", "cote divoire", "cote d ivoire", "republic of cote d'ivoire"],
  ["democratic republic of the congo", "dr congo", "drc", "dr of the congo", "congo-kinshasa", "congo kinshasa", "zaire", "congo"],
  ["republic of the congo", "congo-brazzaville", "congo brazzaville", "congo"],
  ["eswatini", "swaziland", "kingdom of eswatini"],
  ["united states of america", "united states", "usa", "u.s.a.", "u.s.", "us"],
  ["united kingdom", "uk", "u.k.", "great britain", "britain"],
  ["tanzania", "united republic of tanzania"],
  ["russia", "russian federation"],
  ["cape verde", "cabo verde"],
  ["gambia", "the gambia"],
  ["netherlands", "the netherlands", "holland"],
  ["czechia", "czech republic"],
  ["turkey", "turkiye"],
  ["germany", "deutschland"],
  ["benin", "dahomey"],
  ["burkina faso", "upper volta"],
];

/** Folded spellings a place query stands for (always includes the query itself). */
export function placeAliases(query: string): Set<string> {
  const q = fold(query.trim());
  const out = new Set([q]);
  for (const group of PLACE_ALIASES) if (group.includes(q)) for (const name of group) out.add(name);
  return out;
}

/** Word-prefix match: every query token starts some token of the label
 * ("Ibad" → "Ibadan", "Dar es" → "Dar es Salaam"), never a mid-word hit
 * ("Niger" must not reach "Nigeria" through this path). */
export function wordPrefixMatch(label: string, query: string): boolean {
  const lt = fold(label).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const qt = fold(query).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return qt.length > 0 && qt.every((q) => lt.some((t) => t.startsWith(q)));
}
