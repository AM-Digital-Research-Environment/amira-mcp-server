// Ranked search across the readable corpora (the OpenAI `search` tool).
//
// Scoring, per query term:
//   field weight   title 3 · structured labels and identifiers 2 · body 1 × damping
//   match quality  1 at the start of a word; 0.5 inside a word for terms of five
//                  letters or more ("architektur" in "Kolonialarchitektur");
//                  nothing inside a word for short terms ("art" in "Zeitungsartikel")
//   rarity         an IDF factor, so a rare term outweighs a common one
// plus a bonus when the whole phrase occurs in the title. Ties interleave the
// corpora instead of keeping corpus order: before 1.19, `search("music", 50)`
// returned 50 research items and no publication although one had "Music" in
// its title. This is substring ranking, not semantic search; changes should be
// checked against a judged query set.
import type { DataStore } from "./data.js";
import { allowDescriptive, allowFullText, allowStructured, exposureLevel } from "./exposure.js";
import { refLabels, tokenize } from "./matching.js";
import { itemUrl } from "./urls.js";
import { fold, foldCached } from "./text.js";
import { abstractsOf } from "./publicationQuery.js";
export const SEARCH_TYPES = ["item", "publication", "video", "podcast", "project", "section"] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

interface Hit {
  id: string;
  title: string;
  url: string;
  score: number;
}

type Field = string | null | undefined;
interface Fields { title: string[]; mid: string[]; body: string[]; weight: number }

function foldAll(xs: Field[]): string[] {
  const out: string[] = [];
  for (const s of xs) if (s) out.push(foldCached(s));
  return out;
}

/** Body length at or below which a body hit keeps full weight (an abstract). */
const BODY_REFERENCE = 2_000;

/**
 * Damping for body hits, by how much text was searched. Undamped, a
 * 95,000-char publication full text that happened to contain five query terms
 * outranked a precise title hit — length won, not relevance.
 */
