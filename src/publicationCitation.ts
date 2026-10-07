// Publication exports share name escaping with archival citations. Structured
// names and venues respect the same exposure policy as the detail JSON.
import type { PublicationRec } from "./types.js";
import { allowStructured } from "./exposure.js";
import { bibtexName, cslName, escBibtex, rawBibtex, type CitationFormat, type GeneratedCitation } from "./citation.js";
import { itemUrl } from "./urls.js";

const BIBTEX_ENTRY: Record<string, string> = {
  article: "article",
  book: "book",
  chapter: "incollection",
  conference: "inproceedings",
  doctoral_thesis: "phdthesis",
  working_paper: "techreport",
  journal_issue: "misc",
  book_review: "article",
  online_post: "misc",
  research_data: "misc",
  // Templates 24-32, added upstream 2026-09. BibTeX has no entry for a
  // habilitation, a series editorship or a translation, so they take the
  // nearest honest one rather than a wrong-but-specific one.
  preprint: "misc",
  newspaper_article: "article",
  legal_commentary: "incollection",
  encyclopedia_entry: "incollection",
  translation: "misc",
  series_editorship: "misc",
  habilitation: "misc",
  masters_thesis: "mastersthesis",
  bachelors_thesis: "misc",
};

/** `type` field text for types BibTeX has no entry for (printed by most styles). */
const BIBTEX_TYPE_LABELS: Record<string, string> = {
  habilitation: "Habilitation thesis",
  bachelors_thesis: "Bachelor's thesis",
  translation: "Translation",
};

/** Types whose venue is a periodical (BibTeX `journal`) rather than a book. */
const VENUE_IS_JOURNAL = new Set(["article", "book_review", "newspaper_article"]);
/** Types whose venue is the containing volume (BibTeX `booktitle`). */
const VENUE_IS_BOOKTITLE = new Set([
  "chapter",
  "conference",
  "legal_commentary",
  "encyclopedia_entry",
]);

/** Minimal BibTeX from the structured fields (Omeka carries no raw BibTeX). */
export function publicationBibtex(p: PublicationRec): string {
  const entry = BIBTEX_ENTRY[p.type] ?? "misc";
  const lines: string[] = [];
  const add = (k: string, v: string | null | undefined) => {
    if (v) lines.push(`  ${k} = {${(k === "url" || k === "doi" ? rawBibtex : escBibtex)(v)}}`);
  };
  if (allowStructured()) {
    for (const [role, refs] of [["author", p.authors], ["editor", p.editors]] as const) {
      if (refs.length) lines.push(`  ${role} = {${refs.map((r) => bibtexName(r.label)).join(" and ")}}`);
    }
  }
  add("title", p.title);
  if (allowStructured()) {
    if (VENUE_IS_JOURNAL.has(p.type)) add("journal", p.venue);
    else if (VENUE_IS_BOOKTITLE.has(p.type)) add("booktitle", p.venue);
    add("series", seriesTitle(p));
  }
  add("year", p.year != null ? String(p.year) : null);
  add("volume", p.volume);
  add("number", p.issue);
  add("pages", p.pages);
  add("publisher", p.publisher);
  add("doi", p.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, ""));
  add("isbn", p.isbn);
  add("issn", p.issn);
  add("url", p.doi ?? p.urls[0]);
  add("note", publicationNote(p));
  const typeLabel = BIBTEX_TYPE_LABELS[p.type];
  if (typeLabel) add("type", typeLabel);
  return `@${entry}{${p.pub_id},\n${lines.join(",\n")}\n}`;
}

// Keep the containing journal/book distinct from a monograph's series fallback.
const seriesTitle = (p: PublicationRec): string | null =>
  p.series?.length ? p.series.join("; ") :
    !VENUE_IS_JOURNAL.has(p.type) && !VENUE_IS_BOOKTITLE.has(p.type) ? p.venue : null;
const bareDoi = (p: PublicationRec): string | undefined => p.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
const publicationUrl = (p: PublicationRec): string => p.doi ?? p.urls[0] ?? itemUrl(p.o_id);

function issuedParts(p: PublicationRec): number[] | null {
  if (p.year == null) return null;
  const match = p.date?.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:T|$)/);
  if (!match || Number(match[1]) !== p.year || !match[2]) return [p.year];
  const month = Number(match[2]);
  if (month < 1 || month > 12) return [p.year];
  if (!match[3]) return [p.year, month];
  const day = Number(match[3]);
  const leap = p.year % 4 === 0 && (p.year % 100 !== 0 || p.year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= (days[month - 1] ?? 0) ? [p.year, month, day] : [p.year];
}

function publicationNote(p: PublicationRec): string {
  const notes = [
    `AMIRA: ${itemUrl(p.o_id)}`,
    `Repository identifiers: ${[...new Set([p.pub_id, ...(p.identifiers ?? [])])].join("; ")}`,
  ];
  if (p.num_pages) notes.push(`Number of pages: ${p.num_pages}`);
  if (allowStructured()) {
    if (p.conference_details?.length) notes.push(`Conference: ${p.conference_details.join("; ")}`);
    if (p.access_rights?.length) notes.push(`Access: ${p.access_rights.join("; ")}`);
    if (p.rights?.length) notes.push(`Rights: ${p.rights.join("; ")}`);
    if (p.advisers?.length) notes.push(`Thesis advisers: ${p.advisers.map((r) => r.label).join("; ")}`);
    if (p.degree_granting_institutions?.length) notes.push(`Degree-granting institutions: ${p.degree_granting_institutions.map((r) => r.label).join("; ")}`);
  }
  return notes.join(". ");
}

