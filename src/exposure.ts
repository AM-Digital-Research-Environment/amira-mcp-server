// Metadata-exposure levels for benchmark experiments (AMIRA_EXPOSURE).
//
// The server can restrict WHICH metadata the model sees, so the same tasks can
// be run under graded visibility conditions (the RQ5 "metadata mediation"
// design in BENCHMARK_EVALUATION_PLAN.md). This is an experiment flag, not an
// end-user setting: it defaults to "full" and is read from the environment on
// every call, so a test harness can flip it between calls.
//
//   minimal      title, type, dates/years, URLs, media flags. Keyword search
//                matches titles only. Entity/facet/relation tools and
//                structured filters are refused with a structured error.
//   descriptive  + description, abstract, table of contents, citation text
//                (keyword search reaches them too).
//   structured   + subjects, places, people/contributors, projects, sections,
//                collections, venues — all filters and entity tools work.
//   full         + transcripts and publication full text (the default).
//
// Existence flags (has_transcript / has_fulltext) stay visible at every level;
// only the CONTENT is gated — a model should be able to say "there is a
// transcript but access to it is disabled".

export type ExposureLevel = "minimal" | "descriptive" | "structured" | "full";

const LEVELS: ExposureLevel[] = ["minimal", "descriptive", "structured", "full"];

export function exposureLevel(): ExposureLevel {
  const raw = process.env.AMIRA_EXPOSURE?.trim().toLowerCase();
  return (LEVELS as string[]).includes(raw ?? "") ? (raw as ExposureLevel) : "full";
}

const rank = (l: ExposureLevel): number => LEVELS.indexOf(l);

/** Description/abstract/TOC text is visible (descriptive and up). */
export const allowDescriptive = (): boolean => rank(exposureLevel()) >= rank("descriptive");

/** Subjects/places/people/projects/venues are visible (structured and up). */
export const allowStructured = (): boolean => rank(exposureLevel()) >= rank("structured");

/** Transcripts and publication full text are visible (full only). */
export const allowFullText = (): boolean => exposureLevel() === "full";

/** Human-readable reason for a refusal under the current level. */
export function exposureMessage(needs: "descriptive" | "structured" | "full"): string {
  return (
    `The server is running with AMIRA_EXPOSURE=${exposureLevel()}, which hides this metadata ` +
    `(requires the '${needs}' level). Answer from the metadata that remains exposed, or state that ` +
    `the available tools do not expose what the question needs.`
  );
}
