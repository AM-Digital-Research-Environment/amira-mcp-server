// OpenAI / ChatGPT compatibility tools: `search` and `fetch`.
//
// ChatGPT's Deep Research + connector contract calls exactly two tools, with
// fixed names and shapes:
//   search(query)  -> { results: [{ id, title, url }] }
//   fetch(id)      -> { id, title, text, url, metadata }
// Both must return `structuredContent` alongside the JSON content array — which
// our `textResult` helper already does. These adapters sit OVER the same
// in-memory store the rich tools use; they are registered only on the remote
// HTTP transport (src/http.ts), so the stdio .mcpb keeps its 25-tool surface.
//
// `id` is typed as `<kind>:<omeka_o_id>` (item:7392, pub:30001, video:39218,
// podcast:39121, project:37700, section:218) so fetch can route back and a
// human can reconstruct the Omeka URL from the final number.
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { DataStore } from "../data.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  annotate,
  capText,
  CHARACTER_LIMIT,
  containsCI,
  dateStatus,
  refLabels,
  textResult,
  textWindowAppend,
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
 * to a set of record kinds and capped at `limit`. The fields searched follow the
 * exposure level: titles always; descriptive text, structured labels, and
 * transcripts/full text only when the level exposes them. */
function runSearch(store: DataStore, query: string, limit: number, types?: SearchType[]): Hit[] {
  const phrase = query.trim().toLowerCase();
  const terms = tokenize(query);
  if (!terms.length) return [];
  const hits: Hit[] = [];
  const add = (id: string, title: string, url: string, score: number) => {
    if (score > 0) hits.push({ id, title, url, score });
  };
  const desc = allowDescriptive();
  const struct = allowStructured();
  const full = allowFullText();
  const mids = (xs: (string | null | undefined)[]): (string | null | undefined)[] => (struct ? xs : []);
  const bodies = (xs: (string | null | undefined)[]): (string | null | undefined)[] => (desc ? xs : []);

  for (const it of store.items) {
    add(
      `item:${it.o_id}`, it.title, itemUrl(it.o_id),
      scoreRecord(terms, phrase,
        [it.title, ...it.alt_titles],
        mids([...refLabels(it.subjects), ...it.contributors.map((c) => c.name), ...it.places.map((p) => p.label), ...refLabels(it.formats), ...it.identifiers, it.dre_id]),
        bodies([it.abstract, it.description, it.toc])),
    );
  }
  for (const p of store.publications) {
    add(
      `pub:${p.o_id}`, p.title, itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.title],
        mids([...refLabels(p.authors), ...refLabels(p.editors), p.venue, ...refLabels(p.subjects)]),
        [...bodies([p.abstract]), ...(full ? [p.fulltext] : [])]),
    );
  }
  for (const v of store.videos) {
    add(
      `video:${v.o_id}`, v.title, itemUrl(v.o_id),
      scoreRecord(terms, phrase, [v.title],
        mids([...v.speakers.map((c) => c.name), ...refLabels(v.playlists)]),
        [...bodies([v.abstract]), ...(full ? [v.transcript] : [])]),
    );
  }
  for (const p of store.podcasts) {
    add(
      `podcast:${p.o_id}`, p.title, itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.title],
        mids([...p.people.map((c) => c.name), p.series?.label]),
        [...bodies([p.abstract]), ...(full ? [p.transcript] : [])]),
    );
  }
  for (const p of store.projects) {
    add(
      `project:${p.o_id}`, p.name, itemUrl(p.o_id),
      scoreRecord(terms, phrase, [p.name],
        mids([...refLabels(p.sections), ...refLabels(p.pis), ...refLabels(p.members), ...refLabels(p.funded_by)]),
        bodies([p.description])),
    );
  }
  for (const s of store.sections) {
    add(`section:${s.o_id}`, s.name, itemUrl(s.o_id), scoreRecord(terms, phrase, [s.name], mids([...refLabels(s.pis)]), bodies([s.description])));
  }

  let ranked = hits.sort((a, b) => b.score - a.score);
  if (types && types.length) {
    const prefixes = types.map((t) => TYPE_PREFIX[t]).filter((p): p is string => !!p);
    if (prefixes.length) ranked = ranked.filter((h) => prefixes.some((p) => h.id.startsWith(p)));
  }
  return ranked.slice(0, limit);
}

