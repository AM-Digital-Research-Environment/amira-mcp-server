// How curator mode shows private records and private values (#26). Applied in
// one place, after every tool handler (src/tools/policy.ts) and on every
// resource (src/resources.ts), so no tool can forget it:
//
//   - every object that cites a record (`amira_url`, or a `url` that is exactly
//     a record page, as in `search` rows and `fetch` documents) gains
//     `visibility`;
//   - a private record loses its `amira_url` (anonymous visitors cannot open
//     it) and gets `admin_url`, the Omeka admin page, plus `citation_note`;
//   - any other public URL of a private record, wherever it appears in a
//     string (a citation, a `fetch` document, a BibTeX entry, an API or IIIF
//     URL), becomes its admin URL; a private media file's URL becomes the
//     media's admin page, so no private file is ever linked directly;
//   - media rows carry `visibility`; a media of a private record is private
//     too; a private one has no file `url`, only `admin_url`; a private
//     record's `thumbnail` or one drawn from a private media, and the IIIF
//     manifest or collection of a private record, are null;
//   - a detail result (top-level `omeka_id`) gains the record's `restricted`
//     block: its private values, and its private full text, windowed like
//     every other long text (`include_fulltext`, `fulltext_offset`,
//     `fulltext_max_chars`; get_chronicle's `include_text`, `text_offset`,
//     `text_max_chars`).
//
// A record is classified from the store (every crawled corpus, item set and
// media) and, for ids outside them (format authorities, AI-model items, …),
// from the snapshot's list of every private item (`privateItemIds`). A snapshot
// written without that list leaves such ids unclassified: no `visibility`, no
// rewrite.
//
// Public mode never calls this: its store holds no private record or value
// (src/visibility.ts), so its output is unchanged.
import { SITE_BASE, SITE_SLUG } from "../config.js";
import { allowFullText } from "../exposure.js";
import type { DataStore } from "../data.js";
import { adminItemSetUrl, adminItemUrl, adminMediaUrl } from "../urls.js";
import { PRIVATE_CITATION_NOTE, RESTRICTED_NOTE, type RestrictedValues } from "../visibility.js";
import { PAGE_CHAR_BUDGET } from "./pagination.js";
import { CHARACTER_LIMIT, scrub } from "./responses.js";
import { textWindowFields, type WindowField } from "./textWindows.js";

type Visibility = "public" | "private";

/**
 * Tools whose arguments page a full text, which also page the restricted one,
 * and the field they page: `include_fulltext` / `fulltext_offset` /
 * `fulltext_max_chars`, or get_chronicle's `include_text` / `text_offset` /
 * `text_max_chars`. The restricted window takes the tool's own field name, so
 * its paging hints name arguments the tool has.
 */
const FULLTEXT_TOOLS = new Map<string, WindowField>([["get_research_item", "fulltext"], ["get_publication", "fulltext"], ["get_chronicle", "text"],
  ["get_podcast", "transcript"], ["get_video", "transcript"]]);

/** Tools other than search_research_items that select research items with the shared filters, keyword included. */
const RESEARCH_FILTER_TOOLS = new Set(["list_years", "list_locations", "compare_collections"]);

/** Said on a result whose keyword filter also matched research items' private full text. */
export const PRIVATE_KEYWORD_NOTE =
  "Curator mode: the keyword filter also matches research items' private full text (the ILAM OCR text), so these counts " +
  "may include items matched only there. search_research_items marks such rows with matched_in.";

/** The same for publications, on the paths whose rows cannot say matched_in (facets, citation pages, exports). */
export const PRIVATE_PUBLICATION_KEYWORD_NOTE =
  "Curator mode: the keyword also matches publications' private full text, so these counts may include publications " +
  "matched only there. search_publications without citation_format marks such rows with matched_in.";

/** Said on a search result with rows matched only in a private full text, and on passages drawn from one. */
export const RESTRICTED_MATCH_NOTE =
  "Rows with matched_in \"restricted_fulltext\" (\"restricted_text\", \"restricted_transcript\") matched only in a private " +
  "text: their fulltext_snippet (text_snippet, transcript_snippet; a get_text_passages passage's text) is private in AMIRA, not on the public site. " +
  "A public record is still cited by its amira_url; whether to quote the text is up to the curator.";

