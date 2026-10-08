import type { ToolMap } from "./policy.js";
// Podcasts + YouTube videos — content that exists only in Omeka. Both can carry
// full transcripts (bibo:content): searchable here (with a match snippet),
// never included in summaries, and opt-in + windowable in the get_* detail
// tools via the shared textWindowFields helper. The two corpora share one
// search predicate and one detail shape; only their filters differ.
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { LinkedRef, MediaRec, PodcastRec, VideoRec } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  capLimit,
  capOffset,
  containsCI,
  dateStatus,
  emptySearchHint,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitEcho,
  matchSnippet,
  pageOf,
  podcastSummary,
  refLabels,
  textAccessDisabledResult,
  textResult,
  textWindowFields,
  videoSummary,
  type Server,
} from "./_shared.js";
import { iiifManifestUrl, itemUrl, itemUrlOrNull } from "../urls.js";
import { personMatches } from "../names.js";
import { emptyKeyword, keywordMatches, parseKeyword } from "../matching.js";
import { invalidYearRange } from "../researchItemQuery.js";
import { stripTypedId } from "../typedIds.js";

type TranscriptRecord = PodcastRec | VideoRec;

/** Shared opt-in transcript params for the get_podcast / get_video schemas. */
const transcriptParams = {
  include_transcript: z.boolean().optional().describe("Default false — set true to include the transcript text"),
  transcript_offset: z.number().int().min(0).optional().describe("Start offset into the transcript (chars), with include_transcript"),
  transcript_max_chars: z.number().int().min(1).optional().describe("Max transcript characters to return (default/max 25000)"),
};
const yearParams = {
  year_from: z.number().int().min(0).max(2200).optional().describe("Earliest year"),
  year_to: z.number().int().min(0).max(2200).optional().describe("Latest year"),
};
const pageParams = {
  limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
  offset: z.number().int().min(0).max(100_000).optional(),
};
const keywordParam = z.string().max(1000).optional()
  .describe("Every word must occur in the title, abstract or transcript; quote a phrase to match it exactly");

/**
 * Keyword + year selection shared by both corpora. A record matched only in its
 * transcript is remembered so the summary can carry a snippet.
 */
function selectTranscribed<T extends TranscriptRecord>(
  records: T[], keyword: string | undefined, years: { year_from?: number; year_to?: number }, extra: (r: T) => boolean,
): { filtered: T[]; transcriptOnly: Set<number> } {
  const transcriptOnly = new Set<number>();
  const parsed = keyword ? parseKeyword(keyword) : null;
  const query = parsed && !emptyKeyword(parsed) ? parsed : null;
  const filtered = records.filter((r) => {
    if (query) {
      const meta = [r.title, allowDescriptive() ? r.abstract : null];
      if (!keywordMatches(query, meta)) {
        if (!allowFullText() || !keywordMatches(query, [...meta, r.transcript])) return false;
        transcriptOnly.add(r.o_id);
      }
    }
    if (years.year_from !== undefined && (r.year ?? -Infinity) < years.year_from) return false;
    if (years.year_to !== undefined && (r.year ?? Infinity) > years.year_to) return false;
    return extra(r);
  });
  filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { filtered, transcriptOnly };
}

/** The `transcript_generated_by` block: who or what produced a transcript. */
function generatedBy(ref: LinkedRef | null | undefined): Record<string, unknown> {
  return ref ? { transcript_generated_by: { name: ref.label, amira_url: itemUrlOrNull(ref.o_id) } } : {};
}

const mediaList = (media: MediaRec[] | undefined) => (media ?? []).map((m) => ({ type: m.type, url: m.url, size: m.size }));

