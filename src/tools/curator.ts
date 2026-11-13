// How curator mode shows private records and private values (#26). Applied in
// one place, after every tool handler (src/tools/policy.ts) and on every
// resource (src/resources.ts), so no tool can forget it:
//
//   - every object that cites a record (`amira_url`) gains `visibility`;
//   - a private record loses its `amira_url` (anonymous visitors cannot open
//     it) and gets `admin_url`, the Omeka admin page, plus `citation_note`;
//   - any other public URL of a private record, wherever it appears in a
//     string (a citation, a `fetch` document, a BibTeX entry), becomes its
//     admin URL;
//   - a detail result (top-level `omeka_id`) gains the record's `restricted`
//     block: its private values, and its private full text, windowed like
//     every other long text (`include_fulltext`, `fulltext_offset`,
//     `fulltext_max_chars`).
//
// Public mode never calls this: its store holds no private record or value
// (src/visibility.ts), so its output is unchanged.
import { SITE_BASE, SITE_SLUG } from "../config.js";
import type { DataStore } from "../data.js";
import { adminItemSetUrl, adminItemUrl } from "../urls.js";
import { PRIVATE_CITATION_NOTE, RESTRICTED_NOTE, type RestrictedValues } from "../visibility.js";
import { CHARACTER_LIMIT, scrub } from "./responses.js";
import { textWindowFields } from "./textWindows.js";

type Visibility = "public" | "private";

/** Tools whose arguments page a full text (`include_fulltext`, …), which also pages the restricted one. */
const FULLTEXT_TOOLS = new Set(["get_research_item", "get_publication"]);

interface Indexed {
  o_id: number;
  visibility?: string;
  restricted?: RestrictedValues;
}

/** Every record of the store, the corpus it belongs to first. */
function corpora(store: DataStore): [string, Indexed[]][] {
  return [
    ["research_items", store.items], ["projects", store.projects], ["persons", store.persons],
    ["organisations", store.organisations], ["locations", store.locations], ["research_sections", store.sections],
    ["publications", store.publications], ["journals", store.journals], ["podcasts", store.podcasts],
    ["videos", store.videos], ["playlists", store.playlists], ["item_sets", store.itemSets], ["subjects", store.subjects],
  ];
}

