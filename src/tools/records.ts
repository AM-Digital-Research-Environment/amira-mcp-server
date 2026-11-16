// The `id` argument of a detail tool: a bare Omeka id (or the kind's legacy
// key), or a typed id in either vocabulary (`podcast:39121`, `item:9902`).
// Eight tools used to strip their own prefix and quietly miss on any other:
// `get_podcast` with `video:39218` said only "No podcast with id video:39218".
// A typed id of another kind now names the tool that reads it, and so does a
// bare Omeka id of another kind (Omeka ids share one id space).
import type { DataStore } from "../data.js";
import { detailToolOf, findRecord, RECORD_KINDS, recordByOId, type RecordTypes, type StoredKind } from "../recordKinds.js";
import { parseTypedId } from "../typedIds.js";
import { errorResult } from "./responses.js";

type ErrorResult = ReturnType<typeof errorResult>;

const LABEL: Partial<Record<string, string>> = { research_item: "research item", section: "research section", organisation: "institution" };
const label = (kind: string) => LABEL[kind] ?? kind;
const withArticle = (kind: string) => `${/^[aeiou]/.test(label(kind)) ? "an" : "a"} ${label(kind)}`;

/** The tool that reads a record of `kind`: its detail tool, else its list/search tool. */
export const toolForKind = (kind: StoredKind): string => RECORD_KINDS[kind].detail?.tool ?? RECORD_KINDS[kind].search ?? "resolve_entity";

/**
 * When `key` is a bare Omeka id of a record of ANOTHER kind, what it is and the
 * tool that reads it; null when it names nothing (or a record of `kind`).
 */
export function otherKindOfOId(store: DataStore, key: string, kind: StoredKind): { kind: StoredKind; tool: string } | null {
  if (!/^\d+$/.test(key)) return null;
  const hit = recordByOId(store, Number(key));
  return hit && hit.kind !== kind ? { kind: hit.kind, tool: toolForKind(hit.kind) } : null;
}

/** A wrong-kind message: "'414' is a person id, not a research item id." */
export const wrongKindMessage = (text: string, actual: string, expected: string) =>
  `'${text}' is ${withArticle(actual)} id, not ${withArticle(expected)} id.`;

/** The record `raw` names, or the error to return: `notFound()` for an unknown
 * key, a wrong-kind error naming the right tool for an id of another kind, and
 * `invalid_id` for text that cannot be an id at all (no digit, no known key). */
export function recordArg<K extends StoredKind>(store: DataStore, raw: string | number, kind: K,
  notFound: () => ErrorResult): { record: RecordTypes[K] } | { error: ErrorResult } {
  const text = String(raw).trim();
  const typed = parseTypedId(text);
  if (typed && typed.kind !== kind) {
    const tool = detailToolOf(typed.kind);
    const message = wrongKindMessage(text, typed.kind, kind);
    return { error: errorResult("not_found", message, { suggested_tool: tool ?? "resolve_entity", terse: message }) };
  }
  const key = typed?.key ?? text;
  const record = findRecord(store, kind, key);
  if (record) return { record };
  const other = otherKindOfOId(store, key, kind);
  if (other) {
    const message = `${wrongKindMessage(text, other.kind, kind)} Read it with ${other.tool}.`;
    return { error: errorResult("not_found", message, { suggested_tool: other.tool, terse: wrongKindMessage(text, other.kind, kind) }) };
  }
  // Every Omeka id and every legacy key (dre:id, ERef/EPub id) holds a digit.
  if (!/\d/.test(key)) {
    const message = `'${text}' is not ${withArticle(kind)} id: pass its Omeka id (a number) or a typed id such as ${kind}:123.`;
    return { error: errorResult("invalid_id", message, { suggested_tool: RECORD_KINDS[kind].search, terse: `'${text}' is not ${withArticle(kind)} id.` }) };
  }
  return { error: notFound() };
}
