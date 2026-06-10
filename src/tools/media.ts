// Podcasts + YouTube videos (issue #1 §4, D4/D13) — content that exists only in
// Omeka. Both can carry full transcripts (bibo:content): searchable here, never
// included in summaries, capped in the get_* detail tools.
import { z } from "zod";
import { ensureStore } from "../data.js";
import {
  annotate,
  capLimit,
  capOffset,
  capText,
  containsCI,
  filtersEcho,
  pageOf,
  podcastSummary,
  refLabels,
  textResult,
  videoSummary,
  type Server,
} from "./_shared.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

function matchPerson(name: string, query: string): boolean {
  return nameMatchesQuery(name, query) || containsCI(name, query);
}

export function registerMediaTools(server: Server): void {
  // === search_podcasts ======================================================
  server.registerTool(
    "search_podcasts",
    {
      title: "Search podcasts",
      description:
        "Search the cluster's podcast episodes (e.g. the 'Cluster Conversations' series; ~43 episodes). " +
        "Filters (optional, AND-combined):\n" +
        "  - keyword: match title, abstract — and the transcript when one exists (none do in the current " +
        "snapshot; the field is ready for when they land). A transcript-only hit is flagged " +
        "`matched_in: 'transcript'`\n" +
        "  - series: series title (partial)\n" +
        "  - person: a speaker/host name (either order)\n" +
        "  - year_from / year_to\n" +
        "  - limit (default 20, max 100), offset\n\n" +
        "Each result: id, title, series, episode, date, people (with roles), episode url, " +
        "has_transcript, `amira_url`. Use get_podcast for full detail + transcript.",
      annotations: annotate("Search podcasts"),
      inputSchema: {
        keyword: z.string().optional(),
        series: z.string().optional(),
        person: z.string().optional(),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const transcriptOnly = new Set<number>();
      const filtered = store.podcasts.filter((p) => {
        if (args.keyword) {
          const k = args.keyword;
          const inMeta = containsCI(p.title, k) || containsCI(p.abstract, k);
          const inTranscript = !inMeta && containsCI(p.transcript, k);
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
          (p) => ({
            ...podcastSummary(p),
            ...(transcriptOnly.has(p.o_id) ? { matched_in: "transcript" } : {}),
          }),
          filtersEcho(args),
        ),
      );
    },
  );

  // === get_podcast ==========================================================
  server.registerTool(
    "get_podcast",
    {
      title: "Get podcast episode detail",
      description:
        "Full detail for one podcast episode by `id` (the numeric id returned by search_podcasts). " +
        "Returns title, series, episode number, date, abstract, people with roles, the episode URL, the " +
        "full transcript when available (truncated at 25,000 characters, with transcript_length; " +
        "currently no episode carries one), and the citable `amira_url`. Returns { error } if unknown.",
      annotations: annotate("Get podcast detail"),
      inputSchema: { id: z.number().int().describe("Podcast id from search_podcasts") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const p = store.getPodcast(id);
      if (!p) return textResult({ error: `No podcast with id ${id}. Use search_podcasts to find ids.` });
      const transcript = p.transcript ? capText(p.transcript) : null;
      return textResult({
        id: p.o_id,
        title: p.title,
        series: p.series ? { title: p.series.label, amira_url: itemUrlOrNull(p.series.o_id) } : null,
        episode: p.episode,
        date: p.date,
        abstract: p.abstract,
        people: p.people.map((c) => ({ name: c.name, role: c.role })),
        languages: refLabels(p.languages),
        url: p.url,
        transcript: transcript?.text ?? null,
        transcript_truncated: transcript?.truncated || undefined,
        transcript_length: p.transcript?.length ?? 0,
        amira_url: itemUrl(p.o_id),
      });
    },
  );

  // === search_videos ========================================================
  server.registerTool(
    "search_videos",
    {
      title: "Search YouTube videos",
      description:
        "Search the Africa Multiple YouTube channel videos catalogued in the collection (~140 videos, " +
        "lectures/interviews/events; 91 carry full transcripts). Filters (optional, AND-combined):\n" +
        "  - keyword: match title, abstract — and the TRANSCRIPT. A transcript-only hit is flagged " +
        "`matched_in: 'transcript'` (this is the main full-text search over cluster talks)\n" +
        "  - playlist: playlist title (partial)\n" +
        "  - speaker: a speaker name (either order)\n" +
        "  - language: name or ISO code\n" +
        "  - year_from / year_to (upload year)\n" +
        "  - limit (default 20, max 100), offset\n\n" +
        "Each result: id, title, date, playlists, speakers, watch url, has_transcript, `amira_url`. " +
        "Use get_video for full detail + transcript.",
      annotations: annotate("Search YouTube videos"),
      inputSchema: {
        keyword: z.string().optional(),
        playlist: z.string().optional(),
        speaker: z.string().optional(),
        language: z.string().optional(),
        year_from: z.number().int().optional(),
        year_to: z.number().int().optional(),
        limit: z.number().int().optional().describe("Default 20, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 20, 100);
      const offset = capOffset(args.offset);

      const transcriptOnly = new Set<number>();
      const filtered = store.videos.filter((v) => {
        if (args.keyword) {
          const k = args.keyword;
          const inMeta = containsCI(v.title, k) || containsCI(v.abstract, k);
          const inTranscript = !inMeta && containsCI(v.transcript, k);
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
          (v) => ({
            ...videoSummary(v),
            ...(transcriptOnly.has(v.o_id) ? { matched_in: "transcript" } : {}),
          }),
          filtersEcho(args),
        ),
      );
    },
  );

  // === get_video ============================================================
  server.registerTool(
    "get_video",
    {
      title: "Get YouTube video detail",
      description:
        "Full detail for one YouTube video by `id` (the numeric id returned by search_videos). Returns " +
        "title, upload date, abstract, playlists, speakers, languages, the watch URL, the full " +
        "transcript when available (truncated at 25,000 characters, with transcript_length so you can " +
        "tell), and the citable `amira_url`. Returns { error } if unknown.",
      annotations: annotate("Get video detail"),
      inputSchema: { id: z.number().int().describe("Video id from search_videos") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const v = store.getVideo(id);
      if (!v) return textResult({ error: `No video with id ${id}. Use search_videos to find ids.` });
      const transcript = v.transcript ? capText(v.transcript) : null;
      return textResult({
        id: v.o_id,
        title: v.title,
        date: v.date,
        abstract: v.abstract,
        playlists: v.playlists.map((p) => ({ title: p.label, amira_url: itemUrlOrNull(p.o_id) })),
        speakers: v.speakers.map((c) => c.name),
        languages: refLabels(v.languages),
        url: v.url,
        transcript: transcript?.text ?? null,
        transcript_truncated: transcript?.truncated || undefined,
        transcript_length: v.transcript?.length ?? 0,
        amira_url: itemUrl(v.o_id),
      });
    },
  );
}
