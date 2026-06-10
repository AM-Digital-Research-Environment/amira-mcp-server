// Readers for Omeka S JSON-LD items (replaces the Mongo/dashboard-era
// mongoJSON.ts). An item is a flat object whose vocabulary-term keys
// (e.g. "dcterms:title", "marcrel:aut") hold ARRAYS of value objects:
//
//   literal             { type: "literal",            "@value": "..." }
//   resource(:item)     { type: "resource:item",      value_resource_id, display_title }
//   uri                 { type: "uri",                "@id": "https://…", "o:label"? }
//   numeric:timestamp   { type: "numeric:timestamp",  "@value": "1969-08-22" }
//   customvocab:N       behaves as resource or literal depending on the vocab
//
// These helpers normalise all of that to strings and {label, o_id} refs. The
// build-time fetcher uses them to produce the snapshot records in types.ts; the
// runtime never sees raw JSON-LD.

import type { LinkedRef } from "./types.js";

export interface OmekaValue {
  type?: string;
  "@value"?: unknown;
  "@id"?: string;
  "o:label"?: string;
  "@language"?: string;
  value_resource_id?: number;
  display_title?: string;
  is_public?: boolean;
}

export type OmekaItem = Record<string, unknown>;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The value array for a vocabulary term ([] when absent or not an array). */
export function values(item: OmekaItem, term: string): OmekaValue[] {
  const v = item[term];
  return Array.isArray(v) ? (v as OmekaValue[]) : [];
}

/** Best human-readable text of one value, regardless of its type. */
export function valueText(v: OmekaValue): string {
  const raw =
    v["@value"] ?? v.display_title ?? v["o:label"] ?? v["@id"] ?? "";
  return String(raw).trim();
}

/** All non-empty texts of a term, in order. */
export function allStrings(item: OmekaItem, term: string): string[] {
  return values(item, term).map(valueText).filter(Boolean);
}

/** First non-empty text of a term, or null. */
export function firstString(item: OmekaItem, term: string): string | null {
  for (const v of values(item, term)) {
    const t = valueText(v);
    if (t) return t;
  }
  return null;
}

/** Linked refs of a term; literal/uri values degrade to label-only refs. */
export function linkedRefs(item: OmekaItem, term: string): LinkedRef[] {
  const out: LinkedRef[] = [];
  for (const v of values(item, term)) {
    const label = valueText(v);
    if (!label) continue;
    out.push({ label, o_id: typeof v.value_resource_id === "number" ? v.value_resource_id : null });
  }
  return out;
}

/** First linked ref of a term, or null. */
export function firstLinked(item: OmekaItem, term: string): LinkedRef | null {
  return linkedRefs(item, term)[0] ?? null;
}

/** URI values of a term as {url, label}. */
export function uriValues(item: OmekaItem, term: string): { url: string; label: string | null }[] {
  const out: { url: string; label: string | null }[] = [];
  for (const v of values(item, term)) {
    const url = typeof v["@id"] === "string" ? v["@id"] : typeof v["@value"] === "string" ? v["@value"] : null;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    out.push({ url, label: v["o:label"]?.trim() || null });
  }
  return out;
}

// --- item-level accessors -----------------------------------------------------

export function oid(item: OmekaItem): number {
  const id = item["o:id"];
  if (typeof id !== "number") throw new Error("Omeka item without numeric o:id");
  return id;
}

export function omekaTitle(item: OmekaItem): string {
  const t = item["o:title"];
  return (typeof t === "string" && t.trim()) || firstString(item, "dcterms:title") || "(untitled)";
}

export function templateId(item: OmekaItem): number | null {
  const t = item["o:resource_template"];
  return isObj(t) && typeof t["o:id"] === "number" ? (t["o:id"] as number) : null;
}

export function classId(item: OmekaItem): number | null {
  const c = item["o:resource_class"];
  return isObj(c) && typeof c["o:id"] === "number" ? (c["o:id"] as number) : null;
}

export function itemSetIds(item: OmekaItem): number[] {
  const sets = item["o:item_set"];
  if (!Array.isArray(sets)) return [];
  return sets.map((s) => (isObj(s) && typeof s["o:id"] === "number" ? (s["o:id"] as number) : null)).filter((x): x is number => x != null);
}

/** o:modified / o:created arrive as {"@value": "ISO"} objects. */
export function systemDate(item: OmekaItem, key: "o:modified" | "o:created"): string | null {
  const v = item[key];
  if (isObj(v) && typeof v["@value"] === "string") return v["@value"];
  return null;
}

/** First 4-digit year found in a date-ish string, or null. */
export function yearOf(text: string | null | undefined): number | null {
  if (!text) return null;
  const m = /(\d{4})/.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1000 && y <= 2100 ? y : null;
}

/**
 * Vocabulary-term properties present on an item (everything that isn't
 * JSON-LD/system bookkeeping) — used to fold the 54 marcrel:* role properties.
 */
export function vocabTerms(item: OmekaItem): string[] {
  return Object.keys(item).filter(
    (k) => !k.startsWith("@") && !k.startsWith("o:") && k !== "thumbnail_display_urls" && Array.isArray(item[k]),
  );
}
