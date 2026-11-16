// Visibility of Omeka resources and values (#26, curator mode).
//
// Omeka S marks a whole resource private with `o:is_public: false` and a single
// value private with `is_public: false`. The anonymous API the public server
// crawls never returns either, so the public snapshot never held them. With a
// curator key the API returns both, and this module keeps them apart:
//
//   - `splitVisibility` runs on every raw resource BEFORE the corpus transforms
//     (src/transform.ts). It removes every private value from the copy the
//     transforms read, so a private value can never land in a public field
//     (`description`, `fulltext`, `transcript`, …), whatever the mode. The
//     private values come back separately, grouped as a `restricted` block.
//   - In public mode the crawl drops private resources and discards the
//     restricted block; `publicView` applies the same rule again to any
//     snapshot loaded from disk. Both are defence in depth: the anonymous API
//     should never have sent them.
//   - In curator mode a private record carries `visibility: "private"` and its
//     private values sit under `restricted`. Public records carry neither key
//     in the snapshot, so a public record is byte-identical in both modes.
import { z } from "zod";
import { config } from "./config.js";
import { annotationRef, valueText, type OmekaItem, type OmekaValue } from "./omekaJSON.js";
import { CORPORA, type CorpusName, type LinkedRef, type SnapshotData } from "./types.js";

/** Private values of one resource, grouped. Only keys with a value are present. */
export interface RestrictedValues {
  /** dre:mongoId — the record's id in the MongoDB source archive. */
  mongo_id?: string;
  /** dre:security — the data security level (DSL1–DSL5). */
  security_level?: string;
  /** dre:bitstream — file references in the source archive. */
  bitstream?: string[];
  /** bibo:content — a private full text (the ILAM OCR text, later private publication texts). */
  fulltext?: string;
  /** The `dre:generatedBy` annotation on that full text. */
  fulltext_generated_by?: LinkedRef;
  /** Every other private value, by property term (`dcterms:description`, …). An
   * annotation value is keyed `<term> @ <annotation term>`. */
  values?: Record<string, string[]>;
}

/** The two keys curator mode adds to a snapshot record. */
export interface VisibilityFields {
  /** Present (and "private") only on a private resource; absent means public. */
  visibility?: "private";
  /** Private values of the resource; absent when it has none. */
  restricted?: RestrictedValues;
}

export const isPrivateRecord = (rec: { visibility?: string } | null | undefined): boolean => rec?.visibility === "private";

/** Said wherever a private record is shown, so it is never passed off as a public source. */
export const PRIVATE_CITATION_NOTE =
  "Private AMIRA record: not publicly accessible. Do not cite it as a public source or link it in public work.";

/** Said with every restricted block. */
export const RESTRICTED_NOTE =
  "Private values: visible to AMIRA curators only, not on the public site. Do not quote or cite them as public.";

/** Output-schema type of a record's `amira_url`. Optional in curator mode only,
 * where a private record carries `admin_url` instead; the public schema is unchanged. */
export const citedUrl = () => (config.access === "curator" ? z.string().optional() : z.string());
export const citedUrlNullable = () => (config.access === "curator" ? z.string().nullable().optional() : z.string().nullable());

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A vocabulary-term key (`dcterms:title`), as opposed to JSON-LD or system bookkeeping. */
const isTermKey = (key: string, value: unknown): boolean => !key.startsWith("@") && !key.startsWith("o:") && Array.isArray(value);

/** A value with its private annotation values removed, plus those values by annotation term. */
function stripAnnotation(v: OmekaValue): { value: OmekaValue; removed: Record<string, OmekaValue[]> } | null {
  const ann = v["@annotation"];
  if (!isObj(ann)) return null;
  let kept: Record<string, OmekaValue[]> | null = null;
  const removed: Record<string, OmekaValue[]> = {};
  for (const [term, list] of Object.entries(ann)) {
    if (!Array.isArray(list) || !list.some((a) => isObj(a) && a.is_public === false)) continue;
    kept ??= { ...ann };
    const pub = list.filter((a) => !(isObj(a) && a.is_public === false));
    removed[term] = list.filter((a) => isObj(a) && a.is_public === false);
    if (pub.length) kept[term] = pub;
    else delete kept[term];
  }
  if (!kept) return null;
  const value: OmekaValue = { ...v };
  if (Object.keys(kept).length) value["@annotation"] = kept;
  else delete value["@annotation"];
  return { value, removed };
}

/** The private values of one resource as a restricted block, or null when there are none. */
function restrictedOf(priv: Record<string, OmekaValue[]>): RestrictedValues | null {
  const out: RestrictedValues = {};
  const values: Record<string, string[]> = {};
  const rest = (term: string, list: OmekaValue[]) => {
    const texts = list.map(valueText).filter(Boolean);
    if (texts.length) values[term] = [...(values[term] ?? []), ...texts];
  };
  const first = (term: string, list: OmekaValue[]): string | undefined => {
    const idx = list.findIndex((v) => valueText(v));
    if (idx < 0) return undefined;
    rest(term, [...list.slice(0, idx), ...list.slice(idx + 1)]);
    return valueText(list[idx]!);
  };
  for (const [term, list] of Object.entries(priv)) {
    if (term === "dre:mongoId") {
      const id = first(term, list);
      if (id) out.mongo_id = id;
    } else if (term === "dre:security") {
      const level = first(term, list);
      if (level) out.security_level = level;
    } else if (term === "dre:bitstream") {
      const files = list.map(valueText).filter(Boolean);
      if (files.length) out.bitstream = files;
    } else if (term === "bibo:content") {
      const idx = list.findIndex((v) => valueText(v));
      if (idx >= 0) {
        out.fulltext = valueText(list[idx]!);
        const by = annotationRef(list[idx]!, "dre:generatedBy");
        if (by) out.fulltext_generated_by = by;
        rest(term, [...list.slice(0, idx), ...list.slice(idx + 1)]);
      }
    } else rest(term, list);
  }
  if (Object.keys(values).length) out.values = values;
  return Object.keys(out).length ? out : null;
}

