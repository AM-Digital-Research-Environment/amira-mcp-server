// How find_related matches `value` for each pivot, surfaced in the response and
// the tool description so the (sometimes surprising) counts are self-explaining.
export type EntityType = "subject" | "location" | "person" | "project" | "research_item" | "record";

export const MATCHING: Record<EntityType, string> = {
  subject:
    "Items whose subject label CONTAINS the value (substring, case-insensitive; subjects include the former free-form tags). " +
    "This is why matched_items can exceed an exact-heading count — and differ from list_subjects, which lists distinct headings, not items.",
  location:
    "Items whose place matches the value exactly (or by a common alias) at ANY level of the city→country hierarchy, so 'Nigeria' " +
    "also matches Lagos items but 'Niger' does not match Nigeria. An unknown name falls back to word prefixes ('Ibad' → Ibadan).",
  person:
    "Items crediting one person: the authority record the value resolves to (a name in either order, accent-insensitive, " +
    "e.g. 'Ulli Beier' = 'Beier, Ulli', or person:<id>). A value matching several people is refused with their ids.",
  project: "Items in the project whose Omeka id or legacy project key equals the value, or whose project label contains it.",
  research_item:
    "The seed article's closest articles in the ILAM journal African Music by full-text embedding (DRE Visualizations' map); " +
    "the related_* lists count what those articles share. Only articles on the full-text map can be seeds.",
  record:
    "The seed record's 20 closest records by meaning, of any type (EmbeddingGemma 2 vectors of catalogue descriptions: " +
    "research items, publications, videos, podcasts, projects, sections); the related_* lists count what those records share. " +
    "Similar wording, not documented links.",
};
