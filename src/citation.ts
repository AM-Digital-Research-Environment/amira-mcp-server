// Generated citations for research items (issue #4).
//
// Only 31 of ~4,000 items carry `dcterms:bibliographicCitation`, so a model
// asked to cite a digitised artefact has to assemble the reference itself. This
// module does it once, deterministically, from the structured fields the item
// already exposes — mirroring what get_publication does for the bibliography,
// but with the vocabulary archival material actually needs (creator roles,
// medium, holding repository, collection) instead of journal/volume/issue.
//
// Three exports, because the three consumers differ: a readable note-style
// string for prose, BibTeX for LaTeX users, RIS for Zotero/EndNote imports and
// CSL-JSON for citeproc pipelines. Everything is derived from fields already
// returned by get_research_item, so exposure gating is inherited rather than
// re-invented: below `structured`, creators/collection/project/repository are
// dropped and the citation falls back to title + medium + date + amira_url,
// which every level may see. The `amira_url` is always the cited link (D3).
import type { Contributor, ResearchItemRec } from "./types.js";
import { allowStructured } from "./exposure.js";
import { itemUrl } from "./urls.js";

export type CitationFormat = "bibtex" | "ris" | "csl-json";

/** Response field each export format is returned under. */
const EXPORT_FIELD: Record<CitationFormat, "bibtex" | "ris" | "csl_json"> = {
  bibtex: "bibtex",
  ris: "ris",
  "csl-json": "csl_json",
};

/** The platform is the publisher of record for every AMIRA item. */
const PUBLISHER = "AMIRA, Africa Multiple Cluster of Excellence, University of Bayreuth";

/** Roles that make someone the CREATOR of the artefact. */
const CREATOR_ROLES = new Set([
  "author",
  "creator",
  "artist",
  "photographer",
  "filmmaker",
  "film director",
  "director",
  "television director",
  "cinematographer",
  "videographer",
  "composer",
  "arranger",
  "musician",
  "screenwriter",
  "reporter",
  "narrator",
]);

/** Used only when no creator role above is credited: whoever assembled the
 * record. Ordering is not consulted — item order is kept — but roles that
 * describe funding, ownership or custody (Sponsor, Repository, Publisher,
 * Owner, Addressee, …) are deliberately absent: they are not creators. */
const FALLBACK_ROLES = new Set([
  "collector",
  "interviewer",
  "researcher",
  "research team head",
  "research team member",
  "contributor",
  "editor",
  "producer",
  "production company",
  "organizer",
  "artistic director",
]);

/** Roles that read as authorship, so naming them in prose is noise. */
const IMPLICIT_ROLES = new Set(["author", "creator"]);

/** The credit that holds the physical original, when one is named. */
const REPOSITORY_ROLE = "repository";

/** Resource type → BibTeX entry. Plain BibTeX has no artefact entry, so `misc`
 * carries almost everything (the medium survives in `type`/`note`); manuscripts
 * are the one archival case `unpublished` describes better. */
const BIBTEX_ENTRY: Record<string, string> = { manuscript: "unpublished" };

/** Resource type → RIS reference type (the tags Zotero/EndNote key on). */
const RIS_TYPE: Record<string, string> = {
  image: "FIGURE",
  "moving image": "VIDEO",
  audio: "SOUND",
  manuscript: "MANSCPT",
  dataset: "DATA",
  cartographic: "MAP",
  collection: "GEN",
  multimedia: "GEN",
  digital: "GEN",
  bibliography: "GEN",
  text: "GEN",
};

/** Resource type → CSL item type. */
const CSL_TYPE: Record<string, string> = {
  image: "graphic",
  "moving image": "motion_picture",
  audio: "song",
  manuscript: "manuscript",
  dataset: "dataset",
  cartographic: "map",
  text: "document",
};

export interface CitationSources {
  /** Item-set title (the collection the item is filed under), when resolvable. */
  collection: string | null;
  /** Parent project name — often, but not always, the collection title too. */
  project: string | null;
}

export interface GeneratedCitation {
  /** Readable note-style reference, ending on the citable `amira_url`. */
  citation: string;
  /** Response key the export belongs under: `bibtex` | `ris` | `csl_json`. */
  field: "bibtex" | "ris" | "csl_json";
  /** The export itself — a record string, or the CSL-JSON object. */
  export: string | Record<string, unknown>;
}

