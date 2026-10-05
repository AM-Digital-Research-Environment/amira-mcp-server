import { invalidYearRange } from "../researchItemQuery.js";
// Podcasts + YouTube videos (issue #1 §4, D4/D13) — content that exists only in
// Omeka. Both can carry full transcripts (bibo:content): searchable here (with a
// match snippet), never included in summaries, and opt-in + windowable in the
// get_* detail tools via the shared textWindowFields helper.
import { z } from "zod";
import { ensureStore } from "../data.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import {
  annotate,
  capLimit,
  capOffset,
  containsCI,
  dateStatus,
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
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

function matchPerson(name: string, query: string): boolean {
  return nameMatchesQuery(name, query) || containsCI(name, query);
}

/** Shared opt-in transcript params for the get_podcast / get_video schemas. */
const transcriptParams = {
  include_transcript: z.boolean().optional().describe("Default false — set true to include the transcript text"),
  transcript_offset: z.number().int().min(0).optional().describe("Start offset into the transcript (chars), with include_transcript"),
  transcript_max_chars: z.number().int().min(1).optional().describe("Max transcript characters to return (default/max 25000)"),
};

export function registerMediaTools(server: Server): void {
  // === search_podcasts ======================================================
  server.registerTool(
    "search_podcasts",
    {
      title: "Search podcasts",
      description: "Search podcast metadata and transcripts. Text-only hits include snippets; full transcripts require get_podcast with opt-in.",
      annotations: annotate("Search podcasts"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Matches title, abstract — and the transcript"),
        series: z.string().max(1000).optional().describe("Series title, partial (e.g. 'Cluster Conversations')"),
        person: z.string().max(1000).optional().describe("A speaker/host name; either name order works"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Earliest episode year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Latest episode year"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      if (args.series && !allowStructured()) return exposureRestrictedResult("structured", "The `series` filter");
      if (args.person && !allowStructured()) return exposureRestrictedResult("structured", "The `person` filter");

      const transcriptOnly = new Set<number>();
      const filtered = store.podcasts.filter((p) => {
        if (args.keyword) {
          const k = args.keyword;
          const inMeta = containsCI(p.title, k) || (allowDescriptive() && containsCI(p.abstract, k));
          const inTranscript = !inMeta && allowFullText() && containsCI(p.transcript, k);
          if (!inMeta && !inTranscript) return false;
          if (inTranscript) transcriptOnly.add(p.o_id);
        }
        if (args.series && !containsCI(p.series?.label, args.series)) return false;
        if (args.person && !p.people.some((c) => matchPerson(c.name, args.person!))) return false;
        if (args.year_from !== undefined && (p.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (p.year ?? Infinity) > args.year_to) return false;
        return true;
      });
      filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (p) =>
            transcriptOnly.has(p.o_id)
              ? { ...podcastSummary(p), matched_in: "transcript", transcript_snippet: matchSnippet(p.transcript, args.keyword!) }
              : podcastSummary(p),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) },
        ),
      );
    },
  );

  // === get_podcast ==========================================================
  server.registerTool(
    "get_podcast",
    {
      title: "Get podcast episode detail",
      description: "Podcast detail and citation link. Transcript is opt-in, bounded and pageable with original character offsets.",
      annotations: annotate("Get podcast detail"),
      inputSchema: z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Podcast id from search_podcasts, e.g. 39121"),
        ...transcriptParams,
      }),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars }) => {
      const store = await ensureStore();
      const p = store.getPodcast(Number(id));
      if (!p) return errorResult("not_found", `No podcast with id ${id}.`, { suggested_tool: "search_podcasts" });
      if (include_transcript && !allowFullText()) return textAccessDisabledResult("transcript");
      return textResult({
        id: p.o_id,
        title: p.title,
        episode: p.episode,
        date: p.date,
        date_status: dateStatus(p.date),
        abstract: allowDescriptive() ? p.abstract : null,
        ...(allowStructured()
          ? {
              series: p.series ? { title: p.series.label, amira_url: itemUrlOrNull(p.series.o_id) } : null,
              people: p.people.map((c) => ({ name: c.name, role: c.role })),
              languages: refLabels(p.languages),
            }
          : {}),
        url: p.url,
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
  server.registerTool(
    "search_videos",
    {
      title: "Search YouTube videos",
      description: "Search video metadata and transcripts. Text-only hits include snippets; full transcripts require get_video with opt-in.",
      annotations: annotate("Search YouTube videos"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Matches title, abstract — and the transcript"),
        playlist: z.string().max(1000).optional().describe("Playlist title, partial"),
        speaker: z.string().max(1000).optional().describe("A speaker name; either name order works"),
        language: z.string().max(1000).optional().describe("Name or ISO code — 'French', 'fr', 'fra' all match"),
        year_from: z.number().int().min(0).max(2200).optional().describe("Earliest upload year"),
        year_to: z.number().int().min(0).max(2200).optional().describe("Latest upload year"),
        limit: z.number().int().min(1).optional().describe("Default 20, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", "year_from must be less than or equal to year_to.");
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);
      if (args.playlist && !allowStructured()) return exposureRestrictedResult("structured", "The `playlist` filter");
      if (args.speaker && !allowStructured()) return exposureRestrictedResult("structured", "The `speaker` filter");
      if (args.language && !allowStructured()) return exposureRestrictedResult("structured", "The `language` filter");

      const transcriptOnly = new Set<number>();
      const filtered = store.videos.filter((v) => {
        if (args.keyword) {
          const k = args.keyword;
          const inMeta = containsCI(v.title, k) || (allowDescriptive() && containsCI(v.abstract, k));
          const inTranscript = !inMeta && allowFullText() && containsCI(v.transcript, k);
          if (!inMeta && !inTranscript) return false;
          if (inTranscript) transcriptOnly.add(v.o_id);
        }
        if (args.playlist && !v.playlists.some((p) => containsCI(p.label, args.playlist!))) return false;
        if (args.speaker && !v.speakers.some((c) => matchPerson(c.name, args.speaker!))) return false;
        if (args.language && !store.languageIndex.matches(v.languages, args.language)) return false;
        if (args.year_from !== undefined && (v.year ?? -Infinity) < args.year_from) return false;
        if (args.year_to !== undefined && (v.year ?? Infinity) > args.year_to) return false;
        return true;
      });
      filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (v) =>
            transcriptOnly.has(v.o_id)
              ? { ...videoSummary(v), matched_in: "transcript", transcript_snippet: matchSnippet(v.transcript, args.keyword!) }
              : videoSummary(v),
          { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) },
        ),
      );
    },
  );

  // === get_video ============================================================
  server.registerTool(
    "get_video",
    {
      title: "Get YouTube video detail",
      description: "Video detail and citation link. Transcript is opt-in, bounded and pageable with original character offsets.",
      annotations: annotate("Get video detail"),
      inputSchema: z.strictObject({
        id: z.union([z.string().max(1000), z.number()]).describe("Video id from search_videos, e.g. 39218"),
        ...transcriptParams,
      }),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars }) => {
      const store = await ensureStore();
      const v = store.getVideo(Number(id));
      if (!v) return errorResult("not_found", `No video with id ${id}.`, { suggested_tool: "search_videos" });
      if (include_transcript && !allowFullText()) return textAccessDisabledResult("transcript");
      return textResult({
        id: v.o_id,
        title: v.title,
        date: v.date,
        date_status: dateStatus(v.date),
        abstract: allowDescriptive() ? v.abstract : null,
        ...(allowStructured()
          ? {
              playlists: v.playlists.map((p) => ({ title: p.label, amira_url: itemUrlOrNull(p.o_id) })),
              speakers: v.speakers.map((c) => c.name),
              languages: refLabels(v.languages),
            }
          : {}),
        url: v.url,
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