export function registerMediaTools(server: Server, tools: ToolMap): void {
  // === search_podcasts ======================================================
  tools.search_podcasts = server.registerTool(
    "search_podcasts",
    {
      title: "Search podcasts",
      description: "Search podcast metadata and transcripts. Text-only hits include snippets; full transcripts require get_podcast with opt-in.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        keyword: keywordParam,
        series: z.string().max(1000).optional().describe("Series title, partial (e.g. 'Cluster Conversations')"),
        person: z.string().max(1000).optional().describe("A speaker/host name; either name order works"),
        language: z.string().max(1000).optional().describe("Name or ISO code — 'French', 'fr', 'fra' all match"),
        ...yearParams,
        ...pageParams,
      }),
    },
    async (args) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", "`year_from` must be less than or equal to `year_to`.");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      for (const key of ["series", "person", "language"] as const) {
        if (args[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
      }
      const { filtered, transcriptOnly } = selectTranscribed(store.podcasts, args.keyword, args, (p) =>
        (!args.series || containsCI(p.series?.label, args.series)) &&
        (!args.person || p.people.some((c) => personMatches(c.name, args.person!))) &&
        (!args.language || store.languageIndex.matches(p.languages, args.language)));

      return textResult({
        ...pageOf(filtered, offset, limit,
          (p) => transcriptOnly.has(p.o_id)
            ? { ...podcastSummary(p), matched_in: "transcript", transcript_snippet: matchSnippet(p.transcript, args.keyword!) }
            : podcastSummary(p),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) }),
        ...emptySearchHint(filtered.length, args),
      });
    },
  );

  // === get_podcast ==========================================================
  tools.get_podcast = server.registerTool(
    "get_podcast",
    {
      title: "Get podcast episode detail",
      description: "Podcast detail, duration, audio file and citation link; says which model generated the transcript. Transcript is opt-in, bounded and pageable.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Podcast id from search_podcasts, e.g. 39121, or podcast:39121"),
        ...transcriptParams,
      }),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars }) => {
      const store = await ensureStore();
      const p = store.getPodcast(Number(stripTypedId(String(id), ["podcast"])));
      if (!p) return errorResult("not_found", `No podcast with id ${id}.`, { suggested_tool: "search_podcasts" });
      if (include_transcript && !allowFullText()) return textAccessDisabledResult("transcript");
      return textResult({
        id: String(p.o_id),
        omeka_id: p.o_id,
        title: p.title,
        episode: p.episode,
        date: p.date,
        date_status: dateStatus(p.date),
        duration: p.duration ?? null,
        abstract: allowDescriptive() ? p.abstract : null,
        ...(allowStructured()
          ? {
              series: p.series ? { title: p.series.label, amira_url: itemUrlOrNull(p.series.o_id) } : null,
              people: p.people.map((c) => ({ name: c.name, role: c.role, ...(c.affiliation ? { affiliation_at_time: c.affiliation.label } : {}) })),
              languages: refLabels(p.languages),
            }
          : {}),
        url: p.url,
        media: mediaList(p.media),
        ...(p.media?.length ? { iiif_manifest: iiifManifestUrl(p.o_id) } : {}),
        ...generatedBy(p.transcript_generated_by),
        ...textWindowFields("transcript", p.transcript, {
          include: include_transcript,
          offset: transcript_offset,
          maxChars: transcript_max_chars,
        }),
        amira_url: itemUrl(p.o_id),
      });
    },
  );

  // === search_videos ========================================================
  tools.search_videos = server.registerTool(
    "search_videos",
    {
      title: "Search YouTube videos",
      description: "Search video metadata and transcripts. Text-only hits include snippets; full transcripts require get_video with opt-in.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        keyword: keywordParam,
        playlist: z.string().max(1000).optional().describe("Playlist title, partial"),
        speaker: z.string().max(1000).optional().describe("A speaker name; either name order works"),
        language: z.string().max(1000).optional().describe("Name or ISO code — 'French', 'fr', 'fra' all match"),
        ...yearParams,
        ...pageParams,
      }),
    },
    async (args) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", "`year_from` must be less than or equal to `year_to`.");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      for (const key of ["playlist", "speaker", "language"] as const) {
        if (args[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
      }
      const { filtered, transcriptOnly } = selectTranscribed(store.videos, args.keyword, args, (v) =>
        (!args.playlist || v.playlists.some((p) => containsCI(p.label, args.playlist!))) &&
        (!args.speaker || v.speakers.some((c) => personMatches(c.name, args.speaker!))) &&
        (!args.language || store.languageIndex.matches(v.languages, args.language)));

      return textResult({
        ...pageOf(filtered, offset, limit,
          (v) => transcriptOnly.has(v.o_id)
            ? { ...videoSummary(v), matched_in: "transcript", transcript_snippet: matchSnippet(v.transcript, args.keyword!) }
            : videoSummary(v),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) }),
        ...emptySearchHint(filtered.length, args),
      });
    },
  );

  // === get_video ============================================================
  tools.get_video = server.registerTool(
    "get_video",
    {
      title: "Get YouTube video detail",
      description: "Video detail, thumbnail and citation link; says how the transcript was produced when recorded. Transcript is opt-in, bounded and pageable.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Video id from search_videos, e.g. 39218, or video:39218"),
        ...transcriptParams,
      }),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars }) => {
      const store = await ensureStore();
      const v = store.getVideo(Number(stripTypedId(String(id), ["video"])));
      if (!v) return errorResult("not_found", `No video with id ${id}.`, { suggested_tool: "search_videos" });
      if (include_transcript && !allowFullText()) return textAccessDisabledResult("transcript");
      return textResult({
        id: String(v.o_id),
        omeka_id: v.o_id,
        title: v.title,
        date: v.date,
        date_status: dateStatus(v.date),
        ...(v.duration ? { duration: v.duration } : {}),
        abstract: allowDescriptive() ? v.abstract : null,
        ...(allowStructured()
          ? {
              playlists: v.playlists.map((p) => ({ title: p.label, amira_url: itemUrlOrNull(p.o_id) })),
              speakers: v.speakers.map((c) => c.name),
              languages: refLabels(v.languages),
            }
          : {}),
        url: v.url,
        thumbnail: v.thumbnail ?? null,
        ...generatedBy(v.transcript_generated_by),
        ...textWindowFields("transcript", v.transcript, {
          include: include_transcript,
          offset: transcript_offset,
          maxChars: transcript_max_chars,
        }),
        amira_url: itemUrl(v.o_id),
      });
    },
  );
}
