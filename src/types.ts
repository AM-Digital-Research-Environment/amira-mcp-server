// Domain types for the Africa Multiple research data.
//
// These mirror the shapes the amira dashboard loads from its static JSON
// (which in turn come from the WissKI MongoDB archive), AFTER the MongoDB
// Extended JSON wrappers have been normalised by mongoJSON.ts:
//   {$oid}          -> string
//   {$date}         -> ISO string
//   {$numberDouble:"NaN"} -> null
// and after location l1/l2/l3 arrays have been flattened to strings.

export type University = "ubt" | "unilag" | "ujkz" | "ufba" | "external";

export interface Person {
  _id: string;
  name: string;
  affiliation: string[];
}

export interface Institution {
  _id: string;
  name: string;
}

export interface Group {
  _id: string;
  name: string;
}

export interface ProjectDate {
  start: string | null;
  end: string | null;
}

export interface Project {
  _id: string;
  idShort: string;
  id: string;
  locale: string;
  localeCode: number;
  researchSection: string[];
  name: string;
  pi: string[];
  members: string[] | null;
  emails: string[] | null;
  description: string | null;
  date: ProjectDate;
  createdAt: string | null;
  updatedAt: string;
  updatedBy: string;
  institutions: string[];
  /** Derived: which university folder / external set this project belongs to. */
  university: University;
}

export interface ResearchSection {
  _id?: string;
  name: string;
  url?: string;
  pi: string[];
  members: string[];
  description: string;
  objectives: string;
  workProgramme: string;
  spokesperson?: string;
  date?: { start: string | null; end: string | null };
}

export interface TitleInfo {
  title: string;
  title_type: string; // "main", "Translated", ...
}

export interface NameEntry {
  name: { label: string; qualifier: string }; // qualifier: person | institution | group
  affl: string[];
  role: string; // Author, Editor, Photographer, ...
}

export interface Subject {
  uri: string;
  authority: string;
  origLabel: string;
  authLabel: string;
}

export interface Identifier {
  identifier: string;
  identifier_type: string;
}

export interface LocationOrigin {
  l1: string; // country
  l2: string; // region / state
  l3: string; // city
}

export interface ItemLocation {
  origin: LocationOrigin[];
  current: string[];
}

export interface AccessCondition {
  rights: string[];
  usage: { type: string; admins: string[] };
}

export interface PhysicalDescription {
  type: string;
  method: string | null;
  desc: string[];
  tech: string[];
  note: string[];
}

export interface DateRange {
  start?: string | null;
  end?: string | null;
}

export interface CollectionItem {
  _id: string;
  dre_id: string;
  bitstream: string;
  security: string;
  collection: string[];
  sponsor: string[];
  project: { id: string; name: string };
  citation: string[];
  url: string[];
  titleInfo: TitleInfo[];
  dateInfo: Record<string, DateRange | undefined>;
  name: NameEntry[];
  note: string;
  subject: Subject[];
  relatedItems: Record<string, unknown>;
  identifier: Identifier[];
  location: ItemLocation;
  accessCondition: AccessCondition;
  typeOfResource: string;
  genre: { marc: string[] };
  language: string[];
  physicalDescription: PhysicalDescription;
  abstract: string | null;
  tableOfContents: string | null;
  targetAudience: string[];
  tags: string[];
  updatedBy: string;
  /** Derived at load time. */
  university: University;
}

export interface PublicationContributor {
  raw: string;
  normalized: string;
  person_id?: string | null;
  person_name?: string | null;
}

export interface Publication {
  id: string;
  source: string;
  sources: string[];
  type: string;
  raw_type: string;
  title: string;
  year?: number;
  quarter?: number;
  deposited_at?: string;
  authors?: PublicationContributor[];
  editors?: PublicationContributor[];
  book_editors?: PublicationContributor[];
  journal?: string;
  booktitle?: string;
  series?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  address?: string;
  event_location?: string;
  event_dates?: string;
  doi?: string;
  isbn?: string;
  issn?: string;
  keywords?: string[];
  abstract?: string;
  language?: string;
  url?: string;
  eref_url?: string;
  epub_url?: string;
  bibtex_url?: string;
  bibtex_raw?: string;
}

/** One enriched geolocation (from dev.geo.json), keyed by name or "Name|Parent". */
export interface GeoLocation {
  name: string;
  latitude: number | null;
  longitude: number | null;
  wikidata_id?: string | null;
}

export interface DataManifest {
  generatedAt: string;
  universities: Record<string, string[]>;
  external: Record<string, string[]>;
}