/** The matched_in values of a row matched only in a private text. */
const RESTRICTED_MATCHES = new Set(["restricted_fulltext", "restricted_text", "restricted_transcript"]);

interface IndexedMedia { o_id: number; type: string | null; url: string | null; size: number | null; visibility?: string }

interface Indexed {
  o_id: number;
  visibility?: string;
  restricted?: RestrictedValues;
  /** The record's own thumbnail (videos carry one and list no media). */
  thumbnail?: string | null;
  media?: IndexedMedia[];
}

/** Every record of the store, the corpus it belongs to first. */
function corpora(store: DataStore): [string, Indexed[]][] {
  return [
    ["research_items", store.items], ["projects", store.projects], ["persons", store.persons],
    ["organisations", store.organisations], ["locations", store.locations], ["research_sections", store.sections],
    ["publications", store.publications], ["journals", store.journals], ["podcasts", store.podcasts],
    ["videos", store.videos], ["playlists", store.playlists], ["languages", store.languageIndex.all],
    ["item_sets", store.itemSets], ["subjects", store.subjects], ["chronicles", store.chronicles],
  ];
}

interface Indexes {
  /** Records, item sets and media by Omeka id (one id space). */
  visibility: Map<number, Visibility>;
  restricted: Map<number, RestrictedValues>;
  itemSets: Set<number>;
  media: Set<number>;
  /** Every private item on the instance, when the snapshot lists them. */
  privateItems: Set<number> | null;
  /** Media by file URL, for media rows. */
  mediaByUrl: Map<string, { id: number; visibility: Visibility }>;
  /** Media by owner, in the order detail tools list them (recovers the id of a media row without a file URL). */
  mediaOf: Map<number, IndexedMedia[]>;
  /**
   * Admin URL of every private file by stem (`/files/<size>/<stem>.<ext>`:
   * originals and thumbnails share it): a private media's files, and the
   * thumbnail of a private record (its admin page when no listed media owns it).
   */
  privateFiles: Map<string, string>;
}