interface Credit {
  name: string;
  /** Role label as stored, or null when it reads as plain authorship. */
  role: string | null;
}

const lower = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * The creators to put in front of the title: everyone credited with a creator
 * role, else everyone credited with a record-making role, else nobody (an
 * anonymous artefact is cited title-first). Names are deduplicated — the same
 * person is frequently credited twice on one item (Collector *and*
 * Photographer) — keeping their first credit within the winning tier, which is
 * the more specific of the two.
 */
function creditsOf(contributors: Contributor[]): Credit[] {
  const pick = (roles: Set<string>) => contributors.filter((c) => roles.has(lower(c.role)));
  const creators = pick(CREATOR_ROLES);
  const chosen = creators.length ? creators : pick(FALLBACK_ROLES);
  const seen = new Set<string>();
  const credits: Credit[] = [];
  for (const c of chosen) {
    const key = lower(c.name);
    if (!c.name || seen.has(key)) continue;
    seen.add(key);
    credits.push({ name: c.name, role: IMPLICIT_ROLES.has(lower(c.role)) ? null : c.role || null });
  }
  return credits;
}

function repositoryOf(contributors: Contributor[]): string | null {
  return contributors.find((c) => lower(c.role) === REPOSITORY_ROLE)?.name ?? null;
}

/** "1953", "1955–1968", or "n.d." — the same range label the tool returns. */
function dateLabel(it: ResearchItemRec): string {
  if (it.year_min == null) return "n.d.";
  return it.year_max != null && it.year_max !== it.year_min ? `${it.year_min}–${it.year_max}` : String(it.year_min);
}

/** "A", "A and B", "A, B, and C", "A et al." — with each non-authorial role
 * kept in parentheses, the same way contributors read in search results. */
function creditList(credits: Credit[]): string | null {
  if (!credits.length) return null;
  const label = (c: Credit) => (c.role ? `${c.name} (${c.role})` : c.name);
  if (credits.length === 1) return label(credits[0]!);
  if (credits.length === 2) return `${label(credits[0]!)} and ${label(credits[1]!)}`;
  if (credits.length === 3) return `${label(credits[0]!)}, ${label(credits[1]!)}, and ${label(credits[2]!)}`;
  return `${label(credits[0]!)} et al.`;
}

/** Title as a citation segment: quoted, without doubling an existing full stop. */
function quotedTitle(title: string): string {
  return `“${(title || "Untitled").replace(/[.\s]+$/, "")}.”`;
}

/** Close a citation segment with a full stop — unless it already ends in one
 * ("n.d.", "et al.", an abbreviated name), which would double it. */
