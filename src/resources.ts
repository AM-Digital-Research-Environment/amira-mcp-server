// Data resources (MCP `resources/*`), beside the `ui://` apps and skill files:
//
//   amira://record/{kind}/{id}            any record as citable JSON (the same
//                                          projection as its get_* tool)
//   amira://dataset                       schema.org Dataset description of the
//                                          snapshot, for data citation
//   amira://export/{corpus}/{format}/{q}  a bulk export of a filtered search;
//                                          `q` is the filter set, base64url JSON
//
// Exports exist so a model can hand a researcher a whole result set without
// pasting thousands of rows into the conversation: the search tools return a
// `resource_link` to one of these URIs instead of inline rows. Everything is
// recomputed from the URI — nothing is stored between requests, which suits
// the stateless HTTP transport.
import { ResourceNotFoundError, ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS, withStore, type DataStore } from "./data.js";
import { allowDescriptive, allowStructured } from "./exposure.js";
import { guidanceEnabled } from "./guidance.js";
import { API_BASE, SITE_BASE, config } from "./config.js";
import { curatorText, curatorValue, visibilityCounts } from "./tools/curator.js";
import { snapshotId } from "./snapshotIdentity.js";
import { itemUrl } from "./urls.js";
import { collectionFields, collectionsOfItem, itemsOfCollection, resolveCollection } from "./collections.js";
import { creditLabel, mediaTypes, refLabels } from "./matching.js";
import { researchFilterError, researchFilters, selectResearchItems } from "./researchItemQuery.js";
import { abstractsOf, languagesOf, publicationFilterError, publicationFilters, selectPublications } from "./publicationQuery.js";
import { publicationCitation } from "./publicationCitation.js";
import { parseTypedId, type RecordKind } from "./typedIds.js";
import { isStoredKind, RECORD_KINDS, type StoredKind } from "./recordKinds.js";
import type { ToolMap } from "./tools/policy.js";
import type { PublicationRec, ResearchItemRec } from "./types.js";

export const EXPORT_FORMATS = {
  research_items: ["csv", "jsonl"],
  publications: ["csv", "jsonl", "bibtex", "ris", "csl-json"],
} as const;
export type ExportCorpus = keyof typeof EXPORT_FORMATS;
const MIME: Record<string, string> = {
  csv: "text/csv", jsonl: "application/jsonl", bibtex: "application/x-bibtex",
  ris: "application/x-research-info-systems", "csl-json": "application/vnd.citationstyles.csl+json",
};
/** Hard cap on rows per export (the whole research-item corpus is ~4,000). */
const MAX_EXPORT_ROWS = 10_000;

/** URI of an export of the given filtered search. */
export function exportUri(corpus: ExportCorpus, format: string, filters: Record<string, unknown>): string {
  const clean = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  return `amira://export/${corpus}/${format}/${Buffer.from(JSON.stringify(clean), "utf8").toString("base64url")}`;
}

/** A `resource_link` content block plus a short structured summary for an export. */
export function exportLink(corpus: ExportCorpus, format: string, filters: Record<string, unknown>, total: number) {
  const uri = exportUri(corpus, format, filters);
  const rows = Math.min(total, MAX_EXPORT_ROWS);
  const summary = {
    export: { uri, corpus, format, mime_type: MIME[format], rows, total_matches: total, truncated: total > MAX_EXPORT_ROWS || undefined },
    ...(guidanceEnabled()
      ? { note: "Read the resource (resources/read) to obtain the file; it is recomputed from the snapshot on every read." }
      : {}),
  };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(summary) },
      { type: "resource_link" as const, uri, name: `amira-${corpus}.${format === "csl-json" ? "json" : format}`, mimeType: MIME[format],
        description: `${rows} ${corpus.replace("_", " ")} as ${format}` },
    ],
    structuredContent: summary,
  };
}