function bodyWeight(bodies: Field[]): number {
  let len = 0;
  for (const b of bodies) len += b?.length ?? 0;
  if (len <= BODY_REFERENCE) return 1;
  return Math.max(0.25, 1 / (1 + Math.log10(len / BODY_REFERENCE)));
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 1 for a match at a word start, 0.5 inside a word (long terms only), else 0. */
function matchQuality(fields: string[], term: string): number {
  let best = 0;
  for (const field of fields) {
    let from = 0;
    for (;;) {
      const i = field.indexOf(term, from);
      if (i < 0) break;
      if (i === 0 || !WORD_CHAR.test(field[i - 1]!)) return 1;
      if (term.length >= 5) best = 0.5;
      from = i + 1;
    }
  }
  return best;
}

interface Candidate { id: string; title: string; url: string; corpus: number; seq: number; weights: number[]; titlePhrase: boolean }

/** Rank the readable corpora (items, publications, videos, podcasts, projects,
 * research sections) for a query, optionally restricted to a set of record
 * kinds and capped at `limit`. The fields searched follow the exposure level:
 * titles always; descriptive text, structured labels, and transcripts/full
 * text only when the level exposes them. */
export function runSearch(store: DataStore, query: string, limit: number, types?: SearchType[]): Hit[] {
  const phrase = fold(query.trim());
  const terms = tokenize(query);
  if (!terms.length) return [];
  // Scoring a corpus the caller excluded is pure waste — `types: ['project']`
  // used to still scan every publication full text and transcript.
  const want = (t: SearchType): boolean => !types?.length || types.includes(t);
  const desc = allowDescriptive();
  const struct = allowStructured();
  const full = allowFullText();
  const mids = (xs: Field[]): Field[] => (struct ? xs : []);
  const idents = (xs: Field[]): Field[] => (desc ? xs : []);
  const bodies = (xs: Field[]): Field[] => (desc ? xs : []);

  const candidates: Candidate[] = [];
  const df = new Array<number>(terms.length).fill(0);
  let scanned = 0;
  let corpus = 0;
  const consider = (key: string, title: string, oId: number, seqBase: { n: number },
    titleFields: Field[], midFields: Field[], bodyFields: Field[]) => {
    scanned++;
    const fields: Fields = store.cached(`ranking:${exposureLevel()}:${key}`, () => ({
      title: foldAll(titleFields), mid: foldAll(midFields), body: foldAll(bodyFields), weight: bodyWeight(bodyFields),
    }));
    let any = false;
    const weights = terms.map((t, i) => {
      const w = Math.max(3 * matchQuality(fields.title, t), 2 * matchQuality(fields.mid, t), fields.weight * matchQuality(fields.body, t));
      if (w > 0) { any = true; df[i]!++; }
      return w;
    });
    if (any) {
      candidates.push({ id: key, title, url: itemUrl(oId), corpus, seq: seqBase.n++, weights,
        titlePhrase: terms.length > 1 && fields.title.some((f) => f.includes(phrase)) });
    }
  };

  if (want("item")) {
    const seq = { n: 0 };
    for (const it of store.items) {
      consider(`item:${it.o_id}`, it.title, it.o_id, seq, [it.title, ...it.alt_titles],
        [...mids([...refLabels(it.subjects), ...it.contributors.map((c) => c.name), ...it.places.map((p) => p.label), ...refLabels(it.formats)]),
          ...idents([...it.identifiers, it.dre_id])],
        bodies([it.abstract, it.description, it.toc]));
    }
    corpus++;
  }
  if (want("publication")) {
    const seq = { n: 0 };
    for (const p of store.publications) {
      consider(`pub:${p.o_id}`, p.title, p.o_id, seq, [p.title],
        mids([...refLabels(p.authors), ...refLabels(p.editors), p.venue, ...refLabels(p.subjects)]),
        [...bodies(abstractsOf(p)), ...(full ? [p.fulltext] : [])]);
    }
    corpus++;
  }
  if (want("video")) {
    const seq = { n: 0 };
    for (const v of store.videos) {
      consider(`video:${v.o_id}`, v.title, v.o_id, seq, [v.title],
        mids([...v.speakers.map((c) => c.name), ...refLabels(v.playlists)]),
        [...bodies([v.abstract]), ...(full ? [v.transcript] : [])]);
    }
    corpus++;
  }
  if (want("podcast")) {
    const seq = { n: 0 };
    for (const p of store.podcasts) {
      consider(`podcast:${p.o_id}`, p.title, p.o_id, seq, [p.title],
        mids([...p.people.map((c) => c.name), p.series?.label]),
        [...bodies([p.abstract]), ...(full ? [p.transcript] : [])]);
    }
    corpus++;
  }
  if (want("project")) {
    const seq = { n: 0 };
    for (const p of store.projects) {
      consider(`project:${p.o_id}`, p.name, p.o_id, seq, [p.name, ...(p.alt_names ?? [])],
        mids([...refLabels(p.sections), ...refLabels(p.pis), ...refLabels(p.members), ...refLabels(p.funded_by)]),
        bodies([p.description]));
    }
    corpus++;
  }
  if (want("section")) {
    const seq = { n: 0 };
    for (const s of store.sections) {
      consider(`section:${s.o_id}`, s.name, s.o_id, seq, [s.name], mids([...refLabels(s.pis)]), bodies([s.description]));
    }
    corpus++;
  }

  // Rarity: ln(1 + N / (1 + df)), so a term most records contain adds little.
  const idf = df.map((n) => Math.log(1 + scanned / (1 + n)));
  const hits = candidates.map((c) => ({
    c,
    score: c.weights.reduce((sum, w, i) => sum + w * idf[i]!, 0) + (c.titlePhrase ? 4 : 0),
  }));
  // Equal scores interleave corpora: the n-th hit of each corpus before the
  // (n+1)-th of any, in corpus order.
  hits.sort((a, b) => b.score - a.score || a.c.seq - b.c.seq || a.c.corpus - b.c.corpus);
  return hits.slice(0, limit).map(({ c, score }) => ({ id: c.id, title: c.title, url: c.url, score: Math.round(score * 1000) / 1000 }));
}
