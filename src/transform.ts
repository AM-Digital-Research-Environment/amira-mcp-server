// Omeka JSON-LD items → snapshot records (ROADMAP §2.4). One function per
// corpus; all evidence for the term choices is scripts/census-report.json.
// Used by the build-time fetcher and the runtime live refresh alike.

import {
  allStrings,
  firstLinked,
  firstString,
  itemSetIds,
  linkedRefs,
  oid,
  omekaTitle,
  systemDate,
  thumbnailUrl,
  uriValues,
  values,
  valueText,
  vocabTerms,
  yearOf,
  type OmekaItem,
} from "./omekaJSON.js";
import type {
  Contributor,
  ItemDates,
  JournalRec,
  LanguageRec,
  LinkedRef,
  LocationRec,
  OrganisationRec,
  PersonRec,
  PlaylistRec,
  PodcastRec,
  ProjectRec,
  PublicationRec,
  RelatedRef,
  ResearchItemRec,
  SectionRec,
  University,
  VideoRec,
} from "./types.js";

/** Labels/terms the transform needs from the API, resolved once per crawl. */
export interface TransformContext {
  /** marcrel:aut -> "author" etc. (from /api/properties). */
  roleLabel(term: string): string | null;
  /** resource-class o:id -> term, e.g. 297 -> "fabio:JournalArticle". */
  classTerm(id: number | null): string | null;
}

export function uniFromDreId(dreId: string | null | undefined): University {
  const id = dreId ?? "";
  if (id.startsWith("UBT_")) return "ubt";
  if (id.startsWith("ULG_")) return "unilag";
  if (id.startsWith("UJKZ_")) return "ujkz";
  if (id.startsWith("UFB_")) return "ufba";
  return "external";
}

const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** All marcrel:* credits on an item, with readable role labels. */
function contributorsOf(item: OmekaItem, ctx: TransformContext): Contributor[] {
  const out: Contributor[] = [];
  for (const term of vocabTerms(item)) {
    if (!term.startsWith("marcrel:")) continue;
    const role = cap(ctx.roleLabel(term) ?? term.slice("marcrel:".length));
    for (const v of values(item, term)) {
      const name = valueText(v);
      if (!name) continue;
      out.push({ name, role, o_id: typeof v.value_resource_id === "number" ? v.value_resource_id : null });
    }
  }
  return out;
}

// --- research items -----------------------------------------------------------

/** Date term -> short key. Rights/admin dates are exposed but do not drive content-year ranges. */
const DATE_TERMS: Record<string, string> = {
  "dcterms:created": "created",
  "fabio:hasDateCollected": "collected",
  "dcterms:issued": "issued",
  "dcterms:dateCopyrighted": "copyrighted",
  "dcterms:date": "date",
  "dcterms:available": "available",
  "dcterms:valid": "valid",
  "dcterms:modified": "modified",
};
const NON_CONTENT_DATE_KEYS = new Set(["copyrighted", "available", "valid", "modified"]);

const RELATED_TERMS: Record<string, string> = {
  "dcterms:replaces": "replaces",
  "dcterms:isReplacedBy": "replaced by",
  "dcterms:hasVersion": "has version",
  "dcterms:isVersionOf": "version of",
  "dcterms:hasFormat": "has format",
};

function datesOf(item: OmekaItem): { dates: ItemDates; year_min: number | null; year_max: number | null } {
  const dates: ItemDates = {};
  const years: number[] = [];
  for (const [term, key] of Object.entries(DATE_TERMS)) {
    const texts = allStrings(item, term);
    if (texts.length === 0) continue;
    dates[key] = texts.join("; ");
    if (NON_CONTENT_DATE_KEYS.has(key)) continue;
    for (const t of texts) {
      // timestamps ("2013-01-01") and intervals ("2021-07-01/2023-01-31") alike
      for (const m of t.matchAll(/\d{4}/g)) {
        const y = yearOf(m[0]);
        if (y != null) years.push(y);
      }
    }
  }
  return {
    dates,
    year_min: years.length ? Math.min(...years) : null,
    year_max: years.length ? Math.max(...years) : null,
  };
}

