import type { DataStore } from "./data.js";
import { allowDescriptive, allowFullText, allowStructured, exposureLevel } from "./exposure.js";
import { refLabels } from "./tools/_shared.js";
import { itemUrl } from "./urls.js";
import { fold, foldCached } from "./text.js";
export const SEARCH_TYPES = ["item", "publication", "video", "podcast", "project", "section"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

interface Hit {
  id: string;
  title: string;
  url: string;
  score: number;
}

// Common EN/FR function words — dropped from queries so a natural-language
// question ("which projects study migration?") matches on its content words.
const STOPWORDS = new Set(
  (
    "the a an of in on at to for and or but with by from as is are was were be been which who whom whose what when " +
    "where why how do does did about into over across this that these those there here their them they our your you we it its not no " +
    "le la les un une des de du et ou mais avec par pour dans sur qui que quoi dont est sont ete etre ce ces cette aux au se sa son ses"
  )
    .split(/\s+/)
    .filter(Boolean),
);

/** Folded content terms (>=2 chars, no stopwords, de-duplicated). Folding is
 * what makes the unaccented stopwords above ("ete", "etre") actually fire. */
function tokenize(q: string): string[] {
  const toks = fold(q)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

/**
 * Fold a field group ONCE per query rather than once per term. Folding cost is
 * per string, and `containsCI` re-folded every title, subject and label for
 * every term of the query — with ~4,000 items × ~10 fields that dominated
 * search time. `terms` and `phrase` arrive pre-folded from `tokenize`, so the
 * comparison below is a plain substring test.
 */
function foldAll(xs: (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const s of xs) if (s) out.push(foldCached(s));
  return out;
}

function anyHas(folded: string[], term: string): boolean {
  return folded.some((s) => s.includes(term));
}

/** Body length at or below which a body hit keeps full weight (an abstract). */
const BODY_REFERENCE = 2_000;

/**
 * Damping for body hits, by how much text was searched. Undamped, a
 * 95,000-char publication full text that happened to contain five query terms
 * scored 5 and outranked a precise title hit (3) — length won, not relevance.
 * Abstracts keep full weight; a full text is worth ~0.37 per term, a
 * 40,000-char transcript ~0.43, so a single title hit still wins.
 */
function bodyWeight(bodies: (string | null | undefined)[]): number {
  let len = 0;
  for (const b of bodies) len += b?.length ?? 0;
  if (len <= BODY_REFERENCE) return 1;
  return Math.max(0.25, 1 / (1 + Math.log10(len / BODY_REFERENCE)));
}

/**
 * Token-aware relevance: each query term scores at the weight of the best field
 * it appears in (title 3 / mid 2 / body 1×damping), so matches accumulate by how
 * many terms land and where. A full-phrase title hit adds a bonus. This is what
 * lets multi-word and natural-language queries match — the old whole-phrase
 * substring test returned nothing for anything but an exact phrase.
 */
function scoreRecord(
  store: DataStore, key: string,
  terms: string[],
  phrase: string,
  title: (string | null | undefined)[],
  mid: (string | null | undefined)[],
  body: (string | null | undefined)[],
): number {
  const fields = store.cached(`ranking:${exposureLevel()}:${key}`, () => ({
    title: foldAll(title), mid: foldAll(mid), body: foldAll(body), weight: bodyWeight(body),
  }));
  const ft = fields.title, fm = fields.mid, fb = fields.body;
  let s = 0;
  for (const t of terms) {
    if (anyHas(ft, t)) {
      s += 3;
      continue;
    }
    if (anyHas(fm, t)) {
      s += 2;
      continue;
    }
    if (anyHas(fb, t)) s += fields.weight;
  }
  if (s > 0 && terms.length > 1 && anyHas(ft, phrase)) s += 4;
  return s;
}

/** Rank the readable corpora (items, publications, videos, podcasts, projects,
 * research sections) for a query by token-aware relevance, optionally restricted
 * to a set of record kinds and capped at `limit`. The fields searched follow the
 * exposure level: titles always; descriptive text, structured labels, and
 * transcripts/full text only when the level exposes them. */
export function runSearch(store: DataStore, query: string, limit: number, types?: SearchType[]): Hit[] {
  const phrase = fold(query.trim());
  const terms = tokenize(query);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  const add = (id: string, title: string, url: string, score: number) => {
    if (score > 0) hits.push({ id, title, url, score });
  };
  // Scoring a corpus the caller excluded is pure waste — `types: ['project']`
  // used to still scan every publication full text and transcript.
  const want = (t: SearchType): boolean => !types?.length || types.includes(t);
  const desc = allowDescriptive();
  const struct = allowStructured();
  const full = allowFullText();
  const mids = (xs: (string | null | undefined)[]): (string | null | undefined)[] => (struct ? xs : []);
  const bodies = (xs: (string | null | undefined)[]): (string | null | undefined)[] => (desc ? xs : []);

  if (want("item"))
    for (const it of store.items) {
      add(
        `item:${it.o_id}`, it.title, itemUrl(it.o_id),
        scoreRecord(store, `item:${it.o_id}`, terms, phrase,
          [it.title, ...it.alt_titles],
          mids([...refLabels(it.subjects), ...it.contributors.map((c) => c.name), ...it.places.map((p) => p.label), ...refLabels(it.formats), ...it.identifiers, it.dre_id]),
          bodies([it.abstract, it.description, it.toc])),
      );
    }
  if (want("publication"))
    for (const p of store.publications) {
      add(
        `pub:${p.o_id}`, p.title, itemUrl(p.o_id),
        scoreRecord(store, `pub:${p.o_id}`, terms, phrase, [p.title],
          mids([...refLabels(p.authors), ...refLabels(p.editors), p.venue, ...refLabels(p.subjects)]),
          [...bodies([p.abstract]), ...(full ? [p.fulltext] : [])]),
      );
    }
  if (want("video"))
    for (const v of store.videos) {
      add(
        `video:${v.o_id}`, v.title, itemUrl(v.o_id),
        scoreRecord(store, `video:${v.o_id}`, terms, phrase, [v.title],
          mids([...v.speakers.map((c) => c.name), ...refLabels(v.playlists)]),
          [...bodies([v.abstract]), ...(full ? [v.transcript] : [])]),
      );
    }
  if (want("podcast"))
    for (const p of store.podcasts) {
      add(
        `podcast:${p.o_id}`, p.title, itemUrl(p.o_id),
        scoreRecord(store, `podcast:${p.o_id}`, terms, phrase, [p.title],
          mids([...p.people.map((c) => c.name), p.series?.label]),
          [...bodies([p.abstract]), ...(full ? [p.transcript] : [])]),
      );
    }
  if (want("project"))
    for (const p of store.projects) {
      add(
        `project:${p.o_id}`, p.name, itemUrl(p.o_id),
        scoreRecord(store, `project:${p.o_id}`, terms, phrase, [p.name],
          mids([...refLabels(p.sections), ...refLabels(p.pis), ...refLabels(p.members), ...refLabels(p.funded_by)]),
          bodies([p.description])),
      );
    }
  if (want("section"))
    for (const s of store.sections) {
      add(`section:${s.o_id}`, s.name, itemUrl(s.o_id), scoreRecord(store, `section:${s.o_id}`, terms, phrase, [s.name], mids([...refLabels(s.pis)]), bodies([s.description])));
    }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
