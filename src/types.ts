// Snapshot record types — the shapes the build-time fetcher (src/transform.ts)
// produces from Omeka S JSON-LD and the runtime serves from memory. Field
// provenance is the census in scripts/census-report.json.

export type University = "ubt" | "unilag" | "ujkz" | "ufba" | "external";

/** Inline reference to a linked Omeka item (label always; o_id when linked). */
export interface LinkedRef {
  label: string;
  o_id: number | null;
}

/** One credit on a record: marcrel:* role folded to a readable label. */
export interface Contributor {
  name: string;
  role: string;
  o_id: number | null;
  /** v5: the `dcterms:isPartOf` value annotation — affiliation at the time of the credit. */
  affiliation?: LinkedRef | null;
}

/** v5: an authority identifier from a `dcterms:identifier` URI (GND, ORCID, VIAF, Wikidata, LCSH, …). */
export interface AuthorityId {
  scheme: string;
  id: string;
  url: string;
}

/** v5: one Omeka media record attached to an item (from /api/media). */
export interface MediaRec {
  o_id: number;
  /** MIME type, e.g. "image/webp", "application/pdf", "audio/mpeg". */
  type: string | null;
  /** o:original_url — the file on the AMIRA server, when one was ingested. */
  url: string | null;
  /** o:source — the upstream file or page the media was ingested from. */
  source: string | null;
  size: number | null;
}

export interface PersonRec {
  o_id: number;
  /** "Surname, Forename" — the stored canonical form. */
  name: string;
  /** dcterms:isPartOf → Organisation items. */
  affiliations: LinkedRef[];
  /** v5: dcterms:identifier URIs (GND, ORCID, VIAF, Wikidata…). */
  identifiers?: AuthorityId[];
  /** v5: dcterms:alternative name variants. */
  alt_names?: string[];
}

export interface OrganisationRec {
  o_id: number;
  name: string;
  /** dcterms:type on the item: "Institution" (508) or "Group" (84). */
  kind: "institution" | "group" | "organisation";
  /** dcterms:isPartOf -> parent/category authority records, including cluster-partner categories. */
  part_of: LinkedRef[];
  latitude: number | null;
  longitude: number | null;
  /** dcterms:identifier (Wikidata URI) when reconciled. */
  wikidata: string | null;
  /** v5: dcterms:alternative — acronyms and name variants ("UJKZ"). */
  alt_names?: string[];
  /** v5: every dcterms:identifier URI. */
  identifiers?: AuthorityId[];
}

export interface LocationRec {
  o_id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  /** dcterms:isPartOf → parent location (region → country chain). */
  parent: LinkedRef | null;
  wikidata: string | null;
  /** v5: dcterms:type label, e.g. "Country" or "Geographic location". */
  place_type?: string | null;
}

export interface ProjectRec {
  o_id: number;
  /** dre:id, e.g. "UBT_ArtWorld2019", "Ext_ILAM" — the public project key. */
  dre_id: string;
  name: string;
  description: string | null;
  /** dcterms:isPartOf → Research Section items. */
  sections: LinkedRef[];
  /** dcterms:creator → principal investigators. */
  pis: LinkedRef[];
  /** foaf:member → team members. */
  members: LinkedRef[];
  /** frapo:isFundedBy → funding institutions. */
  funded_by: LinkedRef[];
  date: { start: string | null; end: string | null };
  /** fabio:hasURL — project web page. */
  url: string | null;
  /** Derived from the dre:id prefix. */
  university: University;
  /** v5: dcterms:alternative name variants and acronyms. */
  alt_names?: string[];
}

export interface SectionRec {
  o_id: number;
  name: string;
  /** dcterms:abstract. */
  description: string | null;
  date: { start: string | null; end: string | null };
  /** dcterms:creator. */
  pis: LinkedRef[];
  /** foaf:member. */
  members: LinkedRef[];
  /** marcrel:spk. */
  spokesperson: string | null;
  /** fabio:hasURL — section page on the cluster website. */
  url: string | null;
}

/** A typed date on a research item, keyed by a short name (see DATE_TERMS). */
export type ItemDates = Record<string, string>;

export interface RelatedRef {
  /** "replaces" | "replaced by" | "version of" | "has version" | "has format" */
  relation: string;
  ref: LinkedRef;
}

