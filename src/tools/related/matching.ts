// How find_related matches `value` for each pivot, surfaced in the response and
// the tool description so the (sometimes surprising) counts are self-explaining.
export type EntityType = "subject" | "location" | "person" | "project" | "research_item" | "record";

/** Most rows in a sample list (sample_items, related_publications, closest); a smaller `limit` lowers it. */
export const SAMPLE_CAP = 10;

export const MATCHING: Record<EntityType, string> = {
  subject:
    "Items whose subject label CONTAINS the value (substring, case-insensitive; subjects include the former free-form tags). " +
    "This is why matched_items can exceed an exact-heading count — and differ from list_subjects, which lists distinct headings, not items. " +
    "matched_values names the headings pooled.",
  location:
    "Items whose place matches the value exactly (or by a common alias) at ANY level of the city→country hierarchy, so 'Nigeria' " +
    "also matches Lagos items but 'Niger' does not match Nigeria. An unknown name falls back to word prefixes ('Ibad' → Ibadan). " +
    "matched_values names the places pooled.",
  person:
    "Items crediting one person: the authority record the value resolves to (a name in either order, accent-insensitive, " +
    "e.g. 'Ulli Beier' = 'Beier, Ulli', or person:<id>). A value matching several people is refused with their ids.",
  project:
    "Items of one project: the one whose Omeka id, legacy key, name or name variant equals the value, else the only project " +
    "whose name holds every word of the value as a whole word. A value matching several projects is refused with their ids.",
  research_item:
    "The seed article's closest articles in the ILAM journal African Music by full-text embedding (DRE Visualizations' map); " +
    "the related_* lists count what those articles share. The value is the article's item id, not a text query; only articles " +
    "on the full-text map can be seeds.",
  record:
    "The seed record's 20 closest records by meaning, of any type (EmbeddingGemma 2 vectors of catalogue descriptions: " +
    "research items, publications, videos, podcasts, projects, sections); the related_* lists count what those records share. " +
    "Similar wording, not documented links.",
};
