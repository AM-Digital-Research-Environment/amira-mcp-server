// OpenAI / ChatGPT compatibility tools: `search` and `fetch`.
//
// ChatGPT's Deep Research + connector contract calls exactly two tools, with
// fixed names and shapes:
//   search(query)  -> { results: [{ id, title, url }] }
//   fetch(id)      -> { id, title, text, url, metadata }
// Both must return `structuredContent` alongside the JSON content array — which
// our `textResult` helper already does. These adapters sit OVER the same
// in-memory store the rich tools use; they are registered only on the remote
// HTTP transport (src/http.ts), so the stdio .mcpb keeps its 24-tool surface.
//
// `id` is typed as `<kind>:<key>` (item:<dre_id>, pub:<pub_id>, video:<o_id>,
// podcast:<o_id>, project:<dre_id>, section:<o_id>) so fetch can route back.
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { DataStore } from "../data.js";
import {
  annotate,
  capText,
  CHARACTER_LIMIT,
  containsCI,
  dateStatus,
  refLabels,
  textResult,
  yearLabel,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

/** Friendly record-kind tokens (the `types` filter) → typed-id prefixes. */
const TYPE_PREFIX: Record<string, string> = {
  item: "item:",
  publication: "pub:",
  video: "video:",
  podcast: "podcast:",
  project: "project:",
  section: "section:",
};
type SearchType = keyof typeof TYPE_PREFIX;

interface Hit {
  id: string;
  title: string;
  url: string;
  score: number;
}

/** Drop null/undefined/empty-array entries so metadata stays compact. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0)),
  );
}

/** Join non-empty lines into one text body. */
function joinLines(...xs: (string | null | undefined | false)[]): string {
  return xs.filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
}

/** The topmost ancestor (country) of a place, for compact place labels. */
function placeWithCountry(store: DataStore, label: string, oId: number | null): string {
  const ancestors = store.locationAncestors(oId);
  const country = ancestors[ancestors.length - 1];
  return country && country !== label ? `${label} (${country})` : label;
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

/** Lowercase content terms (>=2 chars, no stopwords, de-duplicated). */
function tokenize(q: string): string[] {
  const toks = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return [...new Set(toks)];
}

function anyHas(strings: (string | null | undefined)[], term: string): boolean {
  return strings.some((s) => containsCI(s, term));
}

/**
 * Token-aware relevance: each query term scores at the weight of the best field
 * it appears in (title 3 / mid 2 / body 1), so matches accumulate by how many
 * terms land and where. A full-phrase title hit adds a bonus. This is what lets
 * multi-word and natural-language queries match — the old whole-phrase substring
 * test returned nothing for anything but an exact phrase.
 */
function scoreRecord(
  terms: string[],
  phrase: string,
  title: (string | null | undefined)[],
  mid: (string | null | undefined)[],
  body: (string | null | undefined)[],
): number {
  let s = 0;
  for (const t of terms) {
    if (anyHas(title, t)) s += 3;
    else if (anyHas(mid, t)) s += 2;
    else if (anyHas(body, t)) s += 1;
  }
  if (s > 0 && terms.length > 1 && anyHas(title, phrase)) s += 4;
  return s;
}

/** Rank the readable corpora (items, publications, videos, podcasts, projects,
 * research sections) for a query by token-aware relevance, optionally restricted
 * to a set of record kinds and capped at `limit`. */
function runSearch(store: DataStore, query: string, limit: number, types?: SearchType[]): Hit[] {
  const phrase = query.trim().toLowerCase();
  const terms = tokenize(query);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  const add = (id: string, title: string, url: string, score: number) => {
    if (score > 0) hits.push({ id, title, url, score });
  };

  for (const it of store.items) {
    add(
      `item:${it.dre_id}`, it.title, itemUrl(it.o_id),
      scoreRecord(terms, phrase,
        [it.title, ...it.alt_titles],
        [...refLabels(it.subjects), ...it.contributors.map((c) => c.name), ...it.places.map((p) => p.label), ...refLabels(it.formats), ...it.identifiers, it.dre_id],
        [it.abstract, it.description, it.toc]),
    );
  }
  for (const p of store.publications) {
    add(
      `pub:${p.pub_id}`, p.title, p.doi ?? p.urls[0] ?? itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.title], [...refLabels(p.authors), ...refLabels(p.editors), p.venue, ...refLabels(p.subjects)], [p.abstract]),
    );
  }
  for (const v of store.videos) {
    add(
      `video:${v.o_id}`, v.title, v.url ?? itemUrl(v.o_id),
      scoreRecord(terms, phrase, [v.title], [...v.speakers.map((c) => c.name), ...refLabels(v.playlists)], [v.abstract, v.transcript]),
    );
  }
  for (const p of store.podcasts) {
    add(
      `podcast:${p.o_id}`, p.title, p.url ?? itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.title], [...p.people.map((c) => c.name), p.series?.label], [p.abstract, p.transcript]),
    );
  }
  for (const p of store.projects) {
    add(
      `project:${p.dre_id}`, p.name, itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.name], [...refLabels(p.sections), ...refLabels(p.pis), ...refLabels(p.members), ...refLabels(p.funded_by)], [p.description]),
    );
  }
  for (const s of store.sections) {
    add(`section:${s.o_id}`, s.name, itemUrl(s.o_id), scoreRecord(terms, phrase, [s.name], [...refLabels(s.pis)], [s.description]));
  }

  let ranked = hits.sort((a, b) => b.score - a.score);
  if (types && types.length) {
    const prefixes = types.map((t) => TYPE_PREFIX[t]).filter((p): p is string => !!p);
    if (prefixes.length) ranked = ranked.filter((h) => prefixes.some((p) => h.id.startsWith(p)));
  }
  return ranked.slice(0, limit);
}