function addTo(map: Record<string, OmekaValue[]>, key: string, values: OmekaValue[]): void {
  const list = map[key];
  if (list) list.push(...values);
  else map[key] = [...values];
}

/** System references to other resources (item sets, media) that must not name a hidden one. */
const SYSTEM_REFS = ["o:item_set", "o:media"];

/**
 * Split one raw Omeka resource into the copy the transforms may read (private
 * values removed; the input is never mutated), whether the resource itself is
 * public, and its private values. A resource without private values is
 * returned as is.
 *
 * `hidden` (public mode) lists private resources: a value linking to one is
 * dropped as well, as are item-set and media references to one, since an
 * anonymous visitor cannot see the target. Omeka already hides such links from
 * anonymous requests; this keeps the public server safe if it ever did not.
 */
export function splitVisibility(item: OmekaItem, hidden?: ReadonlySet<number>): {
  item: OmekaItem; isPublic: boolean; restricted: RestrictedValues | null;
} {
  const isPublic = item["o:is_public"] !== false;
  let stripped: OmekaItem | null = null;
  const priv: Record<string, OmekaValue[]> = {};
  if (hidden?.size) {
    for (const key of SYSTEM_REFS) {
      const refs = item[key];
      if (!Array.isArray(refs)) continue;
      const kept = refs.filter((r) => !(isObj(r) && typeof r["o:id"] === "number" && hidden.has(r["o:id"])));
      if (kept.length === refs.length) continue;
      stripped ??= { ...item };
      stripped[key] = kept;
    }
  }
  const linksHidden = (v: OmekaValue): boolean => !!hidden?.size && typeof v.value_resource_id === "number" && hidden.has(v.value_resource_id);
  for (const [key, list] of Object.entries(item)) {
    if (!isTermKey(key, list)) continue;
    let changed = false;
    const kept: unknown[] = [];
    for (const v of list as unknown[]) {
      if (!isObj(v)) {
        kept.push(v);
        continue;
      }
      const value = v as OmekaValue;
      if (value.is_public === false || linksHidden(value)) {
        addTo(priv, key, [value]);
        changed = true;
        continue;
      }
      const ann = stripAnnotation(value);
      if (ann) {
        for (const [term, removed] of Object.entries(ann.removed)) addTo(priv, `${key} @ ${term}`, removed);
        kept.push(ann.value);
        changed = true;
      } else kept.push(value);
    }
    if (!changed) continue;
    stripped ??= { ...item };
    if (kept.length) stripped[key] = kept;
    else delete stripped[key];
  }
  return { item: stripped ?? item, isPublic, restricted: restrictedOf(priv) };
}

/** Attach curator-mode visibility to a transformed record (public records stay untouched). */
export function withVisibility<T extends object>(record: T, isPublic: boolean, restricted: RestrictedValues | null): T & VisibilityFields {
  if (isPublic && !restricted) return record;
  return { ...record, ...(isPublic ? {} : { visibility: "private" as const }), ...(restricted ? { restricted } : {}) };
}

type AnyRecord = { o_id: number; visibility?: string; restricted?: unknown; media?: { visibility?: string }[] };

const leaks = (r: AnyRecord): boolean =>
  r.visibility === "private" || r.restricted !== undefined || (Array.isArray(r.media) && r.media.some((m) => m?.visibility === "private"));

/**
 * Public mode, defence in depth: the snapshot without any private record,
 * restricted block or private media file. Returns the input unchanged (same
 * object) when there is nothing to drop, which is always the case for a
 * snapshot the public crawl wrote.
 */
export function publicView(data: SnapshotData): { data: SnapshotData; dropped: number } {
  let dropped = 0;
  let out: SnapshotData | null = null;
  for (const corpus of CORPORA) {
    const list = (data[corpus] ?? []) as unknown as AnyRecord[];
    if (!list.some(leaks)) continue;
    out ??= { ...data };
    const kept: AnyRecord[] = [];
    for (const r of list) {
      if (r.visibility === "private") {
        dropped++;
        continue;
      }
      if (!leaks(r)) {
        kept.push(r);
        continue;
      }
      const { restricted: _r, visibility: _v, ...rest } = r;
      if (Array.isArray(rest.media)) rest.media = rest.media.filter((m) => m?.visibility !== "private");
      kept.push(rest as AnyRecord);
    }
    (out as unknown as Record<CorpusName, AnyRecord[]>)[corpus] = kept;
  }
  return { data: out ?? data, dropped };
}
