// Core text matching shared by the query layer (researchItemQuery,
// publicationQuery, searchRanking) and the tools. No MCP types live here: the
// query modules return data and typed errors, and the tool layer renders them.
//
// Every comparison is accent- AND case-insensitive (src/text.ts): the same
// concept is spelled "Côte d'Ivoire" in the subject authority and "Cote
// d'Ivoire" in item titles, and a model cannot know which corpus stores which.
import { fold, foldCached, foldedIndexOf } from "./text.js";
import type { LinkedRef } from "./types.js";

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
 * without shipping the whole transcript. Multi-word queries anchor on the first
 * content term that occurs. Returns null when absent.
 */
export function matchSnippet(text: string | null | undefined, query: string, radius = 140): string | null {
  if (!text || !query) return null;
  const parsed = parseKeyword(query);
  const anchors = [...parsed.phrases, ...parsed.terms];
  let i = -1, len = 0;
  for (const anchor of anchors.length ? anchors : [fold(query)]) {
    i = foldedIndexOf(text, anchor);
    if (i !== -1) { len = anchor.length; break; }
  }
  if (i === -1) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + len + radius);
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
    const literal = fold(rest).trim();
    if (literal) phrases.push(literal);
  }
  return { phrases, terms };
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
