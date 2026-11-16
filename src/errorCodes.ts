// The machine tokens of a structured tool error (`{ error: { code, … } }`,
// src/tools/responses.ts errorResult). Clients branch on them, so the set is
// closed: a new code is added here, where a typo cannot slip through. The query
// cores (src/researchItemQuery.ts, src/publicationQuery.ts) use it too, without
// importing the tools layer.
export type ErrorCode =
  | "ambiguous_entity"
  | "deadline_exceeded"
  | "export_too_large"
  | "exposure_restricted"
  | "fulltext_map_unavailable"
  | "invalid_argument"
  | "invalid_category"
  | "invalid_date"
  | "invalid_id"
  | "invalid_range"
  | "missing_entity"
  | "no_neighbours"
  | "not_embedded"
  | "not_found"
  | "not_on_fulltext_map"
  | "not_on_map"
  | "semantic_unavailable"
  | "snapshot_changed"
  | "snapshot_unavailable"
  | "text_access_disabled";

/** The `invalid_range` message for a `year_from` after `year_to`. */
export const INVALID_YEAR_RANGE = "`year_from` must be less than or equal to `year_to`.";