const csvCell = (v: unknown): string => {
  const s = Array.isArray(v) ? v.join("; ") : v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** One research item as a flat export row; relational fields follow the exposure level. */
function itemRow(store: DataStore, it: ResearchItemRec): Record<string, unknown> {
  return {
    omeka_id: it.o_id, title: it.title, type: it.type,
    year_min: it.year_min, year_max: it.year_max,
    ...(allowStructured() ? {
      project: it.project?.label ?? null, university: UNIVERSITY_LABELS[it.university],
      contributors: it.contributors.map(creditLabel),
      subjects: refLabels(it.subjects), places: refLabels(it.places), languages: refLabels(it.languages),
      collections: collectionsOfItem(store, it).map((c) => c.title),
    } : {}),
    ...(allowDescriptive() ? { description: it.description, abstract: it.abstract } : {}),
    license: it.license, access_rights: it.access_rights,
    has_media: it.has_media, media_types: mediaTypes(it.media),
    created: it.created ?? null, modified: it.modified ?? null,
    amira_url: itemUrl(it.o_id),
  };
}

function publicationRow(p: PublicationRec): Record<string, unknown> {
  return {
    omeka_id: p.o_id, title: p.title, type: p.type, year: p.year, date: p.date,
    ...(allowStructured() ? { authors: refLabels(p.authors), editors: refLabels(p.editors), venue: p.venue, subjects: refLabels(p.subjects) } : {}),
    volume: p.volume, issue: p.issue, pages: p.pages, publisher: p.publisher, doi: p.doi, isbn: p.isbn, issn: p.issn,
    languages: languagesOf(p), has_fulltext: !!p.fulltext,
    ...(allowDescriptive() ? { abstract: abstractsOf(p)[0] ?? null } : {}),
    amira_url: itemUrl(p.o_id),
  };
}

function decodeFilters(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

async function renderExport(uri: string, corpus: string, format: string, query: string): Promise<{ mimeType: string; text: string }> {
  if (!(corpus in EXPORT_FORMATS) || !(EXPORT_FORMATS[corpus as ExportCorpus] as readonly string[]).includes(format)) {
    throw new ResourceNotFoundError(uri, `Unknown export: ${corpus}/${format}`);
  }
  const store = await ensureStore();
  const out = withStore(store, () => exportText(store, uri, corpus, format, query));
  // Curator mode: CSV/JSONL rows were marked in exportText; any public URL of a
  // private record left in the text (a BibTeX note, a CSL field) becomes its admin URL.
  return config.access === "curator" ? { ...out, text: curatorText(out.text, store) } : out;
}

/** Export rows as a curator sees them (visibility, admin_url for private records); unchanged in public mode. */
function shownRows(store: DataStore, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return config.access === "curator" ? curatorValue(rows, store, { detail: false }) : rows;
}

function exportText(store: DataStore, uri: string, corpus: string, format: string, query: string): { mimeType: string; text: string } {
  const filters = decodeFilters(query);
  if (corpus === "research_items") {
    const parsed = researchFilters.safeParse(filters);
    if (!parsed.success) throw new ResourceNotFoundError(uri, "Invalid export filters.");
    const refused = researchFilterError(parsed.data, store);
    if (refused) throw new ResourceNotFoundError(uri, refused.message);
    const rows = shownRows(store, selectResearchItems(store, parsed.data).filtered.slice(0, MAX_EXPORT_ROWS).map((it) => itemRow(store, it)));
    return format === "csv"
      ? { mimeType: MIME.csv!, text: toCsv(rows) }
      : { mimeType: MIME.jsonl!, text: rows.map((r) => JSON.stringify(r)).join("\n") + "\n" };
  }
  const parsed = z.object(publicationFilters).strict().safeParse(filters);
  if (!parsed.success) throw new ResourceNotFoundError(uri, "Invalid export filters.");
  const refused = publicationFilterError(parsed.data);
  if (refused) throw new ResourceNotFoundError(uri, refused.message);
  const records = selectPublications(store, parsed.data).records
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title) || a.o_id - b.o_id)
    .slice(0, MAX_EXPORT_ROWS);
  if (format === "csv") return { mimeType: MIME.csv!, text: toCsv(shownRows(store, records.map(publicationRow))) };
  if (format === "jsonl") return { mimeType: MIME.jsonl!, text: shownRows(store, records.map(publicationRow)).map((r) => JSON.stringify(r)).join("\n") + "\n" };
  if (format === "csl-json") {
    return { mimeType: MIME["csl-json"]!, text: JSON.stringify(records.map((p) => publicationCitation(p, "csl-json").export)) };
  }
  const separator = format === "ris" ? "\n" : "\n\n";
  return { mimeType: MIME[format]!, text: records.map((p) => publicationCitation(p, format as "bibtex" | "ris").export).join(separator) + "\n" };
}

