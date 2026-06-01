// Normalise the dashboard's Extended-JSON value wrappers exactly as the amira
// dashboard does at load time, so the rest of the server works with plain JS
// values.
//
//   {$oid: "..."}              -> string
//   {$date: "..."}             -> ISO string (kept as string; we only serialise)
//   {$numberDouble: "NaN"}     -> null
//   {$numberInt|Long|Double}   -> number (finite values)
//
// Plus the dashboard's location quirk: location.origin[].l1/l2/l3 may be a
// string OR a string[] in the raw data — flatten arrays to their first element.

type Json = unknown;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively unwrap Extended-JSON value wrappers. */
export function transformMongoJSON<T = Json>(value: Json): T {
  if (Array.isArray(value)) {
    return value.map((v) => transformMongoJSON(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);

    // Single-key wrapper objects.
    if (keys.length === 1) {
      const key = keys[0]!;
      const inner = value[key];
      switch (key) {
        case "$oid":
          return String(inner) as unknown as T;
        case "$date":
          // May nest as {$date: {$numberLong: "..."}}; coerce to ISO.
          if (isPlainObject(inner) && "$numberLong" in inner) {
            const ms = Number((inner as Record<string, unknown>).$numberLong);
            return new Date(ms).toISOString() as unknown as T;
          }
          return String(inner) as unknown as T;
        case "$numberDouble": {
          const s = String(inner);
          if (s === "NaN" || s === "Infinity" || s === "-Infinity") {
            return null as unknown as T;
          }
          return Number(s) as unknown as T;
        }
        case "$numberInt":
        case "$numberLong":
          return Number(inner) as unknown as T;
        default:
          break;
      }
    }

    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = transformMongoJSON(value[k]);
    return out as unknown as T;
  }
  return value as T;
}

/** Flatten a value that may be a string or a string[] to a trimmed string. */
export function flattenToString(v: unknown): string {
  if (Array.isArray(v)) return flattenToString(v[0]);
  if (v == null) return "";
  return String(v).trim();
}

/**
 * Normalise the location.origin entries of a collection item in place, so l1/l2/l3
 * are always plain strings (matching the dashboard's collectionLoader behaviour).
 */
export function normaliseItemLocation(item: Record<string, unknown>): void {
  const loc = item.location as Record<string, unknown> | undefined;
  if (!loc || !Array.isArray(loc.origin)) return;
  loc.origin = (loc.origin as unknown[]).map((o) => {
    const origin = isPlainObject(o) ? o : {};
    return {
      l1: flattenToString(origin.l1),
      l2: flattenToString(origin.l2),
      l3: flattenToString(origin.l3),
    };
  });
}
