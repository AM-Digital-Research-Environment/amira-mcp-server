// The `id` argument of a detail tool: a bare Omeka id (or the kind's legacy
// key), or a typed id in either vocabulary (`podcast:39121`, `item:9902`).
// Eight tools used to strip their own prefix and quietly miss on any other:
// `get_podcast` with `video:39218` said only "No podcast with id video:39218".
// A typed id of another kind now names the tool that reads it.
import type { DataStore } from "../data.js";
import { detailToolOf, findRecord, type RecordTypes, type StoredKind } from "../recordKinds.js";
import { parseTypedId } from "../typedIds.js";
import { errorResult } from "./responses.js";

type ErrorResult = ReturnType<typeof errorResult>;

const LABEL: Partial<Record<string, string>> = { research_item: "research item", section: "research section", organisation: "institution" };
const label = (kind: string) => LABEL[kind] ?? kind;
const withArticle = (kind: string) => `${/^[aeiou]/.test(label(kind)) ? "an" : "a"} ${label(kind)}`;

/** The record `raw` names, or the error to return: `notFound()` for an unknown
 * key, a wrong-kind error naming the right tool for a typed id of another kind. */
export function recordArg<K extends StoredKind>(store: DataStore, raw: string | number, kind: K,
  notFound: () => ErrorResult): { record: RecordTypes[K] } | { error: ErrorResult } {
  const text = String(raw).trim();
  const typed = parseTypedId(text);
  if (typed && typed.kind !== kind) {
    const tool = detailToolOf(typed.kind);
    const message = `'${text}' is ${withArticle(typed.kind)} id, not ${withArticle(kind)} id.`;
    return { error: errorResult("not_found", message, { suggested_tool: tool ?? "resolve_entity", terse: message }) };
  }
  const record = findRecord(store, kind, typed?.key ?? text);
  return record ? { record } : { error: notFound() };
}