const fileStem = (url: string): string | null => {
  const m = /\/files\/[^/]+\/([^/?#]+?)(?:\.[A-Za-z0-9]+)?(?:[?#].*)?$/.exec(url);
  return m ? m[1]! : null;
};

function indexes(store: DataStore): Indexes {
  return store.cached("curator:indexes", () => {
    const visibility = new Map<number, Visibility>();
    const restricted = new Map<number, RestrictedValues>();
    const media = new Set<number>();
    const mediaByUrl = new Map<string, { id: number; visibility: Visibility }>();
    const mediaOf = new Map<number, IndexedMedia[]>();
    const privateFiles = new Map<string, string>();
    for (const [corpus, list] of corpora(store)) {
      for (const r of list) {
        const isPrivate = r.visibility === "private";
        visibility.set(r.o_id, isPrivate ? "private" : "public");
        if (r.restricted) restricted.set(r.o_id, r.restricted);
        if (r.media?.length) mediaOf.set(r.o_id, r.media);
        for (const m of r.media ?? []) {
          // A media of a private record is private, whatever its own flag:
          // Omeka serves its files to anyone who has the URL.
          const vis: Visibility = isPrivate || m.visibility === "private" ? "private" : "public";
          visibility.set(m.o_id, vis);
          media.add(m.o_id);
          if (!m.url) continue;
          mediaByUrl.set(m.url, { id: m.o_id, visibility: vis });
          const stem = vis === "private" ? fileStem(m.url) : null;
          if (stem) privateFiles.set(stem, adminMediaUrl(m.o_id));
        }
        // A private record's own thumbnail, which a record without a media list
        // (a video) has too; a listed media's admin page wins over the record's.
        const thumb = isPrivate && typeof r.thumbnail === "string" ? fileStem(r.thumbnail) : null;
        if (thumb && !privateFiles.has(thumb)) {
          privateFiles.set(thumb, corpus === "item_sets" ? adminItemSetUrl(r.o_id) : adminItemUrl(r.o_id));
        }
      }
    }
    const listed = store.manifest.privateItemIds;
    return {
      visibility, restricted, media, mediaByUrl, mediaOf, privateFiles,
      itemSets: new Set(store.itemSets.map((s) => s.o_id)),
      privateItems: Array.isArray(listed) ? new Set(listed) : null,
    };
  });
}

/** Public vs private counts per corpus, and how many records carry private values. */
export function visibilityCounts(store: DataStore): Record<string, unknown> {
  return store.cached("curator:counts", () => {
    const pub: Record<string, number> = {};
    const priv: Record<string, number> = {};
    let withRestricted = 0;
    let withRestrictedFulltext = 0;
    for (const [corpus, list] of corpora(store)) {
      let p = 0;
      for (const r of list) {
        if (r.visibility === "private") p++;
        if (r.restricted) withRestricted++;
        if (r.restricted?.fulltext) withRestrictedFulltext++;
      }
      pub[corpus] = list.length - p;
      priv[corpus] = p;
    }
    return {
      public: pub,
      private: priv,
      records_with_private_values: withRestricted,
      records_with_private_fulltext: withRestrictedFulltext,
      note: "Curator mode: counts include private records. Private records and private values are not on the public site.",
    };
  });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The public site under either scheme (Omeka builds URLs from the request, so `http://` copies exist). */
const SITE_HOST = SITE_BASE.replace(/^https?:\/\//, "");
const ROOT = `https?://${escapeRe(SITE_HOST)}`;
const PAGE = `/s/${escapeRe(SITE_SLUG)}/(item|item-set|media)/(\\d+)`;
/**
 * Path segments after a IIIF id (`/manifest`, `/canvas/p1`, an image request's
 * `/0,0,512,512/max/0/default.jpg`): a comma only before a digit, so the comma
 * of a CSV row or a sentence is not taken for part of the URL.
 */
const IIIF_TAIL = "(?:/(?:[A-Za-z0-9_.~%=+:!-]|,(?=\\d))*)*";
/** Every URL form that names one resource: its public page, its API URL, a IIIF URL under its id, a file. */
const ANY_URL = new RegExp(
  `${ROOT}(?:${PAGE}(?!\\d)|/api/(items|item_sets|media)/(\\d+)(?!\\d)|/iiif/3/(?:(collection)/)?(\\d+)(?!\\d)(${IIIF_TAIL})` +
  `|/files/[A-Za-z0-9_-]+/([^\\s"'<>?#/\\\\]+))`, "g");
/** Punctuation that may end a sentence, a CSV field or a bracket right after a URL. */
const URL_END = /[.,;:!)\]}*|]/;
const PUBLIC_URL_EXACT = new RegExp(`^${ROOT}${PAGE}$`);
const IIIF_EXACT = new RegExp(`^${ROOT}/iiif/3/(?:(collection)/)?(\\d+)(?:/manifest)?$`);

type Kind = "item" | "item-set" | "media";

function parsePublicUrl(url: unknown): { kind: Kind; id: number } | null {
  if (typeof url !== "string") return null;
  const m = PUBLIC_URL_EXACT.exec(url);
  return m ? { kind: m[1] as Kind, id: Number(m[2]) } : null;
}

const adminUrl = (kind: Kind, id: number): string =>
  (kind === "item-set" ? adminItemSetUrl(id) : kind === "media" ? adminMediaUrl(id) : adminItemUrl(id));

interface Ctx extends Indexes {
  /** Window options for the restricted full text, when the tool pages full texts. */
  window: { field: WindowField; include?: boolean; offset?: number; maxChars?: number } | null;
}

/** Visibility of any Omeka id, or undefined when the snapshot cannot tell. */
function lookup(ctx: Ctx, id: number): Visibility | undefined {
  const known = ctx.visibility.get(id);
  if (known) return known;
  if (!ctx.privateItems) return undefined;
  return ctx.privateItems.has(id) ? "private" : "public";
}

/** The kind of an id met without a URL (an `omeka_id`). */
const kindOf = (ctx: Ctx, id: number): Kind => (ctx.itemSets.has(id) ? "item-set" : ctx.media.has(id) ? "media" : "item");

/**
 * The admin URL of a private file named in running text, followed by what the
 * file segment caught beyond the name (`abc.pdf.`, `abc.pdf,next`, `abc.pdf)`),
 * or null. The segment is tried whole, then cut before each trailing
 * punctuation mark, longest first; each candidate loses its extension as in
 * `fileStem`. Cutting can only add matches, so a doubt masks the URL.
 */
function privateFileInText(file: string, ctx: Ctx): string | null {
  for (let cut = file.length; cut > 0; cut--) {
    if (cut < file.length && !URL_END.test(file[cut]!)) continue;
    const admin = ctx.privateFiles.get(file.slice(0, cut).replace(/\.[A-Za-z0-9]+$/, ""));
    if (admin) return admin + file.slice(cut);
  }
  return null;
}

/** Every URL of a private resource in `text`, replaced by its admin URL. */
function rewriteUrls(text: string, ctx: Ctx): string {
  if (!text.includes(SITE_HOST)) return text;
  return text.replace(ANY_URL, (url, page?: string, pageId?: string, api?: string, apiId?: string, iiif?: string, iiifId?: string,
    iiifTail?: string, file?: string) => {
    if (file !== undefined) return privateFileInText(file, ctx) ?? url;
    const id = Number(pageId ?? apiId ?? iiifId);
    if (lookup(ctx, id) !== "private") return url;
    const kind: Kind = page ? (page as Kind) : api ? (api === "items" ? "item" : api === "item_sets" ? "item-set" : "media")
      : iiif ? "item-set" : kindOf(ctx, id);
    // A IIIF sub-path (`/manifest`, `/canvas/p1`) has no admin counterpart: the
    // whole URL becomes the admin page, keeping only sentence punctuation after it.
    return adminUrl(kind, id) + (iiifTail ? /[.:!]*$/.exec(iiifTail)![0] : "");
  });
}

/** A media file or thumbnail URL that belongs to a private media. */
const isPrivateFile = (url: unknown, ctx: Ctx): boolean => {
  if (typeof url !== "string") return false;
  const stem = fileStem(url);
  return stem != null && ctx.privateFiles.has(stem);
};

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A private value cut to the response budget, saying so. */
function capped(text: string): string {
  return text.length <= CHARACTER_LIMIT ? text : `${text.slice(0, CHARACTER_LIMIT)} […truncated: ${text.length} characters in all]`;
}

/** What the public text window of the same result returned (zeros when it has no public text). */
interface PublicWindow { length: number; returned: number; truncated: boolean }

/** Below this many characters left on the page, the private text waits for the next page. */
const MIN_PRIVATE_WINDOW = 200;

/**
 * A record's restricted block as returned to a curator. The public and the
 * private full text are one stream on the shared `<field>_offset` (#54): the
 * private text follows the public one, so private character i sits at offset
 * `public length + i`. It starts only once the public text is exhausted, and
 * shares the page budget with the public window. A record with private text
 * only pages exactly as before (its public length is 0). The restricted values
 * come with the first page only.
 */
function restrictedBlock(r: RestrictedValues | undefined, ctx: Ctx, pub: PublicWindow): Record<string, unknown> {
  const out: Record<string, unknown> = { note: RESTRICTED_NOTE };
  const field = ctx.window?.field ?? "fulltext";
  const offset = Math.max(0, Math.floor(ctx.window?.offset ?? 0));
  const laterPage = !!ctx.window?.include && offset > 0;
  if (r?.mongo_id) out.mongo_id = r.mongo_id;
  if (r?.security_level) out.security_level = r.security_level;
  if (laterPage && (r?.bitstream || r?.values)) out.values_note = `Restricted values are returned with ${field}_offset 0.`;
  else {
    if (r?.bitstream) out.bitstream = r.bitstream.map(capped);
    if (r?.values) out.values = Object.fromEntries(Object.entries(r.values).map(([term, texts]) => [term, texts.map(capped)]));
  }
  if (r?.fulltext) {
    const text = r.fulltext;
    if (!ctx.window) Object.assign(out, { has_fulltext: true, fulltext_length: text.length });
    else if (!ctx.window.include) Object.assign(out, textWindowFields(field, text, ctx.window));
    else Object.assign(out, privateWindow(field, text, ctx.window, offset, pub));
    if (r.fulltext_generated_by) out[`${field}_generated_by`] = r.fulltext_generated_by.label;
  } else if (ctx.window?.include) {
    // Asked for the private full text: say there is none rather than staying silent.
    out[`has_${field}`] = false;
  }
  return scrub(walk(out, ctx, 1) as Record<string, unknown>);
}

/** The private text's window in stream offsets (see restrictedBlock). */
function privateWindow(field: WindowField, text: string, window: NonNullable<Ctx["window"]>, offset: number,
  pub: PublicWindow): Record<string, unknown> {
  const head = { [`has_${field}`]: true, [`${field}_length`]: text.length, ...(pub.length ? { [`${field}_starts_at`]: pub.length } : {}) };
  if (pub.truncated) return { ...head, [`${field}_hint`]: `The private ${field} follows the public one, from ${field}_offset ${pub.length}.` };
  const start = Math.max(0, offset - pub.length);
  const page = Math.min(Math.floor(window.maxChars ?? CHARACTER_LIMIT), CHARACTER_LIMIT);
  const left = page - pub.returned;
  if (start < text.length && pub.returned > 0 && left < MIN_PRIVATE_WINDOW) {
    return { ...head, [`${field}_next_offset`]: pub.length + start };
  }
  const shown = textWindowFields(field, text, { include: true, offset: start, maxChars: window.maxChars, budget: Math.max(1, left) });
  if (!(field in shown)) return { ...head, ...shown }; // exposure below full: flags only
  const returned = shown[`${field}_returned_chars`] as number;
  const truncated = start + returned < text.length;
  return {
    ...head,
    [field]: shown[field],
    [`${field}_offset`]: pub.length + start,
    [`${field}_returned_chars`]: returned,
    ...(truncated ? { [`${field}_truncated`]: true, [`${field}_next_offset`]: pub.length + start + returned } : {}),
    ...(start >= text.length
      ? { [`${field}_hint`]: `${field}_offset ${offset} is past the end of the public and private ${field} (${pub.length + text.length} characters).` }
      : {}),
  };
}

/**
 * One media row: `visibility` always; a private one has no direct file URL,
 * only its admin page. A row is private when its media is, or when the record
 * listing it is (`ownerPrivate`). `rec` is the store's media at the row's
 * position, which gives the id of a row without a file URL.
 */
function mediaRow(row: Record<string, unknown>, ctx: Ctx, ownerPrivate: boolean, rec: IndexedMedia | undefined): Record<string, unknown> {
  const known = typeof row.url === "string" ? ctx.mediaByUrl.get(row.url) : undefined;
  const id = rec?.o_id ?? known?.id;
  const isPrivate = ownerPrivate || row.visibility === "private" || known?.visibility === "private" ||
    (id != null && ctx.visibility.get(id) === "private");
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(row)) {
    if (key === "visibility") continue;
    out[key] = isPrivate && key === "url" ? null : walk(v, ctx, 2);
  }
  if (isPrivate && id != null) out.admin_url = adminMediaUrl(id);
  out.visibility = isPrivate ? "private" : "public";
  return out;
}