export interface ResearchItemRec {
  o_id: number;
  /** dre:id — 100% coverage; the public item key. */
  dre_id: string;
  title: string;
  /** fabio:hasTranslatedTitle + fabio:hasSubtitle + dcterms:alternative. */
  alt_titles: string[];
  /** dcterms:type label (Text, Image, Audio, Moving image, …). */
  type: string | null;
  /** dcterms:isPartOf → Project item. */
  project: LinkedRef | null;
  /** dcterms:subject — subjects AND former dashboard "tags", merged (D6). */
  subjects: LinkedRef[];
  /** dcterms:spatial → Location items (label-only when unreconciled). */
  places: LinkedRef[];
  /** dcterms:language → Language items (labels like "English"). */
  languages: LinkedRef[];
  /** dcterms:format resource values — genre/format authority labels. */
  formats: LinkedRef[];
  /** dcterms:format literal values — free-text physical notes. */
  format_notes: string[];
  /** All marcrel:* credits with readable role labels. */
  contributors: Contributor[];
  /** Content dates keyed created/collected/issued/copyrighted/…; `modified` is
   * record admin and is excluded from year_min/year_max. */
  dates: ItemDates;
  year_min: number | null;
  year_max: number | null;
  description: string | null;
  abstract: string | null;
  toc: string | null;
  /** dcterms:audience labels. */
  audiences: string[];
  /** frapo:isFundedBy labels. */
  sponsors: string[];
  /** dcterms:provenance — holding/source institution or place. */
  provenance: string[];
  /** v5: the same provenance values as links (an institution with its own record). */
  provenance_refs?: LinkedRef[];
  access_rights: string[];
  license: string | null;
  /** dcterms:identifier literals (local ids etc.). */
  identifiers: string[];
  /** v5: the same identifiers with their annotated type ("Locally defined identifier", …). */
  typed_identifiers?: { value: string; type: string | null }[];
  doi: string | null;
  /** fabio:hasURL external links. */
  urls: string[];
  /** dre:collectionUrl (DSpace permalink) when present. */
  collection_url: string | null;
  /** dcterms:replaces / isReplacedBy / hasVersion / isVersionOf / hasFormat. */
  related: RelatedRef[];
  /** dcterms:bibliographicCitation. */
  citation: string[];
  wisski_url: string | null;
  has_media: boolean;
  /** Large thumbnail of the primary media, when digitised media is attached. */
  thumbnail: string | null;
  /** o:ids of the item sets (collections) this item belongs to. */
  item_sets: number[];
  /** Derived from the parent project's dre:id prefix. */
  university: University;
  /** v5: o:created / o:modified record timestamps (ISO). */
  created?: string | null;
  modified?: string | null;
  /** v5: dcterms:extent, e.g. "126 KB", "3 photographs". */
  extent?: string | null;
  /** v5: dre:rdspaceHandle — the research-data repository handle. */
  rdspace_handle?: string | null;
  /** v5: attached media files. */
  media?: MediaRec[];
}

export interface ItemSetRec {
  o_id: number;
  title: string;
}

export interface PublicationRec {
  o_id: number;
  /** dcterms:identifier, e.g. "eref-94882" — the public publication key. */
  pub_id: string;
  /** All repository identities, including aliases retained after deduplication.
   * Optional for compatibility with existing v4 snapshots. */
  identifiers?: string[];
  /** dre:series; distinct from the containing journal/book in venue. */
  series?: string[];
  /** Optional additions: old schema-v4 snapshots remain readable. */
  conference_details?: string[];
  num_pages?: string | null;
  external_links?: { url: string; label: string | null }[];
  access_rights?: string[];
  rights?: string[];
  advisers?: LinkedRef[];
  degree_granting_institutions?: LinkedRef[];
  publisher_ref?: LinkedRef | null;
  /** Friendly type from the fabio class: article, book, chapter, … */
  type: string;
  title: string;
  date: string | null;
  year: number | null;
  /** bibo:authorList / bibo:editorList — linked Person items or literal names. */
  authors: LinkedRef[];
  editors: LinkedRef[];
  /** dcterms:isPartOf label — journal / book / series title. */
  venue: string | null;
  /** dcterms:isPartOf as a link when it points at a Journal authority item. */
  venue_ref: LinkedRef | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  isbn: string | null;
  issn: string | null;
  abstract: string | null;
  /** dcterms:subject labels. */
  subjects: LinkedRef[];
  language: string | null;
  /** bibo:uri — ERef / EPub repository links, in source order. */
  urls: string[];
  /** bibo:status label, e.g. "Peer reviewed". */
  status: string | null;
  /** frapo:isFundedBy → funder authority items (DFG, the EXC 2052 grant, …). */
  funders: LinkedRef[];
  /** marcrel:pup → places of publication (linked to Location items). */
  places_of_publication: LinkedRef[];
  /** dcterms:relation — grant titles and typed related links, as text. */
  relations: string[];
  /** bibo:content — extracted full text of the open-access PDF, when present. */
  fulltext: string | null;
  /** True when the open-access PDF is attached as media (EPub-sourced). */
  has_media: boolean;
  /** Large thumbnail of the attached PDF, when present. */
  thumbnail: string | null;
  /** v5: every bibo:abstract with its language tag (only the first is in `abstract`). */
  abstracts?: { lang: string | null; text: string }[];
  /** v5: every dcterms:language value (only the first is in `language`). */
  languages?: string[];
  created?: string | null;
  modified?: string | null;
  media?: MediaRec[];
}