/** Visibility and restricted values by Omeka id (items and item sets share one id space). */
function indexes(store: DataStore): { visibility: Map<number, Visibility>; restricted: Map<number, RestrictedValues> } {
  return store.cached("curator:indexes", () => {
    const visibility = new Map<number, Visibility>();
    const restricted = new Map<number, RestrictedValues>();
    for (const [, list] of corpora(store)) {
      for (const r of list) {
        visibility.set(r.o_id, r.visibility === "private" ? "private" : "public");
        if (r.restricted) restricted.set(r.o_id, r.restricted);
      }
    }
    return { visibility, restricted };
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
const PUBLIC_URL = new RegExp(`${escapeRe(`${SITE_BASE}/s/${SITE_SLUG}/`)}(item|item-set)/(\\d+)(?!\\d)`, "g");
const PUBLIC_URL_EXACT = new RegExp(`^${escapeRe(`${SITE_BASE}/s/${SITE_SLUG}/`)}(item|item-set)/(\\d+)$`);

function parsePublicUrl(url: unknown): { kind: string; id: number } | null {
  if (typeof url !== "string") return null;
  const m = PUBLIC_URL_EXACT.exec(url);
  return m ? { kind: m[1]!, id: Number(m[2]) } : null;
}

const adminUrl = (kind: string, id: number): string => (kind === "item-set" ? adminItemSetUrl(id) : adminItemUrl(id));

interface Ctx {
  visibility: Map<number, Visibility>;
  restricted: Map<number, RestrictedValues>;
  /** Window options for the restricted full text, when the tool pages full texts. */
  window: { include?: boolean; offset?: number; maxChars?: number } | null;
}

/** Every public URL of a private record in `text`, replaced by its admin URL. */
function rewriteUrls(text: string, ctx: Ctx): string {
  if (!text.includes(SITE_BASE)) return text;
  return text.replace(PUBLIC_URL, (url, kind: string, id: string) =>
    ctx.visibility.get(Number(id)) === "private" ? adminUrl(kind, Number(id)) : url);
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** A record's restricted block as returned to a curator. */
function restrictedBlock(r: RestrictedValues, ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = { note: RESTRICTED_NOTE };
  if (r.mongo_id) out.mongo_id = r.mongo_id;
  if (r.security_level) out.security_level = r.security_level;
  if (r.bitstream) out.bitstream = r.bitstream;
  if (r.values) {
    out.values = Object.fromEntries(Object.entries(r.values).map(([term, texts]) => [term, texts.map((t) => t.slice(0, CHARACTER_LIMIT))]));
  }
  if (r.fulltext) {
    Object.assign(out, ctx.window
      ? textWindowFields("fulltext", r.fulltext, ctx.window)
      : { has_fulltext: true, fulltext_length: r.fulltext.length });
    if (r.fulltext_generated_by) out.fulltext_generated_by = r.fulltext_generated_by.label;
  }
  return scrub(walk(out, ctx, 1) as Record<string, unknown>);
}

function walk(value: unknown, ctx: Ctx, depth: number): unknown {
  if (typeof value === "string") return rewriteUrls(value, ctx);
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx, depth + 1));
  if (!isPlain(value)) return value;
  const cited = "amira_url" in value ? parsePublicUrl(value.amira_url) : null;
  const id = cited?.id ?? (typeof value.omeka_id === "number" && "amira_url" in value ? value.omeka_id : null);
  const vis = id != null ? ctx.visibility.get(id) : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === "amira_url" && vis === "private" && cited) {
      out.admin_url = adminUrl(cited.kind, cited.id);
      continue;
    }
    if (key.endsWith("_amira_url")) {
      const ref = parsePublicUrl(v);
      if (ref && ctx.visibility.get(ref.id) === "private") {
        out[`${key.slice(0, -"amira_url".length)}admin_url`] = adminUrl(ref.kind, ref.id);
        continue;
      }
    }
    out[key] = walk(v, ctx, depth + 1);
  }
  if (vis) {
    out.visibility = vis;
    if (vis === "private") out.citation_note = PRIVATE_CITATION_NOTE;
  }
  if (depth === 0 && typeof value.omeka_id === "number") {
    const restricted = ctx.restricted.get(value.omeka_id);
    if (restricted) out.restricted = restrictedBlock(restricted, ctx);
  }
  return out;
}

function contextFor(store: DataStore, tool: string | null, args: unknown): Ctx {
  const { visibility, restricted } = indexes(store);
  const a = (isPlain(args) ? args : {}) as { include_fulltext?: boolean; fulltext_offset?: number; fulltext_max_chars?: number };
  return {
    visibility,
    restricted,
    window: tool && FULLTEXT_TOOLS.has(tool) ? { include: a.include_fulltext, offset: a.fulltext_offset, maxChars: a.fulltext_max_chars } : null,
  };
}

/** A JSON value as a curator sees it (rows of an export, a resource body). */
export function curatorValue<T>(value: T, store: DataStore, opts: { tool?: string; args?: unknown; detail?: boolean } = {}): T {
  return walk(value, contextFor(store, opts.tool ?? null, opts.args), opts.detail === false ? 1 : 0) as T;
}

/** Text as a curator sees it: JSON is decorated structurally, anything else has its URLs rewritten. */
export function curatorText(text: string, store: DataStore, opts: { tool?: string; args?: unknown } = {}): string {
  const ctx = contextFor(store, opts.tool ?? null, opts.args);
  const head = text.trimStart()[0];
  if (head === "{" || head === "[") {
    try {
      return JSON.stringify(walk(JSON.parse(text), ctx, 0));
    } catch {
      // not JSON after all: fall through to the URL rewrite
    }
  }
  return rewriteUrls(text, ctx);
}

/** A tool result as a curator sees it: structured content and every text block. */
export function curatorToolResult<T>(tool: string, result: T, args: unknown, store: DataStore): T {
  if (!result || typeof result !== "object") return result;
  const r = result as { content?: unknown; structuredContent?: unknown };
  const out: Record<string, unknown> = { ...r };
  if (isPlain(r.structuredContent)) out.structuredContent = curatorValue(r.structuredContent, store, { tool, args });
  if (Array.isArray(r.content)) {
    out.content = r.content.map((c) => (isPlain(c) && c.type === "text" && typeof c.text === "string"
      ? { ...c, text: curatorText(c.text, store, { tool, args }) } : c));
  }
  return out as T;
}