/** Authority kinds without a detail tool, described from the snapshot. */
const AUTHORITY_KINDS: readonly RecordKind[] = ["location", "subject", "collection", "journal", "playlist"];
/** Kinds the record resource serves: those with a get_* tool (src/recordKinds.ts), then the authorities. */
const RESOURCE_KINDS = [
  ...(Object.keys(RECORD_KINDS) as StoredKind[]).filter((kind) => RECORD_KINDS[kind].detail),
  ...AUTHORITY_KINDS,
];

/** Authority kinds without a detail tool, described from the snapshot. */
function authorityRecord(store: DataStore, kind: RecordKind, oId: number): Record<string, unknown> | null | undefined {
  if (kind === "location") {
    const l = store.getLocation(oId);
    return l && { kind, omeka_id: l.o_id, name: l.name, place_type: l.place_type ?? null, latitude: l.latitude, longitude: l.longitude,
      within: store.locationAncestors(l.o_id), wikidata: l.wikidata, amira_url: itemUrl(l.o_id) };
  }
  if (kind === "subject") {
    const s = store.getSubject(oId);
    return s && { kind, omeka_id: s.o_id, name: s.name, vocabulary: s.vocabulary, authority_uri: s.uri, amira_url: itemUrl(s.o_id) };
  }
  if (kind === "collection") {
    // By item-set or project id; cited by the project page (#18).
    const c = resolveCollection(store, String(oId));
    return c && { kind, title: c.title, research_items: itemsOfCollection(store, c).length, ...collectionFields(c) };
  }
  if (kind === "journal") {
    const j = store.getJournal(oId);
    return j && { kind, omeka_id: j.o_id, title: j.title, issn: j.issn, country: j.country?.label ?? null, website: j.url, amira_url: itemUrl(j.o_id) };
  }
  if (kind === "playlist") {
    const p = store.getPlaylist(oId);
    return p && { kind, omeka_id: p.o_id, title: p.title, description: p.description, youtube_url: p.url, amira_url: itemUrl(p.o_id) };
  }
  return null;
}

/** schema.org Dataset for the whole snapshot. */
function datasetDescription(store: DataStore): Record<string, unknown> {
  const licences = new Map<string, number>();
  for (const it of store.items) if (it.license) licences.set(it.license, (licences.get(it.license) ?? 0) + 1);
  let earliest: number | null = null, latest: number | null = null;
  for (const it of store.items) {
    if (it.year_min != null && (earliest == null || it.year_min < earliest)) earliest = it.year_min;
    const hi = it.year_max ?? it.year_min;
    if (hi != null && (latest == null || hi > latest)) latest = hi;
  }
  const countries = [...new Set(store.locations.filter((l) => !l.parent).map((l) => l.name))].sort();
  const counts = store.manifest.counts;
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "AMIRA — Africa Multiple Interactive Research Atlas: research data of the Africa Multiple Cluster of Excellence",
    description:
      "Metadata for the digitised research items, projects, research sections, people, institutions, publications, " +
      "journals, podcasts and videos of the Africa Multiple Cluster of Excellence at the University of Bayreuth, as published " +
      "on its public Omeka S site. This description covers one snapshot served by the AMIRA MCP server.",
    url: `${SITE_BASE}/s/amira`,
    identifier: snapshotId(store.manifest),
    version: store.manifest.fetchedAt,
    dateModified: store.manifest.maxModified,
    isAccessibleForFree: true,
    inLanguage: ["en", "fr", "de", "pt"],
    creator: { "@type": "Organization", name: "Digital Research Environment, Africa Multiple Cluster of Excellence, University of Bayreuth",
      url: "https://www.africamultiple.uni-bayreuth.de/" },
    publisher: { "@type": "Organization", name: "University of Bayreuth" },
    funder: { "@type": "Organization", name: "Deutsche Forschungsgemeinschaft (DFG), EXC 2052/1 – 390713894" },
    license: "Licences vary by record; see each record's `license` field.",
    temporalCoverage: earliest != null ? `${earliest}/${latest}` : undefined,
    spatialCoverage: countries.map((name) => ({ "@type": "Place", name })),
    distribution: [
      { "@type": "DataDownload", name: "Omeka S REST API (JSON-LD)", contentUrl: API_BASE, encodingFormat: "application/ld+json" },
    ],
    variableMeasured: Object.entries(counts).map(([name, value]) => ({ "@type": "PropertyValue", name, value })),
    "amira:license_distribution": Object.fromEntries([...licences].sort((a, b) => b[1] - a[1])),
    "amira:snapshot": { source: store.source, fetched_at: store.manifest.fetchedAt, api_base: store.manifest.apiBase },
    // The exact vector space behind get_similar_items, so a citation of semantic results can name it (#12).
    "amira:semantic_space": store.semantic ? { repository: store.semantic.source.repository, release: store.semantic.source.tag,
      model: store.semantic.source.model, model_revision: store.semantic.source.model_revision,
      generated_at: store.semantic.source.generated_at, vectors_sha256: store.semantic.source.vectors_sha256 } : null,
    // Curator mode: this snapshot includes private records, which are not freely accessible.
    ...(config.access === "curator"
      ? { isAccessibleForFree: false, conditionsOfAccess: "Includes private AMIRA records and values, visible to AMIRA curators only.",
          "amira:access": "curator", "amira:visibility": visibilityCounts(store) }
      : {}),
  };
}