/** A publication venue (Journal authority item, template 23 / set 41268). */
export interface JournalRec {
  o_id: number;
  title: string;
  /** bibo:issn. */
  issn: string | null;
  /** dcterms:spatial → country of publication. */
  country: LinkedRef | null;
  /** dcterms:identifier URI — journal homepage / authority link. */
  url: string | null;
}

export interface PodcastRec {
  o_id: number;
  title: string;
  /** dcterms:isPartOf → series authority item. */
  series: LinkedRef | null;
  /** bibo:number. */
  episode: number | null;
  date: string | null;
  year: number | null;
  abstract: string | null;
  /** marcrel:spk/hst/sde credits. */
  people: Contributor[];
  /** fabio:hasURL — episode page / audio. */
  url: string | null;
  /** bibo:content — full transcript when present (43/43 filled in the refreshed 2026-06 snapshot). */
  transcript: string | null;
  languages: LinkedRef[];
  /** v5: dcterms:extent ISO 8601 duration, e.g. "PT21M35S". */
  duration?: string | null;
  /** v5: the `dre:generatedBy` annotation on the transcript — the model that produced it. */
  transcript_generated_by?: LinkedRef | null;
  created?: string | null;
  modified?: string | null;
  media?: MediaRec[];
}

export interface VideoRec {
  o_id: number;
  title: string;
  abstract: string | null;
  /** dcterms:isPartOf → playlist authority items. */
  playlists: LinkedRef[];
  date: string | null;
  year: number | null;
  /** marcrel:spk. */
  speakers: Contributor[];
  languages: LinkedRef[];
  /** fabio:hasURL — the YouTube watch URL. */
  url: string | null;
  /** bibo:content — full transcript when present (most videos filled as of 2026-06). */
  transcript: string | null;
  /** v5: large thumbnail. */
  thumbnail?: string | null;
  /** v5: dcterms:extent duration when catalogued. */
  duration?: string | null;
  /** v5: `dre:generatedBy` on the transcript, when annotated. */
  transcript_generated_by?: LinkedRef | null;
  created?: string | null;
  modified?: string | null;
}

export interface PlaylistRec {
  o_id: number;
  title: string;
  /** dcterms:identifier (playlist URL). */
  url: string | null;
  description: string | null;
}

export interface LanguageRec {
  o_id: number;
  /** English name, e.g. "French". */
  name: string;
  /** dcterms:alternative ISO code, e.g. "fra". */
  code: string | null;
}

/** v5: a subject authority (item set 1852): a curated LCSH heading or a free tag. */
export interface SubjectRec {
  o_id: number;
  name: string;
  /** dcterms:type label, e.g. "Library of Congress Subject Headings" or "Tag". */
  vocabulary: string | null;
  /** dcterms:identifier URI, e.g. an id.loc.gov authority. */
  uri: string | null;
}

/** Corpus-name → record-array map, mirrored by the snapshot's file layout. */
export interface SnapshotData {
  persons: PersonRec[];
  organisations: OrganisationRec[];
  locations: LocationRec[];
  projects: ProjectRec[];
  research_sections: SectionRec[];
  research_items: ResearchItemRec[];
  publications: PublicationRec[];
  journals: JournalRec[];
  podcasts: PodcastRec[];
  videos: VideoRec[];
  playlists: PlaylistRec[];
  languages: LanguageRec[];
  item_sets: ItemSetRec[];
  /** v5. Empty when a v4 snapshot is loaded. */
  subjects: SubjectRec[];
}

export const CORPORA = [
  "persons",
  "organisations",
  "locations",
  "projects",
  "research_sections",
  "research_items",
  "publications",
  "journals",
  "podcasts",
  "videos",
  "playlists",
  "languages",
  "item_sets",
  "subjects",
] as const;
export type CorpusName = (typeof CORPORA)[number];

export interface SnapshotManifest {
  schemaVersion: number;
  fetchedAt: string;
  apiBase: string;
  /** Global /api/items max o:modified (same scope as the freshness probe). */
  maxModified: string | null;
  /** Unfiltered /api/items total at crawl time (freshness probe pair, D11). */
  totalItemsOnInstance: number | null;
  /** Optional v4 freshness signal for collections, absent in older bundles. */
  itemSetsSignature?: string;
  /** Per-corpus record counts — integrity check at load and promote time. */
  counts: Record<CorpusName, number>;
}

/** v5: subjects corpus, media records, record timestamps, authority identifiers,
 * alternative names, value annotations (affiliation at the time, transcript
 * provenance, identifier types), all abstracts and languages. */
export const SNAPSHOT_SCHEMA_VERSION = 5;
/** Oldest snapshot schema the loader still serves; v5 fields are then absent. */
export const MIN_SNAPSHOT_SCHEMA_VERSION = 4;
/** Corpora a v4 snapshot does not carry. */
export const V5_CORPORA: readonly CorpusName[] = ["subjects"];