export function transformResearchItem(
  item: OmekaItem,
  ctx: TransformContext,
  universityOfProject: (projectOId: number | null) => University,
): ResearchItemRec {
  const formats: LinkedRef[] = [];
  const formatNotes: string[] = [];
  for (const v of values(item, "dcterms:format")) {
    const label = valueText(v);
    if (!label) continue;
    if (typeof v.value_resource_id === "number") formats.push({ label, o_id: v.value_resource_id });
    else formatNotes.push(label);
  }

  const related: RelatedRef[] = [];
  for (const [term, relation] of Object.entries(RELATED_TERMS)) {
    for (const ref of linkedRefs(item, term)) related.push({ relation, ref });
  }

  const project = firstLinked(item, "dcterms:isPartOf");
  const { dates, year_min, year_max } = datesOf(item);

  return {
    o_id: oid(item),
    dre_id: firstString(item, "dre:id") ?? `omeka-${oid(item)}`,
    title: omekaTitle(item),
    alt_titles: [
      ...allStrings(item, "fabio:hasTranslatedTitle"),
      ...allStrings(item, "fabio:hasSubtitle"),
      ...allStrings(item, "dcterms:alternative"),
    ],
    type: firstString(item, "dcterms:type"),
    project,
    subjects: linkedRefs(item, "dcterms:subject"),
    places: linkedRefs(item, "dcterms:spatial"),
    languages: linkedRefs(item, "dcterms:language"),
    formats,
    format_notes: formatNotes,
    contributors: contributorsOf(item, ctx),
    dates,
    year_min,
    year_max,
    description: allStrings(item, "dcterms:description").join("\n") || null,
    abstract: firstString(item, "dcterms:abstract"),
    toc: firstString(item, "dcterms:tableOfContents"),
    audiences: allStrings(item, "dcterms:audience"),
    sponsors: allStrings(item, "frapo:isFundedBy"),
    provenance: allStrings(item, "dcterms:provenance"),
    access_rights: allStrings(item, "dcterms:accessRights"),
    license: firstString(item, "dcterms:license"),
    identifiers: allStrings(item, "dcterms:identifier"),
    doi: uriValues(item, "bibo:doi")[0]?.url ?? null,
    urls: uriValues(item, "fabio:hasURL").map((u) => u.url),
    collection_url: uriValues(item, "dre:collectionUrl")[0]?.url ?? null,
    related,
    citation: allStrings(item, "dcterms:bibliographicCitation"),
    wisski_url: uriValues(item, "dre:wisskiUrl")[0]?.url ?? null,
    has_media: Array.isArray(item["o:media"]) && item["o:media"].length > 0,
    thumbnail: thumbnailUrl(item),
    item_sets: itemSetIds(item),
    university: universityOfProject(project?.o_id ?? null),
  };
}

/** An item set (collection) — fetched from /api/item_sets, not /api/items. */
export function transformItemSet(itemSet: OmekaItem): { o_id: number; title: string } {
  return { o_id: oid(itemSet), title: omekaTitle(itemSet) };
}

// --- authorities & registry corpora -------------------------------------------

export function transformPerson(item: OmekaItem): PersonRec {
  return {
    o_id: oid(item),
    name: omekaTitle(item),
    affiliations: linkedRefs(item, "dcterms:isPartOf"),
  };
}

export function transformOrganisation(item: OmekaItem): OrganisationRec {
  const type = (firstString(item, "dcterms:type") ?? "").toLowerCase();
  const lat = Number.parseFloat(firstString(item, "geo:lat") ?? "");
  const lng = Number.parseFloat(firstString(item, "geo:long") ?? "");
  return {
    o_id: oid(item),
    name: omekaTitle(item),
    kind: type === "institution" ? "institution" : type === "group" ? "group" : "organisation",
    part_of: linkedRefs(item, "dcterms:isPartOf"),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    wikidata: uriValues(item, "dcterms:identifier")[0]?.url ?? null,
  };
}

export function transformLocation(item: OmekaItem): LocationRec {
  const lat = Number.parseFloat(firstString(item, "geo:lat") ?? "");
  const lng = Number.parseFloat(firstString(item, "geo:long") ?? "");
  return {
    o_id: oid(item),
    name: omekaTitle(item),
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
    parent: firstLinked(item, "dcterms:isPartOf"),
    wikidata: uriValues(item, "dcterms:identifier")[0]?.url ?? null,
  };
}

