// Cross-cutting helpers shared by every tool module: result/annotation
// formatting, input capping, pagination, case-insensitive text matching, text
// capping, and the entity -> summary mappers that attach a citable amira
// dashboard URL to every record.
import type { CollectionItem, Person, Project, Publication, ResearchSection } from "../types.js";
import { EXTERNAL_SECTION, UNIVERSITY_LABELS } from "../data.js";
import {
  institutionUrl,
  personUrl,
  projectUrl,
  publicationsUrl,
  researchItemUrl,
  researchSectionUrl,
  subjectUrl,
} from "../urls.js";

export type Server = import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// --- result / annotation helpers --------------------------------------------

export function annotate(title: string) {
  return {
    title,
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
}

/** Standard tool result: pretty JSON text plus structuredContent for clients
 * that consume structured data. Payloads must be plain objects. */
export function textResult(payload: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

// --- input capping (lenient clamp, not rejection) ---------------------------

export function capLimit(v: number | undefined, def: number, max: number): number {
  if (v === undefined || Number.isNaN(v)) return def;
  return Math.max(1, Math.min(Math.floor(v), max));
}

export function capOffset(v: number | undefined): number {
  if (v === undefined || Number.isNaN(v)) return 0;
  return Math.max(0, Math.floor(v));
}

export function capText(text: string, limit = CHARACTER_LIMIT): { text: string; truncated?: boolean } {
  if (text.length <= limit) return { text };
  return { text: text.slice(0, limit), truncated: true };
}

// --- pagination -------------------------------------------------------------

export interface Page<T> {
  count: number;
  total_matches: number;
  offset: number;
  has_more: boolean;
  next_offset?: number;
  results: T[];
  [k: string]: unknown;
}

export function paginate<T>(
  all: T[],
  offset: number,
  limit: number,
  extra: Record<string, unknown> = {},
): Page<T> {
  const total = all.length;
  const results = all.slice(offset, offset + limit);
  const hasMore = offset + results.length < total;
  const env: Page<T> = {
    ...extra,
    count: results.length,
    total_matches: total,
    offset,
    has_more: hasMore,
    results,
  };
  if (hasMore) env.next_offset = offset + limit;
  return env;
}

// --- text matching ----------------------------------------------------------

export function containsCI(haystack: string | null | undefined, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

export function anyContainsCI(arr: (string | null | undefined)[] | undefined, needle: string): boolean {
  if (!arr) return false;
  const n = needle.toLowerCase();
  return arr.some((s) => !!s && s.toLowerCase().includes(n));
}

export function equalsCI(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

// --- entity field helpers ---------------------------------------------------

export function mainTitle(item: CollectionItem): string {
  const titles = item.titleInfo ?? [];
  const main = titles.find((t) => t.title_type?.toLowerCase() === "main");
  return main?.title ?? titles[0]?.title ?? "(untitled)";
}

export function itemSubjects(item: CollectionItem): string[] {
  return (item.subject ?? []).map((s) => s.authLabel || s.origLabel).filter(Boolean);
}

export function itemContributors(item: CollectionItem): { name: string; role: string; qualifier: string }[] {
  return (item.name ?? [])
    .filter((n) => n?.name?.label)
    .map((n) => ({ name: n.name.label, role: n.role || "", qualifier: n.name.qualifier || "" }));
}

export function primaryPlace(item: CollectionItem): string | null {
  const o = item.location?.origin?.[0];
  if (!o) return null;
  return [o.l3, o.l2, o.l1].filter(Boolean).join(", ") || null;
}

// --- summary mappers (each carries a citable dashboard_url) ------------------

export function itemSummary(item: CollectionItem): Record<string, unknown> {
  return {
    dre_id: item.dre_id,
    title: mainTitle(item),
    type_of_resource: item.typeOfResource || null,
    project: item.project?.name ?? null,
    project_id: item.project?.id ?? null,
    university: UNIVERSITY_LABELS[item.university],
    contributors: itemContributors(item).map((c) => `${c.name}${c.role ? ` (${c.role})` : ""}`),
    subjects: itemSubjects(item),
    place: primaryPlace(item),
    tags: item.tags ?? [],
    dashboard_url: researchItemUrl(item.dre_id),
  };
}

export function projectSummary(p: Project, itemCount?: number): Record<string, unknown> {
  return {
    id: p.id,
    name: p.name,
    university: UNIVERSITY_LABELS[p.university],
    research_sections: p.researchSection ?? [],
    principal_investigators: p.pi ?? [],
    ...(itemCount !== undefined ? { item_count: itemCount } : {}),
    dashboard_url: projectUrl(p.id),
  };
}

export function personSummary(p: Person): Record<string, unknown> {
  return {
    name: p.name,
    affiliation: p.affiliation ?? [],
    dashboard_url: personUrl(p.name),
  };
}

export function institutionSummary(name: string): Record<string, unknown> {
  return { name, dashboard_url: institutionUrl(name) };
}

/**
 * Derive the cluster funding phase from a section's date range. The cluster
 * redefined its research sections between phases — AM 1.0 (2019–2025) and
 * AM 2.0 (2026–2032) — and each section record is dated to its phase. The
 * synthetic "External" grouping is not a funding phase, so it returns null.
 */
export function fundingPhase(s: ResearchSection): string | null {
  if (equalsCI(s.name, EXTERNAL_SECTION)) return null;
  const start = s.date?.start;
  if (!start) return null;
  const year = Number(start.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return year >= 2026 ? "AM 2.0 (2026–2032)" : "AM 1.0 (2019–2025)";
}

/** Truncate free text to a short preview for list/summary views. */
function brief(text: string | undefined, n = 280): string | null {
  if (!text) return null;
  return text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`;
}

export function sectionSummary(
  s: ResearchSection,
  counts: { projectCount?: number; itemCount?: number } = {},
): Record<string, unknown> {
  return {
    name: s.name,
    funding_phase: fundingPhase(s),
    date: s.date ?? null,
    principal_investigators: s.pi ?? [],
    member_count: (s.members ?? []).length,
    ...(counts.projectCount !== undefined ? { project_count: counts.projectCount } : {}),
    ...(counts.itemCount !== undefined ? { item_count: counts.itemCount } : {}),
    description: brief(s.description),
    dashboard_url: researchSectionUrl(s.name),
  };
}

export function subjectEntry(label: string, count: number): Record<string, unknown> {
  return { subject: label, item_count: count, dashboard_url: subjectUrl(label) };
}

export function publicationSummary(p: Publication): Record<string, unknown> {
  const authors = (p.authors ?? []).map((a) => a.normalized || a.raw);
  return {
    id: p.id,
    title: p.title,
    type: p.type,
    year: p.year ?? null,
    authors,
    venue: p.journal ?? p.booktitle ?? p.series ?? null,
    doi: p.doi ?? null,
    // The publication's own canonical link (DOI or repository permalink).
    url: p.url ?? p.eref_url ?? p.epub_url ?? null,
    // Dashboard page where the cluster bibliography is browsable.
    dashboard_url: publicationsUrl(),
  };
}