const isMediaList = (v: unknown[]): boolean => v.every((m) => isPlain(m) && "url" in m && "type" in m);

/**
 * The owner's media, when the rows are exactly its media list in order (same
 * type, file URL and, where shown, size): detail tools list every media of the
 * record without its id. Anything else returns null and the rows go by URL.
 */
function alignedMedia(ctx: Ctx, owner: number | undefined, rows: unknown[]): IndexedMedia[] | null {
  const recs = owner != null ? ctx.mediaOf.get(owner) : undefined;
  if (!recs || recs.length !== rows.length) return null;
  return rows.every((row, i) => {
    const r = row as Record<string, unknown>, m = recs[i]!;
    return r.type === m.type && r.url === m.url && (!("size" in r) || r.size === m.size);
  }) ? recs : null;
}

/** The most restrictive of two classifications (either may be unknown). */
const strictest = (a: Visibility | undefined, b: Visibility | undefined): Visibility | undefined =>
  (a === "private" || b === "private" ? "private" : a ?? b);

function walk(value: unknown, ctx: Ctx, depth: number): unknown {
  if (typeof value === "string") return rewriteUrls(value, ctx);
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx, depth + 1));
  if (!isPlain(value)) return value;
  // A record is cited by its `amira_url`, or (search rows, fetch documents) by a `url` that is exactly its page.
  const citesBy = "amira_url" in value ? "amira_url" : parsePublicUrl(value.url) ? "url" : null;
  const cited = citesBy ? parsePublicUrl(value[citesBy]) : null;
  const citedVis = cited ? lookup(ctx, cited.id) : undefined;
  // The record's own id, when it differs from the page it cites (a collection
  // cites its project's page): the most restrictive of the two wins. Rows of
  // get_snapshot_changes carry it as a numeric `id` (Omeka has one id space).
  const own = typeof value.omeka_id === "number" ? value.omeka_id : typeof value.id === "number" ? value.id : null;
  const ownId = citesBy && own != null && own !== cited?.id ? own : null;
  const ownVis = ownId != null ? lookup(ctx, ownId) : undefined;
  const vis = strictest(citedVis, ownVis);
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "amira_url" && citedVis === "private" && cited) {
      out.admin_url = adminUrl(cited.kind, cited.id);
      continue;
    }
    if (key.endsWith("_amira_url")) {
      const ref = parsePublicUrl(v);
      if (ref && lookup(ctx, ref.id) === "private") {
        out[`${key.slice(0, -"amira_url".length)}admin_url`] = adminUrl(ref.kind, ref.id);
        continue;
      }
    }
    if (key === "media" && Array.isArray(v) && isMediaList(v)) {
      const recs = alignedMedia(ctx, typeof value.omeka_id === "number" ? value.omeka_id : cited?.id, v);
      out.media = v.map((m, i) => mediaRow(m as Record<string, unknown>, ctx, vis === "private", recs?.[i]));
      continue;
    }
    // A private record's thumbnail is null even if the index missed its file.
    if (key === "thumbnail" && (vis === "private" || isPrivateFile(v, ctx))) {
      out.thumbnail = null;
      continue;
    }
    if ((key === "iiif_manifest" || key === "iiif_collection") && typeof v === "string") {
      const m = IIIF_EXACT.exec(v);
      if (m && lookup(ctx, Number(m[2])) === "private") {
        out[key] = null; // a private record has no public IIIF manifest (anonymous requests get 404)
        continue;
      }
    }
    out[key] = walk(v, ctx, depth + 1);
  }
  if (ownVis === "private" && citedVis !== "private" && !("admin_url" in out)) out.admin_url = adminUrl(kindOf(ctx, ownId!), ownId!);
  if (vis) {
    out.visibility = vis;
    if (vis === "private") out.citation_note = PRIVATE_CITATION_NOTE;
  }
  if (depth === 0) {
    if (typeof value.omeka_id === "number") {
      const restricted = ctx.restricted.get(value.omeka_id);
      if (restricted || ctx.window?.include) {
        const field = ctx.window?.field ?? "fulltext";
        const num = (v: unknown) => (typeof v === "number" ? v : 0);
        const pub = { length: num(value[`${field}_length`]), returned: num(value[`${field}_returned_chars`]),
          truncated: value[`${field}_next_offset`] !== undefined };
        out.restricted = restrictedBlock(restricted, ctx, pub);
        // Past the public text is not past the end when the private text continues it.
        if (restricted?.fulltext && ctx.window?.include && typeof out[`${field}_hint`] === "string" && pub.length > 0) {
          delete out[`${field}_hint`];
        }
      }
    }
    if (Array.isArray(value.results) && value.results.some((r) => isPlain(r) && RESTRICTED_MATCHES.has(r.matched_in as string))) {
      out.restricted_match_note = RESTRICTED_MATCH_NOTE;
    }
  }
  return out;
}