const json = (uri: string, value: unknown) => ({
  contents: [{ uri, mimeType: "application/json", text: JSON.stringify(value) }],
});

export function registerDataResources(server: McpServer, tools: ToolMap,
  opts: { guidance?: boolean; servedTools?: ReadonlySet<string> | null } = {}): void {
  const servedTools = opts.servedTools ?? null;
  // AMIRA_GUIDANCE=off: no titles or descriptions (src/guidance.ts).
  const described = (title: string, description: string) => (opts.guidance ?? true ? { title, description } : {});
  server.registerResource(
    "amira-record",
    new ResourceTemplate("amira://record/{kind}/{id}", {
      list: undefined,
      complete: { kind: (value) => RESOURCE_KINDS.filter((k) => k.startsWith(value)) },
    }),
    {
      ...described("AMIRA record", "Any AMIRA record as citable JSON, e.g. amira://record/research_item/9902. Kinds follow resolve_entity ids."),
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const kindRaw = String(variables.kind ?? ""), id = String(variables.id ?? "");
      const parsed = parseTypedId(`${kindRaw}:${id}`);
      if (!parsed || !/^[1-9]\d*$/.test(parsed.key)) throw new ResourceNotFoundError(uri.href, `Unknown record ${kindRaw}/${id}.`);
      const route = isStoredKind(parsed.kind) ? RECORD_KINDS[parsed.kind].detail : undefined;
      // A tool the profile removed serves no records either: the resource
      // reflects the same surface as tools/list.
      const tool = route && (!servedTools || servedTools.has(route.tool)) ? tools[route.tool] : undefined;
      if (route && tool) {
        const result = (await (tool.handler as (args: unknown, ctx: unknown) => Promise<{ isError?: boolean; content?: { type: string; text?: string }[] }>)(
          route.arg(parsed.key), {})) ?? {};
        const text = result.content?.find((c) => c.type === "text")?.text;
        if (result.isError || !text) throw new ResourceNotFoundError(uri.href, `No ${parsed.kind} with id ${parsed.key}.`);
        return { contents: [{ uri: uri.href, mimeType: "application/json", text }] };
      }
      const store = await ensureStore();
      const record = allowStructured() ? authorityRecord(store, parsed.kind, Number(parsed.key)) : null;
      if (!record) throw new ResourceNotFoundError(uri.href, `No ${parsed.kind} with id ${parsed.key}.`);
      return json(uri.href, config.access === "curator" ? curatorValue(record, store) : record);
    },
  );

  server.registerResource(
    "amira-dataset",
    "amira://dataset",
    {
      ...described("AMIRA dataset description", "schema.org Dataset description of the served snapshot: counts, coverage, licence mix and how to cite it."),
      mimeType: "application/ld+json",
    },
    async (uri) => {
      const store = await ensureStore();
      return { contents: [{ uri: uri.href, mimeType: "application/ld+json", text: JSON.stringify(datasetDescription(store)) }] };
    },
  );

  server.registerResource(
    "amira-export",
    new ResourceTemplate("amira://export/{corpus}/{format}/{query}", { list: undefined }),
    described("AMIRA export",
      "A filtered research-item or publication export (CSV, JSONL, BibTeX, RIS, CSL-JSON). Links come from search tools called with `export`."),
    async (uri, variables) => {
      const { mimeType, text } = await renderExport(uri.href, String(variables.corpus), String(variables.format), String(variables.query));
      return { contents: [{ uri: uri.href, mimeType, text }] };
    },
  );
}
