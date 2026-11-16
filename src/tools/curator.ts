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
//   - media rows carry `visibility`; a private one has no file `url`, only
//     `admin_url`; a `thumbnail` drawn from a private media, and the IIIF
//     manifest or collection of a private record, are null;
//   - a detail result (top-level `omeka_id`) gains the record's `restricted`
//     block: its private values, and its private full text, windowed like
//     every other long text (`include_fulltext`, `fulltext_offset`,
//     `fulltext_max_chars`).
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
import type { DataStore } from "../data.js";
import { adminItemSetUrl, adminItemUrl, adminMediaUrl } from "../urls.js";
import { PRIVATE_CITATION_NOTE, RESTRICTED_NOTE, type RestrictedValues } from "../visibility.js";
import { CHARACTER_LIMIT, scrub } from "./responses.js";
import { textWindowFields } from "./textWindows.js";

type Visibility = "public" | "private";

/** Tools whose arguments page a full text (`include_fulltext`, …), which also pages the restricted one. */
const FULLTEXT_TOOLS = new Set(["get_research_item", "get_publication"]);

/** Tools other than search_research_items that select research items with the shared filters, keyword included. */
const RESEARCH_FILTER_TOOLS = new Set(["list_years", "list_locations", "compare_collections"]);

/** Said on a result whose keyword filter also matched research items' private full text. */
export const PRIVATE_KEYWORD_NOTE =
  "Curator mode: the keyword filter also matches research items' private full text (the ILAM OCR text), so these counts " +
  "may include items matched only there. search_research_items marks such rows with matched_in.";

/** Said on a search result with rows matched only in a private full text. */
export const RESTRICTED_MATCH_NOTE =
  "Rows with matched_in \"restricted_fulltext\" matched only in a private full text: their fulltext_snippet is private. " +
  "Do not quote or cite it as public.";

interface Indexed {
  o_id: number;
  visibility?: string;
  restricted?: RestrictedValues;
  media?: { o_id: number; url: string | null; visibility?: string }[];
}