function contextFor(store: DataStore, tool: string | null, args: unknown): Ctx {
  const a = (isPlain(args) ? args : {}) as Record<string, unknown>;
  const field = tool ? FULLTEXT_TOOLS.get(tool) : undefined;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  return {
    ...indexes(store),
    window: field
      ? { field, include: a[`include_${field}`] === true, offset: num(a[`${field}_offset`]), maxChars: num(a[`${field}_max_chars`]) }
      : null,
  };
}

/** A JSON value as a curator sees it (rows of an export, a resource body). */
export function curatorValue<T>(value: T, store: DataStore, opts: { tool?: string; args?: unknown; detail?: boolean } = {}): T {
  return walk(value, contextFor(store, opts.tool ?? null, opts.args), opts.detail === false ? 1 : 0) as T;
}

/**
 * Text as a curator sees it: JSON is decorated structurally, anything else has
 * its URLs rewritten. `urlsOnly` skips the structural pass, for text whose
 * rows were already decorated (exports).
 */
export function curatorText(text: string, store: DataStore, opts: { tool?: string; args?: unknown; urlsOnly?: boolean } = {}): string {
  const ctx = contextFor(store, opts.tool ?? null, opts.args);
  const head = text.trimStart()[0];
  if (!opts.urlsOnly && (head === "{" || head === "[")) {
    try {
      return JSON.stringify(walk(JSON.parse(text), ctx, 0));
    } catch {
      // not JSON after all: fall through to the URL rewrite
    }
  }
  return rewriteUrls(text, ctx);
}

