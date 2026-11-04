// Public products of DRE Visualizations' full-text map of the ILAM journal
// *African Music* (Omeka item set 27724).
//
// ILAM's full text (`bibo:content`) is private in Omeka, so the public API this
// server crawls never carries it. DRE Visualizations computed a map from it
// offline and committed only derived, public files to its public repository:
// ids, map coordinates, groups with AI-generated labels, nearest-neighbour
// scores, per-article country counts and aggregate word counts per year. The
// crawl fetches those two files at a PINNED release tag, validates them against
// the expected shape, and stores them beside the snapshot; nothing here reads,
// stores or serves any article text.
//
// At request time everything is filtered to research items present in the
// public snapshot and filed in the item set the map describes, so every
// citation remains an `amira_url` the snapshot can back.
import { z } from "zod";
import type { DataStore } from "./data.js";
import { fold } from "./text.js";

/** Where the files come from. A new map ships by moving this pin in a release. */
export const FULLTEXT_SOURCE = {
  repository: "AM-Digital-Research-Environment/DRE-Visualizations",
  tag: "v2.48.0",
  map: "config/fulltext-maps/international-library-of-african-music-ilam.json",
  words: "asset/data/fulltext/international-library-of-african-music-ilam-words.json",
  itemSetId: 27724,
} as const;

const count = z.number().int().min(0);
const omekaId = z.number().int().positive();
const idKey = z.string().regex(/^[1-9]\d{0,9}$/);

const mapSchema = z.object({
  schemaVersion: z.literal(1),
  itemSetId: omekaId,
  generatedAt: z.string().max(40),
  model: z.object({ name: z.string().max(200), revision: z.string().max(80) }),
  counts: z.object({ items: count, withText: count, shown: count, excluded: z.record(z.string().max(40), count), passages: count }),
  groups: z.array(z.object({ id: z.number().int().min(1), size: count, label: z.string().min(1).max(200) })).max(500),
  /** [omekaId, x, y, group]; group 0 = unclustered. */
  items: z.array(z.tuple([omekaId, z.number(), z.number(), count])).max(50_000),
  neighbours: z.record(idKey, z.array(z.tuple([omekaId, z.number().min(-1).max(1)])).max(50)),
  places: z.object({
    minMentions: z.number().int().positive(),
    items: z.record(idKey, z.array(z.tuple([z.string().min(1).max(120), z.number().int().positive()])).max(300)),
  }),
  labels: z.object({ by: z.string().max(200), from: z.string().max(300), date: z.string().max(40) }),
});

/** A single word form: letters, marks and digits, with inner apostrophes, dots or hyphens. */
const WORD = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’.-]*$/u;
const wordsSchema = z.object({
  schemaVersion: z.literal(1),
  itemSetId: omekaId,
  generatedAt: z.string().max(40),
  minArticles: z.number().int().positive(),
  articles: count,
  years: z.array(z.number().int().min(1000).max(2200)).max(500),
  totals: z.array(count).max(500),
  /** word -> [yearIndex, count, yearIndex, count, …] */
  words: z.record(z.string().max(80).regex(WORD), z.array(count).max(1000)),
});

export type FulltextMapFile = z.infer<typeof mapSchema>;
export type WordsFile = z.infer<typeof wordsSchema>;
export interface FulltextMaps {
  source: { repository: string; tag: string; map: string; words: string };
  map: FulltextMapFile;
  words: WordsFile;
}
/** What the snapshot manifest records about the stored files. */
export interface FulltextManifestEntry { repository: string; tag: string; item_set: number; generated_at: string; articles: number }

/**
 * Validate both files and the links between them. Unknown keys are dropped, so
 * only the fields named above are ever stored. Throws on any mismatch.
 */
export function parseFulltextMaps(input: { source: unknown; map: unknown; words: unknown }): FulltextMaps {
  const source = z.object({ repository: z.string().max(200), tag: z.string().max(80), map: z.string().max(300), words: z.string().max(300) })
    .parse(input.source);
  const map = mapSchema.parse(input.map);
  const words = wordsSchema.parse(input.words);
  if (words.itemSetId !== map.itemSetId) throw new Error("full-text map and word counts describe different item sets");
  if (words.years.length !== words.totals.length) throw new Error("word counts: years and totals differ in length");
  if (new Set(words.years).size !== words.years.length) throw new Error("word counts: duplicate years");
  for (const [word, pairs] of Object.entries(words.words)) {
    if (pairs.length % 2) throw new Error(`word counts: '${word}' has an odd-length series`);
    for (let i = 0; i < pairs.length; i += 2) {
      if (pairs[i]! >= words.years.length) throw new Error(`word counts: '${word}' points at a missing year`);
    }
  }
  const ids = new Set(map.items.map(([id]) => id));
  if (ids.size !== map.items.length) throw new Error("full-text map: duplicate item ids");
  const groupIds = new Set(map.groups.map((g) => g.id));
  if (map.items.some(([, , , group]) => group !== 0 && !groupIds.has(group))) throw new Error("full-text map: item in an undeclared group");
  return { source, map, words };
}