/** dcterms:temporal numeric:interval "2019-01-01/2025-12-31" -> {start, end}. */
function temporalRange(item: OmekaItem): { start: string | null; end: string | null } {
  const t = firstString(item, "dcterms:temporal");
  if (!t) return { start: null, end: null };
  const [start, end] = t.split("/").map((s) => s.trim());
  return { start: start || null, end: end || null };
}

export function transformProject(item: OmekaItem): ProjectRec {
  const dreId = firstString(item, "dre:id") ?? `omeka-${oid(item)}`;
  return {
    o_id: oid(item),
    dre_id: dreId,
    name: omekaTitle(item),
    description: firstString(item, "dcterms:abstract"),
    sections: linkedRefs(item, "dcterms:isPartOf"),
    pis: linkedRefs(item, "dcterms:creator"),
    members: linkedRefs(item, "foaf:member"),
    funded_by: linkedRefs(item, "frapo:isFundedBy"),
    date: temporalRange(item),
    url: uriValues(item, "fabio:hasURL")[0]?.url ?? null,
    university: uniFromDreId(dreId),
  };
}

export function transformSection(item: OmekaItem): SectionRec {
  return {
    o_id: oid(item),
    name: omekaTitle(item),
    description: firstString(item, "dcterms:abstract"),
    date: temporalRange(item),
    pis: linkedRefs(item, "dcterms:creator"),
    members: linkedRefs(item, "foaf:member"),
    spokesperson: firstString(item, "marcrel:spk"),
    url: uriValues(item, "fabio:hasURL")[0]?.url ?? null,
  };
}

// --- publications --------------------------------------------------------------

// Every publication resource class the sync writes → the normalized type the
// tools filter and cite on. Keep exhaustive: the fallback below de-namespaces
// and lowercases the class term, which happens to be right for `fabio:Preprint`
// and wrong for everything else (`fabio:MastersThesis` → "mastersthesis",
// `bibo:Document` → "bibo:document" — the regex only strips a `fabio:` prefix).
// Templates 24-32 were added upstream in 2026-09; see the africa-multiple-data
// skill's publications reference for the EP3 type → template mapping.
const PUB_CLASS_TO_TYPE: Record<string, string> = {
  "fabio:JournalArticle": "article",
  "fabio:Book": "book",
  "fabio:BookChapter": "chapter",
  "fabio:ConferencePaper": "conference",
  "fabio:DoctoralThesis": "doctoral_thesis",
  "fabio:WorkingPaper": "working_paper",
  "fabio:JournalIssue": "journal_issue",
  "fabio:BookReview": "book_review",
  "fabio:BlogPost": "online_post",
  "fabio:Dataset": "research_data",
  "fabio:Preprint": "preprint",
  "fabio:NewspaperArticle": "newspaper_article",
  // A contribution in a German juristischer Kommentar — an entry in a
  // reference work, which is what fabio:Entry denotes.
  "fabio:Entry": "legal_commentary",
  "fabio:ReferenceEntry": "encyclopedia_entry",
  // Deliberately the neutral class upstream: an ERef "Übersetzung" may be a
  // translated book or a translated article.
  "bibo:Document": "translation",
  // Editorship of a book series *or* a journal, hence fabio:Series.
  "fabio:Series": "series_editorship",
  "fabio:Thesis": "habilitation",
  "fabio:MastersThesis": "masters_thesis",
  "fabio:BachelorsThesis": "bachelors_thesis",
};