/**
 * A result-level note for keyword filters that also matched private full text,
 * or null. Private text is searched only at the full exposure level (#54).
 */
function keywordNote(tool: string, args: unknown, store: DataStore): string | null {
  if (!allowFullText() || !isPlain(args)) return null;
  const given = (v: unknown) => typeof v === "string" && v !== "";
  if (RESEARCH_FILTER_TOOLS.has(tool)) {
    if (!isPlain(args.filters) || !given(args.filters.keyword)) return null;
    const counts = visibilityCounts(store) as { records_with_private_fulltext: number };
    return counts.records_with_private_fulltext ? PRIVATE_KEYWORD_NOTE : null;
  }
  const publicationPath = tool === "list_publication_facets" ||
    (tool === "search_publications" && (given(args.citation_format) || given(args.export)));
  if (!publicationPath || !given(args.keyword)) return null;
  return store.publications.some((p) => p.restricted?.fulltext) ? PRIVATE_PUBLICATION_KEYWORD_NOTE : null;
}

/**
 * A page re-sized after decoration (#54): pageOf sized it before each private
 * row gained `visibility`, `citation_note` and `admin_url`, so a page of private
 * rows could pass the budget. Trailing rows move to the next page.
 */
function fitPage(value: Record<string, unknown>): Record<string, unknown> {
  const rows = value.results;
  if (!Array.isArray(rows) || typeof value.count !== "number" || typeof value.offset !== "number" ||
      typeof value.total_matches !== "number") return value;
  let chars = 0;
  let kept = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length + 1;
    if (kept && chars + size > PAGE_CHAR_BUDGET) break;
    chars += size;
    kept++;
  }
  if (kept === rows.length) return value;
  return { ...value, results: rows.slice(0, kept), count: kept, has_more: true, next_offset: value.offset + kept, response_limited: true };
}