/** Every record of the store, the corpus it belongs to first. */
function corpora(store: DataStore): [string, Indexed[]][] {
  return [
    ["research_items", store.items], ["projects", store.projects], ["persons", store.persons],
    ["organisations", store.organisations], ["locations", store.locations], ["research_sections", store.sections],
    ["publications", store.publications], ["journals", store.journals], ["podcasts", store.podcasts],
    ["videos", store.videos], ["playlists", store.playlists], ["languages", store.languageIndex.all],
    ["item_sets", store.itemSets], ["subjects", store.subjects],
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
  /** Private media by file stem (`/files/<size>/<stem>.<ext>`: originals and thumbnails share it). */
  privateFiles: Map<string, number>;
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
    const privateFiles = new Map<string, number>();
    for (const [, list] of corpora(store)) {
      for (const r of list) {
        visibility.set(r.o_id, r.visibility === "private" ? "private" : "public");
        if (r.restricted) restricted.set(r.o_id, r.restricted);
        for (const m of r.media ?? []) {
          const vis: Visibility = m.visibility === "private" ? "private" : "public";
          visibility.set(m.o_id, vis);
          media.add(m.o_id);
          if (!m.url) continue;
          mediaByUrl.set(m.url, { id: m.o_id, visibility: vis });
          const stem = vis === "private" ? fileStem(m.url) : null;
          if (stem) privateFiles.set(stem, m.o_id);
        }
      }
    }
    const listed = store.manifest.privateItemIds;
    return {
      visibility, restricted, media, mediaByUrl, privateFiles,
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
/** Every URL form that names one resource: its public page, its API URL, its IIIF manifest or collection, a file. */
const ANY_URL = new RegExp(
  `${ROOT}(?:${PAGE}(?!\\d)|/api/(items|item_sets|media)/(\\d+)(?!\\d)|/iiif/3/(?:(collection)/)?(\\d+)(?:/manifest)?(?!\\d)` +
  `|/files/[A-Za-z0-9_-]+/([^\\s"'<>?#/\\\\]+))`, "g");
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
  window: { include?: boolean; offset?: number; maxChars?: number } | null;
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

/** Every URL of a private resource in `text`, replaced by its admin URL. */
function rewriteUrls(text: string, ctx: Ctx): string {
  if (!text.includes(SITE_HOST)) return text;
  return text.replace(ANY_URL, (url, page?: string, pageId?: string, api?: string, apiId?: string, iiif?: string, iiifId?: string,
    file?: string) => {
    if (file !== undefined) {
      const stem = file.replace(/\.[A-Za-z0-9]+$/, "");
      const media = ctx.privateFiles.get(stem);
      return media != null ? adminMediaUrl(media) : url;
    }
    const id = Number(pageId ?? apiId ?? iiifId);
    if (lookup(ctx, id) !== "private") return url;
    const kind: Kind = page ? (page as Kind) : api ? (api === "items" ? "item" : api === "item_sets" ? "item-set" : "media")
      : iiif ? "item-set" : kindOf(ctx, id);
    return adminUrl(kind, id);
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

/**
 * A record's restricted block as returned to a curator. `publicWindow` is how
 * many characters of public full text the same result already returns: the
 * restricted window shares that budget, so one result stays within it.
 */
function restrictedBlock(r: RestrictedValues | undefined, ctx: Ctx, publicWindow: number): Record<string, unknown> {
  const out: Record<string, unknown> = { note: RESTRICTED_NOTE };
  if (r?.mongo_id) out.mongo_id = r.mongo_id;
  if (r?.security_level) out.security_level = r.security_level;
  if (r?.bitstream) out.bitstream = r.bitstream.map(capped);
  if (r?.values) out.values = Object.fromEntries(Object.entries(r.values).map(([term, texts]) => [term, texts.map(capped)]));
  if (r?.fulltext) {
    Object.assign(out, ctx.window
      ? textWindowFields("fulltext", r.fulltext, { ...ctx.window, budget: Math.max(1, CHARACTER_LIMIT - publicWindow) })
      : { has_fulltext: true, fulltext_length: r.fulltext.length });
    if (r.fulltext_generated_by) out.fulltext_generated_by = r.fulltext_generated_by.label;
  } else if (ctx.window?.include) {
    // Asked for the private full text: say there is none rather than staying silent.
    out.has_fulltext = false;
  }
  return scrub(walk(out, ctx, 1) as Record<string, unknown>);
}

/** One media row: `visibility` always; a private one has no direct file URL, only its admin page. */
function mediaRow(row: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const known = typeof row.url === "string" ? ctx.mediaByUrl.get(row.url) : undefined;
  const isPrivate = row.visibility === "private" || known?.visibility === "private";
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(row)) {
    if (key === "visibility") continue;
    out[key] = isPrivate && key === "url" ? null : walk(v, ctx, 2);
  }
  if (isPrivate && known) out.admin_url = adminMediaUrl(known.id);
  out.visibility = isPrivate ? "private" : "public";
  return out;
}

const isMediaList = (v: unknown[]): boolean => v.every((m) => isPlain(m) && "url" in m && "type" in m);

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
  // cites its project's page): the most restrictive of the two wins.
  const ownId = citesBy && typeof value.omeka_id === "number" && value.omeka_id !== cited?.id ? value.omeka_id : null;
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
      out.media = v.map((m) => mediaRow(m as Record<string, unknown>, ctx));
      continue;
    }
    if (key === "thumbnail" && isPrivateFile(v, ctx)) {
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
        const publicWindow = typeof value.fulltext_returned_chars === "number" ? value.fulltext_returned_chars : 0;
        out.restricted = restrictedBlock(restricted, ctx, publicWindow);
      }
    }
    if (Array.isArray(value.results) && value.results.some((r) => isPlain(r) && r.matched_in === "restricted_fulltext")) {
      out.restricted_match_note = RESTRICTED_MATCH_NOTE;
    }
  }
  return out;
}

function contextFor(store: DataStore, tool: string | null, args: unknown): Ctx {
  const a = (isPlain(args) ? args : {}) as { include_fulltext?: boolean; fulltext_offset?: number; fulltext_max_chars?: number };
  return {
    ...indexes(store),
    window: tool && FULLTEXT_TOOLS.has(tool) ? { include: a.include_fulltext, offset: a.fulltext_offset, maxChars: a.fulltext_max_chars } : null,
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

/** A result-level note for keyword filters that also matched private full text, or null. */
function keywordNote(tool: string, args: unknown, store: DataStore): string | null {
  if (!RESEARCH_FILTER_TOOLS.has(tool) || !isPlain(args) || !isPlain(args.filters)) return null;
  if (typeof args.filters.keyword !== "string" || !args.filters.keyword) return null;
  const counts = visibilityCounts(store) as { records_with_private_fulltext: number };
  return counts.records_with_private_fulltext ? PRIVATE_KEYWORD_NOTE : null;
}

/** A tool result as a curator sees it: structured content and every text block. */
export function curatorToolResult<T>(tool: string, result: T, args: unknown, store: DataStore): T {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  const out: Record<string, unknown> = { ...r };
  const note = !r.isError ? keywordNote(tool, args, store) : null;
  const decorate = (value: Record<string, unknown>) => {
    const shown = curatorValue(value, store, { tool, args });
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
      let text = curatorText(c.text, store, { tool, args });
      if (note && text.startsWith("{")) {
        try {
          text = JSON.stringify({ ...JSON.parse(text), curator_note: note });
        } catch {
          // not a JSON object: left as decorated
        }
      }
      return { ...c, text };
    });
  }
  return out as T;
}
