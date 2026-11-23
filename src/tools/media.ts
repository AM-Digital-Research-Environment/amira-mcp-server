import { schemaOnce } from "./schemaOnce.js";
import { recordArg } from "./records.js";
import type { ToolMap } from "./policy.js";
// Podcasts + YouTube videos — content that exists only in Omeka. Both can carry
// full transcripts (bibo:content): searchable here (with a match snippet),
// never included in summaries, and opt-in + windowable in the get_* detail
// tools via the shared textWindowFields helper. The two corpora share one
// search tool and one detail tool, each built by a factory from what differs:
// the filters, and the fields a record of either kind carries.
import { z } from "zod";
import { includeSimilarSchema, similarBlock } from "./similar.js";
import { callStore } from "./callStore.js";
import type { DataStore } from "../data.js";
import type { RecordTypes } from "../recordKinds.js";
import type { LinkedRef, MediaRec, PodcastRec, VideoRec } from "../types.js";
import { allowDescriptive, allowFullText, allowStructured } from "../exposure.js";
import { config } from "../config.js";
import {
  READ_ONLY,
  capOffset,
  containsCI,
  dateStatus,
  emptySearchHint,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  idParam,
  limitParam,
  matchSnippet,
  offsetParam,
  pageOf,
  podcastSummary,
  refLabels,
  textAccessDisabledResult,
  textParam,
  textResult,
  textWindowFields,
  transcriptWindowParams,
  videoSummary,
  type Server,
} from "./_shared.js";
import { iiifManifestUrl, itemUrl, itemUrlOrNull } from "../urls.js";
import { personMatches } from "../names.js";
import { emptyKeyword, keywordMatches, parseKeyword } from "../matching.js";
import { invalidYearRange } from "../researchItemQuery.js";
import { INVALID_YEAR_RANGE } from "../errorCodes.js";

type TranscriptRecord = PodcastRec | VideoRec;

/** Shared opt-in transcript params for the get_podcast / get_video schemas. */
const transcriptParams = {
  include_transcript: z.boolean().optional().describe("Default false — set true to include the transcript text"),
  ...transcriptWindowParams,
};
const yearParams = {
  year_from: z.number().int().min(0).max(2200).optional().describe("Earliest year"),
  year_to: z.number().int().min(0).max(2200).optional().describe("Latest year"),
};
const LIMIT = limitParam(20, 100);
const pageParams = { limit: LIMIT.schema, offset: offsetParam };
const keywordParam = textParam().optional()
  .describe("Every word must occur in the title, abstract or transcript; quote a phrase to match it exactly");
const languageParam = () => textParam().optional().describe("Name or ISO code — 'French', 'fr', 'fra' all match");

/**
 * Keyword + year selection shared by both corpora. A record matched only in its
 * transcript is remembered so the summary can carry a snippet; in curator mode,
 * one matched only in its private transcript too (#26).
 */
function selectTranscribed<T extends TranscriptRecord>(
  records: T[], keyword: string | undefined, years: { year_from?: number; year_to?: number }, extra: (r: T) => boolean,
): { filtered: T[]; transcriptOnly: Set<number>; restrictedOnly: Set<number> } {
  const transcriptOnly = new Set<number>();
  const restrictedOnly = new Set<number>();
  const curator = config.access === "curator";
  const parsed = keyword ? parseKeyword(keyword) : null;
  const query = parsed && !emptyKeyword(parsed) ? parsed : null;
  const filtered = records.filter((r) => {
    if (query) {
      const meta = [r.title, allowDescriptive() ? r.abstract : null];
      if (!keywordMatches(query, meta)) {
        if (!allowFullText()) return false;
        if (keywordMatches(query, [...meta, r.transcript])) transcriptOnly.add(r.o_id);
        else if (curator && r.restricted?.fulltext && keywordMatches(query, [...meta, r.restricted.fulltext])) restrictedOnly.add(r.o_id);
        else return false;
      }
    }
    if (years.year_from !== undefined && (r.year ?? -Infinity) < years.year_from) return false;
    if (years.year_to !== undefined && (r.year ?? Infinity) > years.year_to) return false;
    return extra(r);
  });
  filtered.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { filtered, transcriptOnly, restrictedOnly };
}

/** Curator mode: `has_restricted_transcript` when the record's transcript is private (absent in public mode). */
function restrictedTranscriptFlag(r: TranscriptRecord): Record<string, unknown> {
  return config.access === "curator" && r.restricted?.fulltext ? { has_restricted_transcript: true } : {};
}

