// Typed record IDs. Two vocabularies grew up separately: the ChatGPT adapter
// (`search`/`fetch`) emits `item:7392` / `pub:29919`, while the v1.18 research
// tools (`resolve_entity`, `get_entity_graph`, `get_text_passages`) emit
// `research_item:7392` / `publication:29919`. Each tool rejected the other's
// IDs. Every tool now parses both, and the detail tools accept a typed ID too.

export type RecordKind =
  | "research_item" | "publication" | "video" | "podcast" | "project" | "section" | "person" | "organisation"
  | "location" | "subject" | "journal" | "collection" | "playlist" | "language" | "format";

const PREFIXES: Record<string, RecordKind> = {
  item: "research_item", research_item: "research_item",
  pub: "publication", publication: "publication",
  video: "video", podcast: "podcast", project: "project",
  section: "section", research_section: "section",
  person: "person",
  organisation: "organisation", organization: "organisation", institution: "organisation", group: "organisation",
  location: "location", place: "location",
  subject: "subject", journal: "journal",
  collection: "collection", item_set: "collection",
  playlist: "playlist", language: "language", format: "format",
};

/** `{kind, key}` for a typed ID in either vocabulary, or null for a bare value. */
export function parseTypedId(raw: string): { kind: RecordKind; key: string } | null {
  const value = raw.trim();
  const sep = value.indexOf(":");
  if (sep <= 0) return null;
  const kind = PREFIXES[value.slice(0, sep).toLowerCase()];
  return kind ? { kind, key: value.slice(sep + 1).trim() } : null;
}

/** The canonical (entity-graph) form, e.g. `item:7392` → `research_item:7392`. */
export function canonicalTypedId(raw: string): string {
  const parsed = parseTypedId(raw);
  return parsed ? `${parsed.kind}:${parsed.key}` : raw.trim();
}

/** Strip a typed prefix when it names one of `kinds`; otherwise return the value as is. */
export function stripTypedId(raw: string, kinds: RecordKind[]): string {
  const parsed = parseTypedId(raw);
  return parsed && kinds.includes(parsed.kind) ? parsed.key : raw.trim();
}