export function fulltextManifestEntry(maps: FulltextMaps): FulltextManifestEntry {
  return { repository: maps.source.repository, tag: maps.source.tag, item_set: maps.map.itemSetId,
    generated_at: maps.map.generatedAt, articles: maps.map.items.length };
}

// --- request-time index ---------------------------------------------------------

export interface Neighbour { id: number; score: number }
export interface FulltextArticle { group: number; neighbours: Neighbour[]; countries: { country: string; mentions: number }[] }
export interface FulltextIndex {
  maps: FulltextMaps;
  itemSetId: number;
  articles: Map<number, FulltextArticle>;
  groups: Map<number, { id: number; label: string; members: number[] }>;
  /** Folded country name -> stored spelling. */
  countries: Map<string, string>;
  /** Folded word -> stored word. */
  words: Map<string, string>;
  /** Mapped articles per year, from the snapshot's first content year (an approximation of the map's own year). */
  articlesByYear: Map<number, number>;
}

/** The map, restricted to research items present in the snapshot and filed in its item set. */
export function fulltextIndex(store: DataStore): FulltextIndex | null {
  const maps = store.fulltextMaps;
  if (!maps) return null;
  return store.cached("fulltext:index", () => {
    const setId = maps.map.itemSetId;
    const present = (id: number) => store.getItem(String(id))?.item_sets.includes(setId) ?? false;
    const articles = new Map<number, FulltextArticle>();
    const groups = new Map(maps.map.groups.map((g) => [g.id, { id: g.id, label: g.label, members: [] as number[] }]));
    const countries = new Map<string, string>();
    const articlesByYear = new Map<number, number>();
    for (const [id, , , group] of maps.map.items) {
      if (!present(id)) continue;
      const year = store.getItem(String(id))!.year_min;
      if (year != null) articlesByYear.set(year, (articlesByYear.get(year) ?? 0) + 1);
      const neighbours = (maps.map.neighbours[String(id)] ?? []).filter(([n]) => present(n)).map(([n, score]) => ({ id: n, score }));
      const named = (maps.map.places.items[String(id)] ?? []).map(([country, mentions]) => ({ country, mentions }))
        .sort((a, b) => b.mentions - a.mentions || a.country.localeCompare(b.country));
      for (const { country } of named) countries.set(fold(country), country);
      articles.set(id, { group, neighbours, countries: named });
      groups.get(group)?.members.push(id);
    }
    const words = new Map(Object.keys(maps.words.words).map((w) => [fold(w), w]));
    return { maps, itemSetId: setId, articles, groups, countries, words, articlesByYear };
  });
}

/** True when the research item belongs to the collection the map describes. */
export const inMappedCollection = (index: FulltextIndex, itemSets: number[]): boolean => itemSets.includes(index.itemSetId);

// --- provenance and caveats (curatorial text, shared by every surface) ----------

export function sourceRef(index: FulltextIndex) {
  const { repository, tag } = index.maps.source;
  return { name: `DRE Visualizations ${tag}`, url: `https://github.com/${repository}/tree/${tag}`, generated_at: index.maps.map.generatedAt };
}

/** Every surface that shows a group name says it is AI-generated. */
export function groupLabelNote(index: FulltextIndex): string {
  const l = index.maps.map.labels;
  return `Group names are AI-generated (${l.by}, from ${l.from}, ${l.date}) and experimental: judge a group by its articles, not its name.`;
}

/** Articles with full text that are not on the map (the exclusion reasons overlap, so this is not their sum). */
export function excludedCount(index: FulltextIndex): number {
  const c = index.maps.map.counts;
  return Math.max(0, c.withText - c.shown);
}