/** The `transcript_generated_by` block: who or what produced a transcript. */
function generatedBy(ref: LinkedRef | null | undefined): Record<string, unknown> {
  return ref ? { transcript_generated_by: { name: ref.label, amira_url: itemUrlOrNull(ref.o_id) } } : {};
}

const mediaList = (media: MediaRec[] | undefined) =>
  (media ?? []).map((m) => ({ type: m.type, url: m.url, size: m.size, ...(m.visibility ? { visibility: m.visibility } : {}) }));

/** The arguments both search tools share; the kind's own filters are read through `filters`. */
interface SearchArgs { keyword?: string; year_from?: number; year_to?: number; limit?: number; offset?: number }

/** What tells search_podcasts and search_videos apart. */
interface SearchSpec<R extends TranscriptRecord> {
  name: "search_podcasts" | "search_videos";
  title: string;
  description: string;
  /** The kind's structured filters, in schema order; `language` follows them in both. */
  filters: () => Record<string, z.ZodOptional<z.ZodString>>;
  filterKeys: readonly string[];
  records: (store: DataStore) => R[];
  /** The kind's own filters (language is matched alike for both kinds). */
  matches: (filters: Record<string, string | undefined>) => (r: R) => boolean;
  summary: (r: R) => Record<string, unknown>;
}

function registerTranscribedSearch<R extends TranscriptRecord>(server: Server, tools: ToolMap, spec: SearchSpec<R>): void {
  tools[spec.name] = server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      annotations: READ_ONLY,
      inputSchema: schemaOnce(`${spec.name}:in`, () => z.strictObject({
        keyword: keywordParam,
        ...spec.filters(),
        language: languageParam(),
        ...yearParams,
        ...pageParams,
      })),
    },
    async (raw) => {
      const args = raw as SearchArgs;
      const filters = raw as Record<string, string | undefined>;
      if (invalidYearRange(args.year_from, args.year_to)) return errorResult("invalid_range", INVALID_YEAR_RANGE);
      const store = callStore();
      const { limit, echo } = LIMIT.resolve(args.limit);
      const offset = capOffset(args.offset);
      for (const key of [...spec.filterKeys, "language"]) {
        if (filters[key] && !allowStructured()) return exposureRestrictedResult("structured", `The \`${key}\` filter`);
      }
      const { keyword } = args;
      const { language } = filters;
      const ownFilters = spec.matches(filters);
      const { filtered, transcriptOnly, restrictedOnly } = selectTranscribed(spec.records(store), keyword, args, (r) =>
        ownFilters(r) && (!language || store.languageIndex.matches(r.languages, language)));
      const summary = (r: R) => ({ ...spec.summary(r), ...restrictedTranscriptFlag(r) });

      return textResult({
        ...pageOf(filtered, offset, limit,
          (r) => transcriptOnly.has(r.o_id) && keyword
            ? { ...summary(r), matched_in: "transcript", transcript_snippet: matchSnippet(r.transcript, keyword) }
            : restrictedOnly.has(r.o_id) && keyword
              ? { ...summary(r), matched_in: "restricted_transcript", transcript_snippet: matchSnippet(r.restricted?.fulltext, keyword) }
              : summary(r),
          { ...echo, ...filtersEcho(raw) }),
        ...emptySearchHint(filtered.length, raw),
      });
    },
  );
}

/** What tells get_podcast and get_video apart: the fields around the shared ones, in output order. */
interface DetailSpec<K extends "podcast" | "video"> {
  kind: K;
  name: "get_podcast" | "get_video";
  title: string;
  description: string;
  idDescription: string;
  search: "search_podcasts" | "search_videos";
  /** After id, omeka_id and title. */
  head: (r: RecordTypes[K]) => Record<string, unknown>;
  /** After abstract, with the structured exposure level. */
  structured: (r: RecordTypes[K]) => Record<string, unknown>;
  /** After url. */
  media: (r: RecordTypes[K]) => Record<string, unknown>;
}