/** A tool result as a curator sees it: structured content and every text block. */
export function curatorToolResult<T>(tool: string, result: T, args: unknown, store: DataStore): T {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const out: Record<string, unknown> = { ...r };
  const note = !r.isError ? keywordNote(tool, args, store) : null;
  const decorate = (value: Record<string, unknown>) => {
    const shown = fitPage(curatorValue(value, store, { tool, args }) as Record<string, unknown>);
    return note ? { ...shown, curator_note: note } : shown;
  };
  let structured: Record<string, unknown> | null = null;
  let structuredText: string | null = null;
  if (isPlain(r.structuredContent)) {
    structuredText = JSON.stringify(r.structuredContent);
    structured = decorate(r.structuredContent);
    out.structuredContent = structured;
  }
  if (Array.isArray(r.content)) {
    out.content = r.content.map((c) => {
      if (!(isPlain(c) && c.type === "text" && typeof c.text === "string")) return c;
      // The usual text block is the structured content, stringified (textResult): decorate it once.
      if (structured && c.text === structuredText) return { ...c, text: JSON.stringify(structured) };
      if (c.text.trimStart().startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(c.text);
          if (isPlain(parsed)) return { ...c, text: JSON.stringify(decorate(parsed)) };
        } catch {
          // not JSON after all: URLs only, below
        }
      }
      return { ...c, text: curatorText(c.text, store, { tool, args }) };
    });
  }
  return out as T;
}
