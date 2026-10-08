// Library entry (bundled to server/lib.js) so the node:test suites exercise the
// EXACT code the server ships — transform, snapshot lifecycle, matching helpers,
// and the fully-registered MCP server (driven in-process via InMemoryTransport).
export * from "./omekaJSON.js";
export * from "./transform.js";
export * from "./types.js";
export { LanguageIndex } from "./languages.js";
export { nameTokens, nameKey, samePerson, nameMatchesQuery, editDistance, nameNearMiss, nearMissNames } from "./names.js";
export { fold, foldCached, foldedIndexOf, clearFoldCache } from "./text.js";
export { ensureStore, currentStore, DataStore } from "./data.js";
export { crawlSnapshot, isStale, loadSnapshot, probeRemote, writeSnapshot, writeSnapshotAtomic } from "./snapshot.js";
export { itemUrl, itemUrlOrNull } from "./urls.js";
export { generateItemCitation } from "./citation.js";
export { createAmiraServer } from "./mcpServer.js";
export { exposureLevel } from "./exposure.js";
export { guidanceEnabled, stripSchemaText } from "./guidance.js";
export { isTemplatePlaceholder, parseAllowedOriginHostnames, config } from "./config.js";

export { publicationBibtex, publicationCitation } from "./publicationCitation.js";
export { BRIDGE_JS } from "./ui/shell.js";
export * from "./snapshotIdentity.js";
export { fetchJSON, readSnapshotPointer } from "./snapshot.js";
export { foldedRanges } from "./text.js";
export * from "./entityGraph.js";
export { selectResearchItems } from "./researchItemQuery.js";
export { INSTRUCTIONS } from "./mcpServer.js";
export { createHttpApp, clientAddress, addressBucket, createRateLimiter } from "./httpApp.js";
export { parseTypedId, canonicalTypedId, stripTypedId } from "./typedIds.js";
export { parseKeyword, keywordMatches, placeAliases, wordPrefixMatch, tokenize } from "./matching.js";
export { placeMatcher, researchFilterError } from "./researchItemQuery.js";
export { foldedMatches } from "./text.js";
export { cleanArgs, ALWAYS_LOAD } from "./tools/policy.js";
export { TOOL_PROFILES, allowedTools } from "./toolProfiles.js";
export { exportUri } from "./resources.js";
export { escBibtex } from "./citation.js";
export { authorityIds } from "./omekaJSON.js";
