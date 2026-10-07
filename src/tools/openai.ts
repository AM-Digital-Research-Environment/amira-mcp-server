import type { ToolMap } from "./policy.js";
import { runSearch, SEARCH_TYPES, type SearchType } from "../searchRanking.js";
// OpenAI / ChatGPT compatibility tools: `search` and `fetch`.
//
// ChatGPT's Deep Research + connector contract calls exactly two tools, with
// fixed names and shapes:
//   search(query)  -> { results: [{ id, title, url }] }
//   fetch(id)      -> { id, title, text, url, metadata }
// Both must return `structuredContent` alongside the JSON content array — which
// our `textResult` helper already does. These adapters sit OVER the same
// in-memory store the rich tools use; they are registered only on the remote
// HTTP transport (src/http.ts), so the stdio .mcpb keeps its 33-tool surface.
//
// `id` is typed as `<kind>:<omeka_o_id>` (item:7392, pub:30001, video:39218,
// podcast:39121, project:37700, section:218) so fetch can route back and a
// human can reconstruct the Omeka URL from the final number. fetch also accepts
// the research tools' vocabulary (research_item:7392, publication:30001).
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { DataStore } from "../data.js";
import { allowDescriptive, allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  capText,
  CHARACTER_LIMIT,
  dateStatus,
  refLabels,
  textResult,
  textWindowAppend,
  yearLabel,
  type Server,
  type WindowField,
  type WindowOpts,
} from "./_shared.js";
import { itemUrl } from "../urls.js";
import { parseTypedId } from "../typedIds.js";
import { limitEcho } from "./pagination.js";

const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;

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

// Transcript/full-text windowing for `fetch` lives in the shared
// textWindowAppend helper, so the opt-in + offset/max paging contract is the
// same here as in get_video / get_podcast / get_publication (the v1.4.2 fix,
// now enforced by construction).

type DocLine = string | null | undefined | false;

/**
 * Assemble a `fetch` document body: the metadata header, then an optional
 * large-text window sized to whatever `max_chars` leaves AFTER that header.
 *
 * Sizing against the remaining budget (rather than capping the concatenation
 * afterwards) is what keeps `<field>_returned_chars` truthful. Previously the
 * window took its full 25,000 chars, the header pushed the body over
 * `max_chars`, and capText trimmed the tail — so a client paging on
 * `offset + returned_chars` skipped exactly the header's worth of characters.
 * capText stays as the backstop for headers that are themselves oversized.
 */
function docBody(
  head: DocLine[],
  maxChars: number,
  window?: { field: WindowField; label: string; text: string | null; opts: WindowOpts },
): { body: string; truncated: boolean; meta: Record<string, unknown> } {
  const header = joinLines(...head);
  if (!window) {
    const { text, truncated } = capText(header, maxChars);
    return { body: text, truncated, meta: {} };
  }
  const overhead = window.label.length + 3; // "\n" + label + ":" + "\n"
  const budget = maxChars - header.length - overhead;
  const { append, meta } = textWindowAppend(window.field, window.label, window.text, { ...window.opts, budget });
  const { text, truncated } = capText(append ? `${header}${append}` : header, maxChars);
  return { body: text, truncated, meta };
}

interface FetchOpts {
  includeTranscript: boolean;
  includeFulltext: boolean;
  maxChars: number;
  transcriptOffset?: number;
  transcriptMaxChars?: number;
  fulltextOffset?: number;
  fulltextMaxChars?: number;
}

/** The adapter's own id prefixes for each record kind fetch can render. */
const FETCH_KINDS: Record<string, string> = {
  research_item: "item", publication: "pub", video: "video", podcast: "podcast", project: "project", section: "section",
};