function sentence(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  return /[.?!]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function joinSegments(segments: (string | null | undefined)[]): string {
  return segments.filter((s): s is string => !!s).join(" ");
}

// --- export formats ----------------------------------------------------------

/** BibTeX braces are markup; corporate names are brace-protected instead, so
 * "Institute of African and Diaspora Studies" is not split on its " and ". */
const escBibtex = (s: string) => s.replace(/[{}]/g, "");
const bibtexName = (name: string) => (name.includes(",") ? escBibtex(name) : `{${escBibtex(name)}}`);

function toBibtex(
  it: ResearchItemRec,
  credits: Credit[],
  repository: string | null,
  sources: CitationSources,
  note: string | null,
): string {
  const entry = BIBTEX_ENTRY[lower(it.type)] ?? "misc";
  const lines: string[] = [];
  const add = (k: string, v: string | null | undefined) => {
    if (v) lines.push(`  ${k} = {${escBibtex(v)}}`);
  };
  if (credits.length) lines.push(`  author = {${credits.map((c) => bibtexName(c.name)).join(" and ")}}`);
  add("title", it.title);
  add("year", it.year_min != null ? String(it.year_min) : null);
  add("type", it.type);
  add("series", sources.collection ?? sources.project);
  add("organization", repository);
  add("howpublished", PUBLISHER);
  add("doi", it.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  add("url", itemUrl(it.o_id));
  // `unpublished` requires a note; every item has one (it always carries its
  // AMIRA id), so the entry is never malformed.
  add("note", note);
  return `@${entry}{amira-${it.o_id},\n${lines.join(",\n")}\n}`;
}

function toRis(
  it: ResearchItemRec,
  credits: Credit[],
  repository: string | null,
  sources: CitationSources,
  note: string | null,
): string {
  const lines: string[] = [`TY  - ${RIS_TYPE[lower(it.type)] ?? "GEN"}`, `ID  - amira-${it.o_id}`];
  const add = (tag: string, v: string | null | undefined) => {
    if (v) lines.push(`${tag}  - ${v.replace(/[\r\n]+/g, " ")}`);
  };
  for (const c of credits) add("AU", c.name);
  add("TI", it.title);
  add("PY", it.year_min != null ? String(it.year_min) : null);
  add("M3", it.type);
  add("T2", sources.collection ?? sources.project);
  add("PB", PUBLISHER);
  add("AV", repository);
  add("DO", it.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  add("UR", itemUrl(it.o_id));
  add("N1", note);
  lines.push("ER  - ");
  return lines.join("\n");
}

/** CSL names: "Surname, Forename" splits into family/given; anything without a
 * comma is an organisation and stays `literal` so citeproc does not invert it. */
function cslName(name: string): Record<string, string> {
  const comma = name.indexOf(",");
  if (comma === -1) return { literal: name };
  const family = name.slice(0, comma).trim();
  const given = name.slice(comma + 1).trim();
  return given ? { family, given } : { literal: name };
}

function toCslJson(
  it: ResearchItemRec,
  credits: Credit[],
  repository: string | null,
  sources: CitationSources,
  note: string | null,
): Record<string, unknown> {
  const dateParts: number[][] = [];
  if (it.year_min != null) {
    dateParts.push([it.year_min]);
    if (it.year_max != null && it.year_max !== it.year_min) dateParts.push([it.year_max]);
  }
  return {
    id: `amira-${it.o_id}`,
    type: CSL_TYPE[lower(it.type)] ?? "document",
    title: it.title,
    ...(credits.length ? { author: credits.map((c) => cslName(c.name)) } : {}),
    ...(dateParts.length ? { issued: { "date-parts": dateParts } } : {}),
    ...(it.type ? { genre: it.type } : {}),
    ...(sources.collection ?? sources.project ? { "collection-title": sources.collection ?? sources.project } : {}),
    ...(repository ? { archive: repository } : {}),
    publisher: PUBLISHER,
    ...(it.doi ? { DOI: it.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "") } : {}),
    URL: itemUrl(it.o_id),
    ...(note ? { note } : {}),
  };
}

// --- entry point --------------------------------------------------------------

/**
 * Build the readable citation plus one machine-readable export for a research
 * item. Nothing here reads the store: the caller resolves the collection title
 * and project name (which it already has for the response body) and passes them
 * in, so this stays a pure function of the record.
 */
export function generateItemCitation(
  it: ResearchItemRec,
  sources: CitationSources,
  format: CitationFormat = "bibtex",
): GeneratedCitation {
  const structured = allowStructured();
  const credits = structured ? creditsOf(it.contributors) : [];
  const repository = structured ? repositoryOf(it.contributors) : null;
  const context: CitationSources = structured ? sources : { collection: null, project: null };

  // The project only earns its own line when it differs from the collection
  // title — for most items the two are verbatim identical.
  const noteParts = [
    context.project && context.project !== context.collection ? `Project: ${context.project}` : null,
    structured && it.provenance.length ? `Provenance: ${it.provenance.join("; ")}` : null,
    `AMIRA item ${it.o_id}`,
  ].filter((s): s is string => !!s);
  const note = noteParts.join(". ");

  const citation = joinSegments([
    sentence(creditList(credits)),
    quotedTitle(it.title),
    sentence([it.type, dateLabel(it)].filter(Boolean).join(", ")),
    sentence(context.collection ?? context.project),
    sentence(repository),
    sentence(PUBLISHER),
    `${itemUrl(it.o_id)}.`,
  ]);

  const exported =
    format === "ris"
      ? toRis(it, credits, repository, context, note)
      : format === "csl-json"
        ? toCslJson(it, credits, repository, context, note)
        : toBibtex(it, credits, repository, context, note);

  return { citation, field: EXPORT_FIELD[format], export: exported };
}
