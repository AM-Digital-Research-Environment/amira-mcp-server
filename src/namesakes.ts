// Retired private duplicates of public authority records (curator mode).
//
// Curator data holds a few private person and organisation records that are
// retired duplicates of a public record with the same name. Name resolution
// used to land on the private copy (an empty profile) or report ambiguity
// between the two. The tools resolve such a name to the public record, list
// the private copy after it, and point from the private copy to the public one
// (`possible_duplicate_of`), so a curator is led to the canonical record.
//
// Public mode holds no private record, so none of this changes its output:
// every helper returns at once for a public record, and the name index is
// built only the first time a private record is looked up.
import { config } from "./config.js";
import type { DataStore } from "./data.js";
import { nameKey } from "./names.js";
import { fold } from "./text.js";
import type { OrganisationRec, PersonRec } from "./types.js";
import { itemUrl } from "./urls.js";
import { isPrivateRecord } from "./visibility.js";

export type NamesakeKind = "person" | "organisation";
type Named = PersonRec | OrganisationRec;

/** The comparison key of a name: order-independent for people ("Surname, Forename"), folded for organisations. */
const keyOf = (name: string, kind: NamesakeKind): string => (kind === "person" ? nameKey(name) : fold(name).trim());

/** Public records by name key, per kind, built once per snapshot. */
function publicByKey(store: DataStore, kind: NamesakeKind): Map<string, Named> {
  return store.cached(`namesakes:${kind}`, () => {
    const map = new Map<string, Named>();
    const rows: readonly Named[] = kind === "person" ? store.persons : store.organisations;
    for (const r of rows) {
      const key = keyOf(r.name, kind);
      if (key && !isPrivateRecord(r) && !map.has(key)) map.set(key, r);
    }
    return map;
  });
}

/**
 * The public record with the same name as a PRIVATE `record` of `kind`, or
 * undefined (also for a public record). The one implementation of this rule:
 * people compare by `nameKey`, so "Bationo, Fernand" and "Fernand Bationo" are
 * namesakes; organisations by their folded name.
 */
export function publicNamesakeOf<T extends Named>(store: DataStore, record: T | null | undefined, kind: NamesakeKind): T | undefined {
  if (!record || !isPrivateRecord(record)) return undefined;
  const found = publicByKey(store, kind).get(keyOf(record.name, kind));
  return found && found.o_id !== record.o_id ? (found as T) : undefined;
}

/** `{ possible_duplicate_of }` for a private record with a public namesake (curator mode only), else `{}`. */
export function duplicatePointer(store: DataStore, record: Named | null | undefined, kind: NamesakeKind): Record<string, unknown> {
  if (config.access !== "curator") return {};
  const canonical = publicNamesakeOf(store, record, kind);
  return canonical ? { possible_duplicate_of: { name: canonical.name, omeka_id: canonical.o_id, amira_url: itemUrl(canonical.o_id) } } : {};
}

/** `records` without the private ones whose public namesake is also among them. */
export function withoutPrivateNamesakes<T extends Named>(store: DataStore, records: readonly T[], kind: NamesakeKind): T[] {
  if (!records.some(isPrivateRecord)) return [...records];
  const ids = new Set(records.map((r) => r.o_id));
  return records.filter((r) => {
    const canonical = publicNamesakeOf(store, r, kind);
    return !canonical || !ids.has(canonical.o_id);
  });
}

/** `records` with private records after public ones, order otherwise kept (stable). */
export function publicFirst<T extends { visibility?: string }>(records: T[]): T[] {
  if (!records.some(isPrivateRecord)) return records;
  return [...records.filter((r) => !isPrivateRecord(r)), ...records.filter(isPrivateRecord)];
}