function registerTranscribedDetail<K extends "podcast" | "video">(server: Server, tools: ToolMap, spec: DetailSpec<K>): void {
  tools[spec.name] = server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      annotations: READ_ONLY,
      inputSchema: schemaOnce(`${spec.name}:in`, () => z.strictObject({
        id: idParam(1000).describe(spec.idDescription),
        ...transcriptParams,
        include_similar: includeSimilarSchema,
      })),
    },
    async ({ id, include_transcript, transcript_offset, transcript_max_chars, include_similar }) => {
      const store = callStore();
      const found = recordArg(store, id, spec.kind,
        () => errorResult("not_found", `No ${spec.kind} with id ${id}.`, { suggested_tool: spec.search }));
      if ("error" in found) return found.error;
      const r = found.record;
      if (include_transcript && !allowFullText()) return textAccessDisabledResult("transcript");
      return textResult({
        id: String(r.o_id),
        omeka_id: r.o_id,
        title: r.title,
        ...spec.head(r),
        abstract: allowDescriptive() ? r.abstract : null,
        ...(allowStructured() ? spec.structured(r) : {}),
        url: r.url,
        ...spec.media(r),
        ...generatedBy(r.transcript_generated_by),
        ...textWindowFields("transcript", r.transcript, {
          include: include_transcript,
          offset: transcript_offset,
          maxChars: transcript_max_chars,
        }),
        ...(include_similar ? { similar: similarBlock(store, spec.kind, r.o_id) } : {}),
        amira_url: itemUrl(r.o_id),
      });
    },
  );
}

export function registerMediaTools(server: Server, tools: ToolMap): void {
  registerTranscribedSearch<PodcastRec>(server, tools, {
    name: "search_podcasts",
    title: "Search podcasts",
    description: "Search podcast metadata and transcripts. Text-only hits include snippets; full transcripts require get_podcast with opt-in.",
    filters: () => ({
      series: textParam().optional().describe("Series title, partial (e.g. 'Cluster Conversations')"),
      person: textParam().optional().describe("A speaker/host name; either name order works"),
    }),
    filterKeys: ["series", "person"],
    records: (store) => store.podcasts,
    matches: ({ series, person }) => (p) =>
      (!series || containsCI(p.series?.label, series)) &&
      (!person || p.people.some((c) => personMatches(c.name, person))),
    summary: podcastSummary,
  });

  registerTranscribedDetail(server, tools, {
    kind: "podcast",
    name: "get_podcast",
    title: "Get podcast episode detail",
    description: "Podcast detail, duration, audio file and citation link; says which model generated the transcript. Transcript is opt-in, bounded and pageable.",
    idDescription: "Podcast id from search_podcasts, e.g. 39121, or podcast:39121",
    search: "search_podcasts",
    head: (p) => ({ episode: p.episode, date: p.date, date_status: dateStatus(p.date), duration: p.duration ?? null }),
    structured: (p) => ({
      series: p.series ? { title: p.series.label, amira_url: itemUrlOrNull(p.series.o_id) } : null,
      people: p.people.map((c) => ({ name: c.name, role: c.role, ...(c.affiliation ? { affiliation_at_time: c.affiliation.label } : {}) })),
      languages: refLabels(p.languages),
    }),
    media: (p) => ({ media: mediaList(p.media), ...(p.media?.length ? { iiif_manifest: iiifManifestUrl(p.o_id) } : {}) }),
  });

  registerTranscribedSearch<VideoRec>(server, tools, {
    name: "search_videos",
    title: "Search YouTube videos",
    description: "Search video metadata and transcripts. Text-only hits include snippets; full transcripts require get_video with opt-in.",
    filters: () => ({
      playlist: textParam().optional().describe("Playlist title, partial"),
      speaker: textParam().optional().describe("A speaker name; either name order works"),
    }),
    filterKeys: ["playlist", "speaker"],
    records: (store) => store.videos,
    matches: ({ playlist, speaker }) => (v) =>
      (!playlist || v.playlists.some((p) => containsCI(p.label, playlist))) &&
      (!speaker || v.speakers.some((c) => personMatches(c.name, speaker))),
    summary: videoSummary,
  });

  registerTranscribedDetail(server, tools, {
    kind: "video",
    name: "get_video",
    title: "Get YouTube video detail",
    description: "Video detail, thumbnail and citation link; says how the transcript was produced when recorded. Transcript is opt-in, bounded and pageable.",
    idDescription: "Video id from search_videos, e.g. 39218, or video:39218",
    search: "search_videos",
    head: (v) => ({ date: v.date, date_status: dateStatus(v.date), ...(v.duration ? { duration: v.duration } : {}) }),
    structured: (v) => ({
      playlists: v.playlists.map((p) => ({ title: p.label, amira_url: itemUrlOrNull(p.o_id) })),
      speakers: v.speakers.map((c) => c.name),
      languages: refLabels(v.languages),
    }),
    media: (v) => ({ thumbnail: v.thumbnail ?? null }),
  });
}