function fetchDoc(store: DataStore, id: string, opts: FetchOpts): Record<string, unknown> {
  const parsed = parseTypedId(id);
  const kind = parsed ? FETCH_KINDS[parsed.kind] ?? parsed.kind : id;
  const key = parsed?.key ?? "";
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
    const { body, truncated, meta: fw } = docBody(
      [
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
      ],
      opts.maxChars,
      {
        field: "fulltext",
        label: "Full text",
        text: p.fulltext,
        opts: { include: opts.includeFulltext, offset: opts.fulltextOffset, maxChars: opts.fulltextMaxChars },
      },
    );
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
        ...fw,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "video") {
    const v = store.getVideo(Number(key));
    if (!v) return notFound;
    const { body, truncated, meta: tw } = docBody(
      [
        `Title: ${v.title}`,
        `AMIRA record: ${itemUrl(v.o_id)}`,
        v.date ? `Date: ${v.date}` : null,
        struct && v.speakers.length ? `Speakers: ${v.speakers.map((c) => c.name).join("; ")}` : null,
        struct && v.playlists.length ? `Playlists: ${refLabels(v.playlists).join("; ")}` : null,
        v.url ? `Watch: ${v.url}` : null,
        desc && v.abstract ? `\nDescription:\n${v.abstract}` : null,
      ],
      opts.maxChars,
      {
        field: "transcript",
        label: "Transcript",
        text: v.transcript,
        opts: { include: opts.includeTranscript, offset: opts.transcriptOffset, maxChars: opts.transcriptMaxChars },
      },
    );
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
        ...tw,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "podcast") {
    const p = store.getPodcast(Number(key));
    if (!p) return notFound;
    const { body, truncated, meta: tw } = docBody(
      [
        `Title: ${p.title}`,
        `AMIRA record: ${itemUrl(p.o_id)}`,
        struct && p.series ? `Series: ${p.series.label}` : null,
        p.episode != null ? `Episode: ${p.episode}` : null,
        p.date ? `Date: ${p.date}` : null,
        struct && p.people.length ? `People: ${p.people.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}` : null,
        p.url ? `Listen: ${p.url}` : null,
        desc && p.abstract ? `\nDescription:\n${p.abstract}` : null,
      ],
      opts.maxChars,
      {
        field: "transcript",
        label: "Transcript",
        text: p.transcript,
        opts: { include: opts.includeTranscript, offset: opts.transcriptOffset, maxChars: opts.transcriptMaxChars },
      },
    );
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
        ...tw,
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

export function registerOpenAITools(server: Server, tools: ToolMap): void {
  // === search ===============================================================
  tools.search = server.registerTool(
    "search",
    {
      title: "Search the AMIRA collection",
      description: "Ranked search across items, publications, videos, podcasts, projects and sections. Returns typed IDs, titles and citation URLs. Fetch selected records for evidence.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        query: z
          .string().max(1000)
          .describe(
            "A few keywords, names, places or themes — e.g. 'Yoruba architecture'. Terms are matched " +
              "individually, so concise queries beat full sentences",
          ),
        limit: z.number().int().min(1).optional().describe("Default 10, max 50"),
        types: z.array(z.enum(SEARCH_TYPES)).optional().describe("Restrict to these record kinds"),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            id: z.string().describe("Typed record id, e.g. 'item:7392'"),
            title: z.string(),
            url: z.string().describe("The AMIRA/Omeka public record page"),
          }),
        ),
        requested_limit: z.number().optional(),
        effective_limit: z.number().optional(),
      }),
    },
    async ({ query, limit, types }) => {
      const store = await ensureStore();
      const capped = Math.max(1, Math.min(Math.floor(limit ?? DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT));
      const results = runSearch(store, query, capped, types as SearchType[] | undefined).map((h) => ({
        id: h.id,
        title: h.title,
        url: h.url,
      }));
      return textResult({ results, ...limitEcho(limit, MAX_SEARCH_LIMIT, capped) });
    },
  );

  // === fetch ================================================================
  tools.fetch = server.registerTool(
    "fetch",
    {
      title: "Fetch one AMIRA record",
      description: "Read a typed search result as a cited document. Full text/transcripts are opt-in and pageable; metadata and text respect exposure policy. Unknown ID returns an error.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        id: z
          .string().max(1000)
          .describe("A typed record id from search (item:7392, pub:30001, video:…, podcast:…, project:…, section:…) or resolve_entity"),
        include_transcript: z.boolean().optional().describe("Default false — set true to append the video/podcast transcript"),
        transcript_offset: z.number().int().min(0).optional().describe("Start offset into the transcript (chars), with include_transcript"),
        transcript_max_chars: z.number().int().min(1).optional().describe("Max transcript characters to return (default/max 25000)"),
        include_fulltext: z.boolean().optional().describe("Default false — set true to append a publication's extracted full text"),
        fulltext_offset: z.number().int().min(0).optional().describe("Start offset into the full text (chars), with include_fulltext"),
        fulltext_max_chars: z.number().int().min(1).optional().describe("Max full-text characters to return (default/max 25000)"),
        max_chars: z.number().int().optional().describe("Cap on the whole returned text body, default/max 25000"),
      }),
      outputSchema: z.object({
        id: z.string().optional(),
        title: z.string().optional(),
        text: z.string().optional(),
        url: z.string().optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        error: z
          .object({ code: z.string(), message: z.string(), suggested_tool: z.string().optional() })
          .optional()
          .describe("Present instead of the record when the id is unknown"),
      }),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars, include_fulltext, fulltext_offset, fulltext_max_chars, max_chars }) => {
      const store = await ensureStore();
      const maxChars = Math.max(1, Math.min(Math.floor(max_chars ?? CHARACTER_LIMIT), CHARACTER_LIMIT));
      const payload = fetchDoc(store, id, {
        includeTranscript: include_transcript ?? false,
        includeFulltext: include_fulltext ?? false,
        maxChars,
        transcriptOffset: transcript_offset,
        transcriptMaxChars: transcript_max_chars,
        fulltextOffset: fulltext_offset,
        fulltextMaxChars: fulltext_max_chars,
      });
      return { ...textResult(payload), ...(payload.error ? { isError: true } : {}) };
    },
  );
}