export function transformPublication(item: OmekaItem, ctx: TransformContext, classOId: number | null): PublicationRec {
  const term = ctx.classTerm(classOId);
  const date = firstString(item, "dcterms:date");
  const pageStart = firstString(item, "bibo:pageStart");
  const pageEnd = firstString(item, "bibo:pageEnd");
  // dcterms:isPartOf is a resource link when the venue is a Journal authority
  // item (template 23); series/book titles remain literals. Keep both faces.
  const venueRef = firstLinked(item, "dcterms:isPartOf");
  return {
    o_id: oid(item),
    pub_id: firstString(item, "dcterms:identifier") ?? `omeka-${oid(item)}`,
    type: (term && PUB_CLASS_TO_TYPE[term]) ?? (term ? term.replace(/^fabio:/, "").toLowerCase() : "publication"),
    title: omekaTitle(item),
    date,
    year: yearOf(date),
    authors: linkedRefs(item, "bibo:authorList"),
    editors: linkedRefs(item, "bibo:editorList"),
    venue: venueRef?.label ?? null,
    venue_ref: venueRef?.o_id != null ? venueRef : null,
    volume: firstString(item, "bibo:volume"),
    issue: firstString(item, "bibo:issue"),
    pages: firstString(item, "bibo:pages") ?? (pageStart && pageEnd ? `${pageStart}-${pageEnd}` : pageStart),
    publisher: firstString(item, "dcterms:publisher"),
    doi: uriValues(item, "bibo:doi")[0]?.url ?? null,
    isbn: firstString(item, "bibo:isbn13") ?? firstString(item, "bibo:isbn"),
    issn: firstString(item, "bibo:issn"),
    abstract: firstString(item, "bibo:abstract"),
    subjects: linkedRefs(item, "dcterms:subject"),
    language: firstString(item, "dcterms:language"),
    urls: uriValues(item, "bibo:uri").map((u) => u.url),
    status: firstString(item, "bibo:status"),
    funders: linkedRefs(item, "frapo:isFundedBy"),
    places_of_publication: linkedRefs(item, "marcrel:pup"),
    relations: allStrings(item, "dcterms:relation"),
    fulltext: firstString(item, "bibo:content"),
    has_media: Array.isArray(item["o:media"]) && item["o:media"].length > 0,
    thumbnail: thumbnailUrl(item),
  };
}

/** A publication venue — Journal authority item (template 23, set 41268). */
export function transformJournal(item: OmekaItem): JournalRec {
  return {
    o_id: oid(item),
    title: omekaTitle(item),
    issn: firstString(item, "bibo:issn"),
    country: firstLinked(item, "dcterms:spatial"),
    url: uriValues(item, "dcterms:identifier")[0]?.url ?? null,
  };
}

// --- podcasts / videos / playlists / languages ----------------------------------

export function transformPodcast(item: OmekaItem, ctx: TransformContext): PodcastRec {
  const date = firstString(item, "dcterms:date");
  const episode = Number.parseInt(firstString(item, "bibo:number") ?? "", 10);
  return {
    o_id: oid(item),
    title: omekaTitle(item),
    series: firstLinked(item, "dcterms:isPartOf"),
    episode: Number.isFinite(episode) ? episode : null,
    date,
    year: yearOf(date),
    abstract: firstString(item, "dcterms:abstract"),
    people: contributorsOf(item, ctx),
    url: uriValues(item, "fabio:hasURL")[0]?.url ?? null,
    transcript: firstString(item, "bibo:content"),
    languages: linkedRefs(item, "dcterms:language"),
  };
}

export function transformVideo(item: OmekaItem, ctx: TransformContext): VideoRec {
  const date = firstString(item, "dcterms:date");
  return {
    o_id: oid(item),
    title: omekaTitle(item),
    abstract: firstString(item, "dcterms:abstract"),
    playlists: linkedRefs(item, "dcterms:isPartOf"),
    date,
    year: yearOf(date),
    speakers: contributorsOf(item, ctx),
    languages: linkedRefs(item, "dcterms:language"),
    url: uriValues(item, "fabio:hasURL")[0]?.url ?? null,
    transcript: firstString(item, "bibo:content"),
  };
}

export function transformPlaylist(item: OmekaItem): PlaylistRec {
  return {
    o_id: oid(item),
    title: omekaTitle(item),
    url: uriValues(item, "dcterms:identifier")[0]?.url ?? null,
    description: firstString(item, "dcterms:description"),
  };
}

export function transformLanguage(item: OmekaItem): LanguageRec {
  return {
    o_id: oid(item),
    name: omekaTitle(item),
    code: firstString(item, "dcterms:alternative"),
  };
}

/** Max o:modified across a batch of raw items (freshness probe input, D11). */
export function maxModified(items: OmekaItem[], current: string | null = null): string | null {
  let max = current;
  for (const it of items) {
    const m = systemDate(it, "o:modified");
    if (m && (!max || m > max)) max = m;
  }
  return max;
}
