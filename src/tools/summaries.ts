// Search-result summaries and slim references: the record shapes every list
// tool returns, each with a citable `amira_url`. Lists inside a summary are
// capped (with a `_total` count) so a full page stays under the size at which
// hosts move a result out of the conversation; detail lives in the get_* tools.
import type { DataStore } from "../data.js";
import { UNIVERSITY_LABELS } from "../data.js";
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { allowStructured } from "../exposure.js";
import type {
  PersonRec,
  PodcastRec,
  ProjectRec,
  PublicationRec,
  ResearchItemRec,
  SectionRec,
  VideoRec,
} from "../types.js";

import { brief, refLabels, equalsCI, dateStatus } from "./matching.js";
// --- entity summaries (search results) -----------------------------------------

/** "1953" / "1950–1960" from an item's content-date year range. */
export function yearLabel(it: ResearchItemRec): string | null {
  if (it.year_min == null) return null;
  return it.year_max != null && it.year_max !== it.year_min ? `${it.year_min}–${it.year_max}` : String(it.year_min);
}

/** Entries shown per list inside a search summary; the rest is counted. */
const SUMMARY_LIST_CAP = 6;

/** `{ [key]: first N, [key_total]: N }` — the total only when the list was cut. */
function capped(key: string, values: string[]): Record<string, unknown> {
  return values.length > SUMMARY_LIST_CAP
    ? { [key]: values.slice(0, SUMMARY_LIST_CAP), [`${key}_total`]: values.length }
    : { [key]: values };
}

/** Distinct MIME types of a record's media files. */
export function mediaTypes(media: { type: string | null }[] | undefined): string[] {
  return [...new Set((media ?? []).map((m) => m.type).filter((t): t is string => !!t))];
}

/** Search-result summary of a research item. */
export function itemSummary(it: ResearchItemRec, store: DataStore): Record<string, unknown> {
  const project = store.projectOf(it);
  const types = mediaTypes(it.media);
  return {
    id: String(it.o_id),
    omeka_id: it.o_id,
    title: it.title,
    type: it.type,
    date: yearLabel(it),
    // Relational metadata (project, people, subjects, places) is structured-level.
    ...(allowStructured()
      ? {
          project: it.project?.label ?? null,
          project_omeka_id: project?.o_id ?? null,
          university: UNIVERSITY_LABELS[it.university],
          ...capped("contributors", it.contributors.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`)),
          ...capped("subjects", refLabels(it.subjects)),
          place: it.places[0]?.label ?? null,
        }
      : {}),
    has_media: it.has_media,
    ...(types.length ? { media_types: types } : {}),
    amira_url: itemUrl(it.o_id),
  };
}

/** SLIM item reference for profile/related views (detail is one get away). */
export function itemRef(it: ResearchItemRec): Record<string, unknown> {
  return {
    id: String(it.o_id),
    omeka_id: it.o_id,
    title: it.title,
    type: it.type,
    date: yearLabel(it),
    amira_url: itemUrl(it.o_id),
  };
}

export function projectSummary(p: ProjectRec, itemCount?: number): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    name: p.name,
    university: UNIVERSITY_LABELS[p.university],
    research_sections: refLabels(p.sections),
    principal_investigators: refLabels(p.pis),
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
    amira_url: itemUrl(p.o_id),
  };
}

export function personSummary(p: PersonRec): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    name: p.name,
    affiliations: refLabels(p.affiliations),
    amira_url: itemUrl(p.o_id),
  };
}

/**
 * Funding phase from a section's date range: the cluster redefined its sections
 * between AM 1.0 (2019–2025) and AM 2.0 (2026–2032); the synthetic "External"
 * grouping is not a phase.
 */
export function fundingPhase(s: SectionRec): string | null {
  if (equalsCI(s.name, "External")) return null;
  const year = Number((s.date.start ?? "").slice(0, 4));
  if (!Number.isFinite(year) || year === 0) return null;
  return year >= 2026 ? "AM 2.0 (2026–2032)" : "AM 1.0 (2019–2025)";
}

export function sectionSummary(
  s: SectionRec,
  counts: { projectCount?: number; itemCount?: number } = {},
): Record<string, unknown> {
  return {
    name: s.name,
    funding_phase: fundingPhase(s),
    date: s.date,
    principal_investigators: refLabels(s.pis),
    member_count: s.members.length,
    id: String(s.o_id),
    omeka_id: s.o_id,
    ...(counts.projectCount !== undefined ? { project_count: counts.projectCount } : {}),
    ...(counts.itemCount !== undefined ? { item_count: counts.itemCount } : {}),
    description: brief(s.description),
    website: s.url,
    amira_url: itemUrl(s.o_id),
  };
}

export function publicationSummary(p: PublicationRec): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    title: p.title,
    type: p.type,
    year: p.year,
    // Authors and venue are structured-level metadata.
    ...(allowStructured() ? { authors: refLabels(p.authors), venue: p.venue } : {}),
    doi: p.doi,
    // The publication's own canonical link (DOI, else repository permalink).
    url: p.doi ?? p.urls[0] ?? null,
    has_fulltext: !!p.fulltext,
    amira_url: itemUrl(p.o_id),
  };
}

export function podcastSummary(p: PodcastRec): Record<string, unknown> {
  return {
    id: String(p.o_id),
    omeka_id: p.o_id,
    title: p.title,
    episode: p.episode,
    date: p.date,
    date_status: dateStatus(p.date),
    ...(allowStructured()
      ? { series: p.series?.label ?? null, people: p.people.map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`) }
      : {}),
    url: p.url,
    ...(p.duration ? { duration: p.duration } : {}),
    has_transcript: !!p.transcript,
    amira_url: itemUrl(p.o_id),
  };
}

export function videoSummary(v: VideoRec): Record<string, unknown> {
  return {
    id: String(v.o_id),
    omeka_id: v.o_id,
    title: v.title,
    date: v.date,
    date_status: dateStatus(v.date),
    ...(allowStructured() ? { playlists: refLabels(v.playlists), ...capped("speakers", v.speakers.map((c) => c.name)) } : {}),
    url: v.url,
    has_transcript: !!v.transcript,
    amira_url: itemUrl(v.o_id),
  };
}

export function subjectEntry(label: string, oId: number | null, count: number): Record<string, unknown> {
  return { subject: label, ...(oId != null ? { id: String(oId), omeka_id: oId } : {}), item_count: count, amira_url: itemUrlOrNull(oId) };
}
