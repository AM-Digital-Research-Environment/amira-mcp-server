// The matching helpers moved to the core module (src/matching.ts) so the query
// layer no longer imports from the tool layer; re-exported for the tool modules.
export {
  anyContainsCI,
  brief,
  containsCI,
  creditLabel,
  dateStatus,
  equalsCI,
  matchSnippet,
  mediaTypes,
  refLabels,
  refLinks,
} from "../matching.js";