function fetchDoc(
  store: DataStore,
  id: string,
  opts: { includeTranscript: boolean; maxChars: number },
): Record<string, unknown> {
  const sep = id.indexOf(":");
  const kind = sep === -1 ? id : id.slice(0, sep);
  const key = sep === -1 ? "" : id.slice(sep + 1);
  const notFound = { error: { code: "not_found", message: `No record with id '${id}'.`, suggested_tool: "search" } };

  if (kind === "item") {
    const it = store.getItem(key);
    if (!it) return notFound;
    const project = store.projectOf(it);
    const text = joinLines(
      `Title: ${it.title}`,
      it.alt_titles.length ? `Alternative titles: ${it.alt_titles.join("; ")}` : null,
      it.type ? `Type: ${it.type}` : null,
      `University: ${UNIVERSITY_LABELS[it.university]}`,
      project ? `Project: ${project.name}` : it.project ? `Project: ${it.project.label}` : null,
      it.contributors.length
        ? `Contributors: ${it.contributors.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}`
        : null,
      yearLabel(it) ? `Date: ${yearLabel(it)}` : null,
      it.subjects.length ? `Subjects: ${refLabels(it.subjects).join("; ")}` : null,
      it.places.length ? `Places: ${it.places.map((p) => placeWithCountry(store, p.label, p.o_id)).join("; ")}` : null,
      refLabels(it.languages).length ? `Languages: ${refLabels(it.languages).join("; ")}` : null,
      refLabels(it.formats).length ? `Formats: ${refLabels(it.formats).join("; ")}` : null,
      it.sponsors.length ? `Sponsors: ${it.sponsors.join("; ")}` : null,
      it.provenance.length ? `Provenance: ${it.provenance.join("; ")}` : null,
      it.abstract ? `\nAbstract:\n${it.abstract}` : null,
      it.description ? `\nDescription:\n${it.description}` : null,
      it.toc ? `\nTable of contents:\n${it.toc}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: it.title,
      text: body,
      url: itemUrl(it.o_id),
      metadata: compact({
        kind: "research_item",
        dre_id: it.dre_id,
        type: it.type,
        university: UNIVERSITY_LABELS[it.university],
        project_id: project?.dre_id ?? null,
        date: yearLabel(it),
        subjects: refLabels(it.subjects),
        places: it.places.map((p) => p.label),
        has_media: it.has_media,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "pub") {
    const p = store.getPublication(key);
    if (!p) return notFound;
    const cite = [p.volume && `Vol. ${p.volume}`, p.issue && `No. ${p.issue}`, p.pages && `pp. ${p.pages}`]
      .filter(Boolean)
      .join(", ");
    const text = joinLines(
      `Title: ${p.title}`,
      `Type: ${p.type}`,
      p.authors.length ? `Authors: ${refLabels(p.authors).join("; ")}` : null,
      p.editors.length ? `Editors: ${refLabels(p.editors).join("; ")}` : null,
      p.venue ? `Venue: ${p.venue}` : null,
      p.year ? `Year: ${p.year}` : null,
      cite || null,
      p.publisher ? `Publisher: ${p.publisher}` : null,
      p.doi ? `DOI: ${p.doi}` : null,
      p.abstract ? `\nAbstract:\n${p.abstract}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.title,
      text: body,
      url: p.doi ?? p.urls[0] ?? itemUrl(p.o_id),
      metadata: compact({
        kind: "publication",
        pub_id: p.pub_id,
        type: p.type,
        year: p.year,
        authors: refLabels(p.authors),
        venue: p.venue,
        doi: p.doi,
        amira_url: itemUrl(p.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "video") {
    const v = store.getVideo(Number(key));
    if (!v) return notFound;
    const text = joinLines(
      `Title: ${v.title}`,
      v.date ? `Date: ${v.date}` : null,
      v.speakers.length ? `Speakers: ${v.speakers.map((c) => c.name).join("; ")}` : null,
      v.playlists.length ? `Playlists: ${refLabels(v.playlists).join("; ")}` : null,
      v.url ? `Watch: ${v.url}` : null,
      v.abstract ? `\nDescription:\n${v.abstract}` : null,
      opts.includeTranscript && v.transcript ? `\nTranscript:\n${v.transcript}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: v.title,
      text: body,
      url: v.url ?? itemUrl(v.o_id),
      metadata: compact({
        kind: "youtube_video",
        date: v.date,
        date_status: dateStatus(v.date),
        playlists: refLabels(v.playlists),
        speakers: v.speakers.map((c) => c.name),
        has_transcript: !!v.transcript,
        transcript_included: opts.includeTranscript && !!v.transcript,
        transcript_length: v.transcript?.length ?? 0,
        amira_url: itemUrl(v.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "podcast") {
    const p = store.getPodcast(Number(key));
    if (!p) return notFound;
    const text = joinLines(
      `Title: ${p.title}`,
      p.series ? `Series: ${p.series.label}` : null,
      p.episode != null ? `Episode: ${p.episode}` : null,
      p.date ? `Date: ${p.date}` : null,
      p.people.length ? `People: ${p.people.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}` : null,
      p.url ? `Listen: ${p.url}` : null,
      p.abstract ? `\nDescription:\n${p.abstract}` : null,
      opts.includeTranscript && p.transcript ? `\nTranscript:\n${p.transcript}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.title,
      text: body,
      url: p.url ?? itemUrl(p.o_id),
      metadata: compact({
        kind: "podcast",
        series: p.series?.label ?? null,
        episode: p.episode,
        date: p.date,
        date_status: dateStatus(p.date),
        has_transcript: !!p.transcript,
        transcript_included: opts.includeTranscript && !!p.transcript,
        amira_url: itemUrl(p.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "project") {
    const p = store.getProject(key);
    if (!p) return notFound;
    const itemCount = store.itemsForProject(p.o_id).length;
    const text = joinLines(
      `Project: ${p.name}`,
      `University: ${UNIVERSITY_LABELS[p.university]}`,
      refLabels(p.sections).length ? `Research sections: ${refLabels(p.sections).join("; ")}` : null,
      refLabels(p.pis).length ? `Principal investigators: ${refLabels(p.pis).join("; ")}` : null,
      refLabels(p.members).length ? `Members: ${refLabels(p.members).join("; ")}` : null,
      refLabels(p.funded_by).length ? `Funded by: ${refLabels(p.funded_by).join("; ")}` : null,
      p.date.start || p.date.end ? `Dates: ${[p.date.start, p.date.end].filter(Boolean).join(" – ")}` : null,
      itemCount ? `Digitised items: ${itemCount}` : null,
      p.description ? `\nDescription:\n${p.description}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.name,
      text: body,
      url: itemUrl(p.o_id),
      metadata: compact({
        kind: "project",
        dre_id: p.dre_id,
        university: UNIVERSITY_LABELS[p.university],
        research_sections: refLabels(p.sections),
        item_count: itemCount,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "section") {
    const s = store.sections.find((x) => x.o_id === Number(key));
    if (!s) return notFound;
    const text = joinLines(
      `Research section: ${s.name}`,
      s.date.start || s.date.end ? `Dates: ${[s.date.start, s.date.end].filter(Boolean).join(" – ")}` : null,
      refLabels(s.pis).length ? `Principal investigators: ${refLabels(s.pis).join("; ")}` : null,
      s.spokesperson ? `Spokesperson: ${s.spokesperson}` : null,
      s.description ? `\nDescription:\n${s.description}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: s.name,
      text: body,
      url: itemUrl(s.o_id),
      metadata: compact({ kind: "research_section", dates: s.date, truncated: truncated || undefined }),
    };
  }

  return notFound;
}

export function registerOpenAITools(server: Server): void {
  // === search ===============================================================
  server.registerTool(
    "search",
    {
      title: "Search the AMIRA collection",
      description:
        "Search the Africa Multiple (AMIRA) research collection and return matching records, ranked by " +
        "relevance. Covers research items (digitised artefacts), the cluster bibliography, podcasts and " +
        "YouTube videos (search reaches INTO their transcripts), and the cluster's projects and research " +
        "sections. Query terms are matched individually, so use a few concise keywords, names, places or " +
        "themes rather than a full sentence. Optional `limit` (default 10, max 50) and `types` (restrict " +
        "to item / publication / video / podcast / project / section) keep the result set tight. Returns " +
        "{ results: [{ id, title, url }] }; pass an `id` to the fetch tool for the full record text. " +
        "(This is the OpenAI/ChatGPT-compatible entry point; richer filtered tools — search_research_items, " +
        "find_related, list_* — are also available.)",
      annotations: annotate("Search the AMIRA collection"),
      inputSchema: {
        query: z.string().describe("A few keywords/names/themes, e.g. 'Yoruba architecture' or 'migration West Africa'"),
        limit: z.number().int().optional().describe("Max results, default 10, max 50"),
        types: z
          .array(z.enum(["item", "publication", "video", "podcast", "project", "section"]))
          .optional()
          .describe("Restrict to these record kinds"),
      },
    },
    async ({ query, limit, types }) => {
      const store = await ensureStore();
      const capped = Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT));
      const results = runSearch(store, query, capped, types as SearchType[] | undefined).map((h) => ({
        id: h.id,
        title: h.title,
        url: h.url,
      }));
      return textResult({ results });
    },
  );

  // === fetch ================================================================
  server.registerTool(
    "fetch",
    {
      title: "Fetch one AMIRA record",
      description:
        "Retrieve the full text and metadata of one AMIRA record by the `id` returned from the search tool " +
        "(e.g. 'item:abg-99-0000', 'project:UBT_ArtWorld2019', 'pub:eref-94882', 'video:39218', " +
        "'podcast:39121', 'section:218'). Returns { id, title, text, url, metadata } — `text` concatenates " +
        "the record's descriptive fields, `url` is the citable public page. For videos/podcasts the full " +
        "transcript is appended by default; pass include_transcript=false to drop it, and `max_chars` to " +
        "lower the cap (default/max 25,000 characters per call).",
      annotations: annotate("Fetch one AMIRA record"),
      inputSchema: {
        id: z.string().describe("A typed record id from search, e.g. 'item:abg-99-0000'"),
        include_transcript: z.boolean().optional().describe("Default true — set false to omit the video/podcast transcript"),
        max_chars: z.number().int().optional().describe("Cap on returned text, default/max 25000"),
      },
    },
    async ({ id, include_transcript, max_chars }) => {
      const store = await ensureStore();
      const maxChars = Math.max(1, Math.min(Math.floor(max_chars ?? CHARACTER_LIMIT), CHARACTER_LIMIT));
      return textResult(fetchDoc(store, id, { includeTranscript: include_transcript ?? true, maxChars }));
    },
  );
}