const RIS_TYPES: Record<string, string> = {
  article: "JOUR", book: "BOOK", chapter: "CHAP", conference: "CONF",
  doctoral_thesis: "THES", masters_thesis: "THES", bachelors_thesis: "THES", habilitation: "THES",
  working_paper: "RPRT", book_review: "JOUR", online_post: "BLOG", research_data: "DATA",
  newspaper_article: "NEWS", encyclopedia_entry: "ENCYC", legal_commentary: "CHAP",
};

/** RIS has no portable distinction for every publication type; M3 keeps it. */
function publicationRis(p: PublicationRec): string {
  const lines = [`TY  - ${RIS_TYPES[p.type] ?? "GEN"}`];
  // Newlines inside metadata must never create additional RIS tags or records.
  const add = (tag: string, value: string | null | undefined) => {
    if (value) lines.push(`${tag}  - ${value.replace(/[\r\n]+/g, " ")}`);
  };
  add("ID", `amira-${p.o_id}`);
  add("TI", p.title);
  add("PY", p.year != null ? String(p.year) : null);
  const dateParts = issuedParts(p);
  if (dateParts && dateParts.length > 1) add("DA", dateParts.join("/"));
  add("M3", p.type);
  if (allowStructured()) {
    for (const ref of p.authors) add("AU", ref.label);
    for (const ref of p.editors) add("A2", ref.label);
    if (VENUE_IS_JOURNAL.has(p.type) || VENUE_IS_BOOKTITLE.has(p.type)) add("T2", p.venue);
    add("T3", seriesTitle(p));
    add("CY", p.places_of_publication.map((r) => r.label).join("; "));
    for (const ref of p.subjects) add("KW", ref.label);
  }
  add("VL", p.volume);
  add("IS", p.issue);
  // Only split a simple page range. E-locators and composite ranges stay intact.
  const range = p.pages?.match(/^([A-Za-z]?\d+)\s*[-–]\s*([A-Za-z]?\d+)$/);
  add("SP", range ? range[1] : p.pages);
  if (range) add("EP", range[2]);
  add("PB", p.publisher);
  add("DO", bareDoi(p));
  add("SN", p.isbn ?? p.issn);
  add("LA", p.language);
  add("UR", publicationUrl(p));
  add("N1", publicationNote(p));
  lines.push("ER  - ");
  return lines.join("\n");
}

const CSL_TYPES: Record<string, string> = {
  article: "article-journal", book: "book", chapter: "chapter", conference: "paper-conference",
  doctoral_thesis: "thesis", masters_thesis: "thesis", bachelors_thesis: "thesis", habilitation: "thesis",
  working_paper: "report", journal_issue: "periodical", book_review: "review-book",
  online_post: "post-weblog", research_data: "dataset", preprint: "article",
  newspaper_article: "article-newspaper", legal_commentary: "chapter", encyclopedia_entry: "entry-encyclopedia",
  series_editorship: "periodical",
};

/** CSL input schema: https://resource.citationstyles.org/schema/v1.0/input/json/csl-data.json */
function publicationCsl(p: PublicationRec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: `amira-${p.o_id}`, "citation-key": p.pub_id,
    type: CSL_TYPES[p.type] ?? "document", title: p.title, genre: p.type,
    URL: publicationUrl(p), note: publicationNote(p),
  };
  const add = (key: string, value: string | null | undefined) => { if (value) out[key] = value; };
  const dateParts = issuedParts(p);
  if (dateParts) out.issued = { "date-parts": [dateParts] };
  if (allowStructured()) {
    if (p.authors.length) out.author = p.authors.map((r) => cslName(r.label));
    if (p.editors.length) out.editor = p.editors.map((r) => cslName(r.label));
    if (VENUE_IS_JOURNAL.has(p.type) || VENUE_IS_BOOKTITLE.has(p.type)) add("container-title", p.venue);
    add("collection-title", seriesTitle(p));
    add("publisher-place", p.places_of_publication.map((r) => r.label).join("; "));
    add("keyword", p.subjects.map((r) => r.label).join("; "));
  }
  add("publisher", p.publisher);
  add("volume", p.volume);
  add("issue", p.issue);
  add("page", p.pages);
  add("number-of-pages", p.num_pages);
  add("DOI", bareDoi(p));
  add("ISBN", p.isbn);
  add("ISSN", p.issn);
  add("language", p.language);
  return out;
}

/** Bibliographic exports deliberately omit abstracts and extracted full text. */
export function publicationCitation(p: PublicationRec, format: CitationFormat = "bibtex"): Pick<GeneratedCitation, "field" | "export"> {
  if (format === "ris") return { field: "ris", export: publicationRis(p) };
  if (format === "csl-json") return { field: "csl_json", export: publicationCsl(p) };
  return { field: "bibtex", export: publicationBibtex(p) };
}