// Transcript/full-text windowing for `fetch` lives in the shared
// textWindowAppend helper, so the opt-in + offset/max paging contract is the
// same here as in get_video / get_podcast / get_publication (the v1.4.2 fix,
// now enforced by construction).

interface FetchOpts {
  includeTranscript: boolean;
  includeFulltext: boolean;
  maxChars: number;
  transcriptOffset?: number;
  transcriptMaxChars?: number;
  fulltextOffset?: number;
  fulltextMaxChars?: number;
}

function fetchDoc(store: DataStore, id: string, opts: FetchOpts): Record<string, unknown> {
  const sep = id.indexOf(":");
  const kind = sep === -1 ? id : id.slice(0, sep);
  const key = sep === -1 ? "" : id.slice(sep + 1);
  const notFound = { error: { code: "not_found", message: `No record with id '${id}'.`, suggested_tool: "search" } };

  const desc = allowDescriptive();
  const struct = allowStructured();

  if (kind === "item") {
    const it = store.getItem(key);
    if (!it) return notFound;
    const project = store.projectOf(it);
    const text = joinLines(
      `Title: ${it.title}`,
      `AMIRA record: ${itemUrl(it.o_id)}`,
      it.alt_titles.length ? `Alternative titles: ${it.alt_titles.join("; ")}` : null,
      it.type ? `Type: ${it.type}` : null,
      struct && `University: ${UNIVERSITY_LABELS[it.university]}`,
      struct && (project ? `Project: ${project.name}` : it.project ? `Project: ${it.project.label}` : null),
      struct && it.contributors.length
        ? `Contributors: ${it.contributors.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}`
        : null,
      yearLabel(it) ? `Date: ${yearLabel(it)}` : null,
      struct && it.subjects.length ? `Subjects: ${refLabels(it.subjects).join("; ")}` : null,
      struct && it.places.length ? `Places: ${it.places.map((p) => placeWithCountry(store, p.label, p.o_id)).join("; ")}` : null,
      struct && refLabels(it.languages).length ? `Languages: ${refLabels(it.languages).join("; ")}` : null,
      struct && refLabels(it.formats).length ? `Formats: ${refLabels(it.formats).join("; ")}` : null,
      struct && it.sponsors.length ? `Sponsors: ${it.sponsors.join("; ")}` : null,
      struct && it.provenance.length ? `Provenance: ${it.provenance.join("; ")}` : null,
      desc && it.abstract ? `\nAbstract:\n${it.abstract}` : null,
      desc && it.description ? `\nDescription:\n${it.description}` : null,
      desc && it.toc ? `\nTable of contents:\n${it.toc}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: it.title,
      text: body,
      url: itemUrl(it.o_id),
      metadata: compact({
        kind: "research_item",
        omeka_id: it.o_id,
        amira_url: itemUrl(it.o_id),
        type: it.type,
        date: yearLabel(it),
        ...(struct
          ? {
              university: UNIVERSITY_LABELS[it.university],
              project_omeka_id: project?.o_id ?? null,
              subjects: refLabels(it.subjects),
              places: it.places.map((p) => p.label),
            }
          : {}),
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
    const fw = textWindowAppend("fulltext", "Full text", p.fulltext, {
      include: opts.includeFulltext,
      offset: opts.fulltextOffset,
      maxChars: opts.fulltextMaxChars,
    });
    const text = joinLines(
      `Title: ${p.title}`,
      `AMIRA record: ${itemUrl(p.o_id)}`,
      `Type: ${p.type}`,
      struct && p.authors.length ? `Authors: ${refLabels(p.authors).join("; ")}` : null,
      struct && p.editors.length ? `Editors: ${refLabels(p.editors).join("; ")}` : null,
      struct && p.venue ? `Venue: ${p.venue}` : null,
      p.year ? `Year: ${p.year}` : null,
      cite || null,
      p.publisher ? `Publisher: ${p.publisher}` : null,
      p.doi ? `DOI: ${p.doi}` : null,
      p.status ? `Status: ${p.status}` : null,
      desc && p.abstract ? `\nAbstract:\n${p.abstract}` : null,
      fw.append,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.title,
      text: body,
      url: itemUrl(p.o_id),
      metadata: compact({
        kind: "publication",
        omeka_id: p.o_id,
        amira_url: itemUrl(p.o_id),
        type: p.type,
        year: p.year,
        ...(struct
          ? {
              authors: refLabels(p.authors),
              venue: p.venue,
              ...(p.venue_ref?.o_id != null ? { venue_amira_url: itemUrl(p.venue_ref.o_id) } : {}),
            }
          : {}),
        doi: p.doi,
        publication_url: p.doi ?? p.urls[0] ?? null,
        repository_urls: p.urls,
        ...fw.meta,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "video") {
    const v = store.getVideo(Number(key));
    if (!v) return notFound;
    const tw = textWindowAppend("transcript", "Transcript", v.transcript, {
      include: opts.includeTranscript,
      offset: opts.transcriptOffset,
      maxChars: opts.transcriptMaxChars,
    });
    const text = joinLines(
      `Title: ${v.title}`,
      `AMIRA record: ${itemUrl(v.o_id)}`,
      v.date ? `Date: ${v.date}` : null,
      struct && v.speakers.length ? `Speakers: ${v.speakers.map((c) => c.name).join("; ")}` : null,
      struct && v.playlists.length ? `Playlists: ${refLabels(v.playlists).join("; ")}` : null,
      v.url ? `Watch: ${v.url}` : null,
      desc && v.abstract ? `\nDescription:\n${v.abstract}` : null,
      tw.append,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: v.title,
      text: body,
      url: itemUrl(v.o_id),
      metadata: compact({
        kind: "youtube_video",
        omeka_id: v.o_id,
        amira_url: itemUrl(v.o_id),
        date: v.date,
        date_status: dateStatus(v.date),
        ...(struct ? { playlists: refLabels(v.playlists), speakers: v.speakers.map((c) => c.name) } : {}),
        watch_url: v.url,
        ...tw.meta,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "podcast") {
    const p = store.getPodcast(Number(key));
    if (!p) return notFound;
    const tw = textWindowAppend("transcript", "Transcript", p.transcript, {
      include: opts.includeTranscript,
      offset: opts.transcriptOffset,
      maxChars: opts.transcriptMaxChars,
    });
    const text = joinLines(
      `Title: ${p.title}`,
      `AMIRA record: ${itemUrl(p.o_id)}`,
      struct && p.series ? `Series: ${p.series.label}` : null,
      p.episode != null ? `Episode: ${p.episode}` : null,
      p.date ? `Date: ${p.date}` : null,
      struct && p.people.length ? `People: ${p.people.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}` : null,
      p.url ? `Listen: ${p.url}` : null,
      desc && p.abstract ? `\nDescription:\n${p.abstract}` : null,
      tw.append,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.title,
      text: body,
      url: itemUrl(p.o_id),
      metadata: compact({
        kind: "podcast",
        omeka_id: p.o_id,
        amira_url: itemUrl(p.o_id),
        ...(struct ? { series: p.series?.label ?? null } : {}),
        episode: p.episode,
        date: p.date,
        date_status: dateStatus(p.date),
        listen_url: p.url,
        ...tw.meta,
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
      `AMIRA record: ${itemUrl(p.o_id)}`,
      struct && `University: ${UNIVERSITY_LABELS[p.university]}`,
      struct && refLabels(p.sections).length ? `Research sections: ${refLabels(p.sections).join("; ")}` : null,
      struct && refLabels(p.pis).length ? `Principal investigators: ${refLabels(p.pis).join("; ")}` : null,
      struct && refLabels(p.members).length ? `Members: ${refLabels(p.members).join("; ")}` : null,
      struct && refLabels(p.funded_by).length ? `Funded by: ${refLabels(p.funded_by).join("; ")}` : null,
      p.date.start || p.date.end ? `Dates: ${[p.date.start, p.date.end].filter(Boolean).join(" – ")}` : null,
      itemCount ? `Digitised items: ${itemCount}` : null,
      desc && p.description ? `\nDescription:\n${p.description}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: p.name,
      text: body,
      url: itemUrl(p.o_id),
      metadata: compact({
        kind: "project",
        omeka_id: p.o_id,
        amira_url: itemUrl(p.o_id),
        ...(struct ? { university: UNIVERSITY_LABELS[p.university], research_sections: refLabels(p.sections) } : {}),
        item_count: itemCount,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "section") {
    const s = store.getSectionByOId(Number(key));
    if (!s) return notFound;
    const text = joinLines(
      `Research section: ${s.name}`,
      `AMIRA record: ${itemUrl(s.o_id)}`,
      s.date.start || s.date.end ? `Dates: ${[s.date.start, s.date.end].filter(Boolean).join(" – ")}` : null,
      struct && refLabels(s.pis).length ? `Principal investigators: ${refLabels(s.pis).join("; ")}` : null,
      struct && s.spokesperson ? `Spokesperson: ${s.spokesperson}` : null,
      desc && s.description ? `\nDescription:\n${s.description}` : null,
    );
    const { text: body, truncated } = capText(text, opts.maxChars);
    return {
      id,
      title: s.name,
      text: body,
      url: itemUrl(s.o_id),
      metadata: compact({ kind: "research_section", omeka_id: s.o_id, amira_url: itemUrl(s.o_id), dates: s.date, truncated: truncated || undefined }),
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
        "relevance. Covers research items (digitised artefacts), the cluster bibliography (search reaches " +
        "INTO the extracted full text of open-access publications), podcasts and YouTube videos (search " +
        "reaches INTO their transcripts), and the cluster's projects and research sections. Query terms " +
        "are matched individually, so use a few concise keywords, names, places or themes rather than a " +
        "full sentence. Optional `limit` (default 10, max 50) and `types` (restrict to item / publication " +
        "/ video / podcast / project / section) keep the result set tight. Returns " +
        "{ results: [{ id, title, url }] }, where `url` is always the AMIRA/Omeka public record page. " +
        "Pass an `id` to the fetch tool for the full record text. " +
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
      outputSchema: {
        results: z.array(
          z.object({
            id: z.string().describe("Typed record id, e.g. 'item:7392'"),
            title: z.string(),
            url: z.string().describe("The AMIRA/Omeka public record page"),
          }),
        ),
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
        "(e.g. 'item:7392', 'project:37700', 'pub:30001', 'video:39218', " +
        "'podcast:39121', 'section:218'). Returns { id, title, text, url, metadata } — `text` concatenates " +
        "the record's descriptive fields, `url` is the citable AMIRA/Omeka public page, and original DOI, " +
        "watch or listen URLs are included in metadata when available. For videos/podcasts the " +
        "transcript is OMITTED by default (metadata + description only, since a full transcript can run tens " +
        "of thousands of characters); the metadata reports `has_transcript` / `transcript_length`. Pass " +
        "include_transcript=true to append it, and page a long one with transcript_offset / " +
        "transcript_max_chars (same names as get_video / get_podcast, capped at 25,000 chars per call). " +
        "Publications work the same way with their extracted PDF full text: metadata reports " +
        "`has_fulltext` / `fulltext_length`, and include_fulltext=true appends it, paged with " +
        "fulltext_offset / fulltext_max_chars (same names as get_publication). `max_chars` caps the whole " +
        "text body.",
      annotations: annotate("Fetch one AMIRA record"),
      inputSchema: {
        id: z.string().describe("A typed record id from search, e.g. 'item:7392'"),
        include_transcript: z.boolean().optional().describe("Default false — set true to append the video/podcast transcript"),
        transcript_offset: z.number().int().optional().describe("Start offset into the transcript (chars), with include_transcript"),
        transcript_max_chars: z.number().int().optional().describe("Max transcript characters to return (default/max 25000)"),
        include_fulltext: z.boolean().optional().describe("Default false — set true to append a publication's extracted full text"),
        fulltext_offset: z.number().int().optional().describe("Start offset into the full text (chars), with include_fulltext"),
        fulltext_max_chars: z.number().int().optional().describe("Max full-text characters to return (default/max 25000)"),
        max_chars: z.number().int().optional().describe("Cap on the whole returned text body, default/max 25000"),
      },
      outputSchema: {
        id: z.string().optional(),
        title: z.string().optional(),
        text: z.string().optional(),
        url: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        error: z
          .object({ code: z.string(), message: z.string(), suggested_tool: z.string().optional() })
          .optional()
          .describe("Present instead of the record when the id is unknown"),
      },
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars, include_fulltext, fulltext_offset, fulltext_max_chars, max_chars }) => {
      const store = await ensureStore();
      const maxChars = Math.max(1, Math.min(Math.floor(max_chars ?? CHARACTER_LIMIT), CHARACTER_LIMIT));
      return textResult(
        fetchDoc(store, id, {
          includeTranscript: include_transcript ?? false,
          includeFulltext: include_fulltext ?? false,
          maxChars,
          transcriptOffset: transcript_offset,
          transcriptMaxChars: transcript_max_chars,
          fulltextOffset: fulltext_offset,
          fulltextMaxChars: fulltext_max_chars,
        }),
      );
    },
  );
}
