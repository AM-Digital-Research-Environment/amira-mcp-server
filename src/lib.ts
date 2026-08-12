// Library entry (bundled to server/lib.js) so the node:test suites exercise the
// EXACT code the server ships — transform, snapshot lifecycle, matching helpers,
// and the fully-registered MCP server (driven in-process via InMemoryTransport).
export * from "./omekaJSON.js";
export * from "./transform.js";
export * from "./types.js";
export { LanguageIndex } from "./languages.js";
export { nameTokens, nameKey, samePerson, nameMatchesQuery } from "./names.js";
export { fold, foldCached, foldedIndexOf, clearFoldCache } from "./text.js";
export { ensureStore, currentStore, DataStore } from "./data.js";
export { crawlSnapshot, isStale, loadSnapshot, probeRemote, writeSnapshot, writeSnapshotAtomic } from "./snapshot.js";
export { itemUrl, itemUrlOrNull } from "./urls.js";
export { generateItemCitation } from "./citation.js";
export { createAmiraServer } from "./mcpServer.js";
export { exposureLevel } from "./exposure.js";
export { isTemplatePlaceholder, parseAllowedOriginHostnames, config } from "./config.js";