export function neighboursNote(index: FulltextIndex): string {
  return `Closest by full-text embedding (${index.maps.map.model.name}, cosine of article vectors), computed offline from ILAM's full text, ` +
    "which is private and never served here. Scores sit in a narrow band (about 0.90 to 0.97): compare ranks, not raw values. " +
    `Not on the map: articles without full text, and ${excludedCount(index)} with full text excluded as shared section text, journal furniture or under 300 words.`;
}

export function countriesNote(index: FulltextIndex): string {
  return `Countries named at least ${index.maps.map.places.minMentions} times in an article's full text, matched by a gazetteer; ` +
    "journal addresses excluded. A mention is not a subject: a country may be named in passing or in references.";
}

export function wordsNote(index: FulltextIndex): string {
  return `Counts per year of publication over the full text of the ${index.maps.words.articles} mapped articles, for words in at least ` +
    `${index.maps.words.minArticles} articles; rates are per 10,000 words. Single word forms only, no stemming. ` +
    "Years with few words or articles (marked sparse) give unstable rates; `articles` counts mapped articles by their AMIRA date.";
}

/** A folded country query matched against the stored spellings, with aliases. */
export function countryNames(index: FulltextIndex, aliases: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const name of aliases) {
    const stored = index.countries.get(name);
    if (stored) out.add(stored);
  }
  return out;
}

/** Up to five stored country names close to a query. */
export function countrySuggestions(index: FulltextIndex, query: string): string[] {
  const q = fold(query.trim());
  if (!q) return [];
  return [...index.countries].filter(([folded]) => folded.includes(q) || q.includes(folded) || folded.startsWith(q.slice(0, 3)))
    .map(([, name]) => name).sort().slice(0, 5);
}

// --- word trends ----------------------------------------------------------------

/** Below this many words, or this many articles, a year's rates are flagged as sparse. */
export const SPARSE_YEAR_WORDS = 12_000;
export const SPARSE_YEAR_ARTICLES = 3;

export interface WordTrends {
  counted: string[];
  not_counted: { word: string; similar?: string[] }[];
  totals: Record<string, { count: number; per_10k: number }>;
  years: { year: number; words: number; articles: number; per_10k: Record<string, number>; counts: Record<string, number>; sparse?: true }[];
}

const rate = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1_000_000) / 100 : 0);

export function wordTrends(index: FulltextIndex, requested: string[], yearFrom?: number, yearTo?: number): WordTrends {
  const { words: file } = index.maps;
  const counted: string[] = [];
  const not_counted: WordTrends["not_counted"] = [];
  for (const raw of requested) {
    const q = fold(raw.trim());
    const stored = index.words.get(q);
    if (stored) { if (!counted.includes(stored)) counted.push(stored); continue; }
    // Near forms ignore inner punctuation, so "hiphop" suggests "hip-hop".
    const bare = (w: string) => w.replace(/['’.-]/g, "");
    const stem = bare(q).slice(0, Math.max(3, bare(q).length - 2));
    const similar = stem.length >= 3 ? [...index.words].filter(([w]) => bare(w).startsWith(stem))
      .map(([, w]) => w).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 5) : [];
    not_counted.push({ word: raw, ...(similar.length ? { similar } : {}) });
  }
  const series = new Map(counted.map((w) => {
    const pairs = file.words[w]!;
    const byYear = new Map<number, number>();
    for (let i = 0; i < pairs.length; i += 2) byYear.set(pairs[i]!, pairs[i + 1]!);
    return [w, byYear];
  }));
  const years: WordTrends["years"] = [];
  const sums = Object.fromEntries(counted.map((w) => [w, 0]));
  let wordsInRange = 0;
  file.years.forEach((year, yi) => {
    if ((yearFrom !== undefined && year < yearFrom) || (yearTo !== undefined && year > yearTo)) return;
    const total = file.totals[yi]!;
    wordsInRange += total;
    const counts: Record<string, number> = {};
    const per: Record<string, number> = {};
    for (const w of counted) {
      const n = series.get(w)!.get(yi) ?? 0;
      counts[w] = n; per[w] = rate(n, total); sums[w]! += n;
    }
    const articles = index.articlesByYear.get(year) ?? 0;
    const sparse = total < SPARSE_YEAR_WORDS || articles < SPARSE_YEAR_ARTICLES;
    years.push({ year, words: total, articles, per_10k: per, counts, ...(sparse ? { sparse: true as const } : {}) });
  });
  const totals = Object.fromEntries(counted.map((w) => [w, { count: sums[w]!, per_10k: rate(sums[w]!, wordsInRange) }]));
  return { counted, not_counted, totals, years };
}
