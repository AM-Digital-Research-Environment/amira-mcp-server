// Library entry (bundled to server/lib.js) so the node:test suites exercise the
// EXACT code the server ships — transform, snapshot lifecycle, matching helpers,
// and the fully-registered MCP server (driven in-process via InMemoryTransport).
export * from "./omekaJSON.js";
export * from "./transform.js";
export * from "./types.js";
export { LanguageIndex } from "./languages.js";
export { samePerson, nameMatchesQuery, editDistance, nearMissNames } from "./names.js";
export { fold, foldCached, foldedIndexOf } from "./text.js";
export { ensureStore, currentStore, chooseInitial, DataStore, withStore } from "./data.js";
export { warmIndexes } from "./warm.js";
export {
  carryEnrichments, crawlSnapshot, fetchJSON, fetchSemanticRelease, isStale, loadSnapshot, probeCuratorAuth, probeRemote, readFingerprints, readManifest,
  readSnapshotPointer, snapshotFingerprints, writeSnapshot, writeSnapshotAtomic,
} from "./snapshot.js";
export { itemUrl, itemUrlOrNull } from "./urls.js";
export { generateItemCitation } from "./citation.js";
export { createAmiraServer } from "./mcpServer.js";
export { loadSkillCatalog, loadSkillsExtension, skillUriKey } from "./skills.js";
export { exposureLevel } from "./exposure.js";
export { guidanceEnabled, stripSchemaText } from "./guidance.js";
export { isTemplatePlaceholder, loadConfig, parseAllowedOriginHostnames, config } from "./config.js";
export { bool, enumOf, envValue, nonNegative } from "./env.js";
export { publicationBibtex, publicationCitation } from "./publicationCitation.js";
export { BRIDGE_JS } from "./ui/assets.js";
export { ContextSync } from "./ui/contextSync.js";
export { SELECTION_LIMITS, askText, buildSelectionContext, selectionText } from "./ui/selectionContext.js";
export { scopeCss } from "./ui/shell.js";
export { APP_TOOLS, APP_URI, RESTORABLE_TOOLS, VIEW_OF_TOOL } from "./ui/viewContract.js";
export { CAPTURE_DEFAULT_DIMENSION, CAPTURE_MAX_DIMENSION, CAPTURE_MIN_DIMENSION, CAPTURE_TARGETS, MAX_PNG_BYTES, captureSize, standaloneSvg } from "./ui/capture.js";
export { SNAPSHOT_META, VIEW_STATE_MAX_CHARS, VIEW_STATE_MAX_ENTRIES, VIEW_STATE_VERSION, VIEW_UUID_META, ViewStore, instanceKey, snapshotOf } from "./ui/viewState.js";
export { registerAppResources } from "./tools/apps.js";
export * from "./snapshotIdentity.js";
export * from "./entityGraph.js";
export { selectResearchItems } from "./researchItemQuery.js";
export { INSTRUCTIONS, curatorInstructions } from "./mcpServer.js";
export { createHttpApp, clientAddress, addressBucket, createRateLimiter } from "./httpApp.js";
export { parseTypedId, canonicalTypedId, stripTypedId } from "./typedIds.js";
export { RECORD_KINDS, findRecord, recordByOId, recordTitle } from "./recordKinds.js";
export { parseKeyword, keywordMatches, placeAliases, wordPrefixMatch, tokenize, RefTally, refKey } from "./matching.js";
export { closestValues, keywordPredicate, literalPhrase, matchSnippet } from "./matching.js";
export { placeMatcher, researchFilterError } from "./researchItemQuery.js";
export { foldedMatches } from "./text.js";
export { cleanArgs } from "./tools/policy.js";
export { TOOL_PROFILES, allowedTools } from "./toolProfiles.js";
export { PROMPT_TOOLS } from "./prompts.js";
export { exportUri, recordError } from "./resources.js";
export { escBibtex } from "./citation.js";
export { scrub } from "./tools/responses.js";
export { describeMarkdown } from "./skills.js";
export { FULLTEXT_SOURCE, parseFulltextMaps, fulltextIndex, wordTrends } from "./fulltextMaps.js";
export {
  NEIGHBOURS_PER_TYPE, SEMANTIC_SOURCE, computeNeighbours, parseSemanticNeighbours, pickSemantic, semanticIndex, servableSemantic, storedScore,
  verifySemanticRelease,
} from "./semantic.js";
// Curator mode (#26).
export {
  accessConfigErrors, createTokenStore, generateToken, hashToken, omekaKeyFor, parseOmekaKey, parseTokensFile, redactSecrets,
  resetOmekaKeyCache, withOmekaKey,
} from "./access.js";
export { publicView, splitVisibility, PRIVATE_CITATION_NOTE, RESTRICTED_NOTE } from "./visibility.js";
export { publicNamesakeOf } from "./namesakes.js";
export { cacheSnapshotDir, refreshNow, refreshStatus } from "./data.js";
export { adminItemUrl, adminItemSetUrl } from "./urls.js";
// Curator presentation: the decoration step, for direct tests of URL forms.
export { adminMediaUrl } from "./urls.js";
export { PAGE_CHAR_BUDGET } from "./tools/pagination.js";
export { curatorText, curatorToolResult, curatorValue, PRIVATE_KEYWORD_NOTE, PRIVATE_PUBLICATION_KEYWORD_NOTE, RESTRICTED_MATCH_NOTE } from "./tools/curator.js";
export { PRIVATE_NOT_EMBEDDED, semanticCoverage } from "./semantic.js";
export { noNeighboursReason } from "./tools/similar.js";
export { neighboursNote } from "./fulltextMaps.js";
// Curator relay (#26): the .mcpb's stdio-to-curator forwarder.
export { curatorUrlError } from "./access.js";
export { describeRelayError, normalizeCuratorToken, redactToken, startRelay, truncateForLog } from "./relay.js";
// Curator lifecycle and hardening.
export {
  accessConfigWarnings, cacheDirFilesystem, describeTokens, filesystemOf, IMAGE_CACHE_DIR, KEY_TTL_MS, MAX_TOKEN_LENGTH, MIN_TOKEN_LENGTH,
  omekaKey,
} from "./access.js";
export { parsePort, resolveFetchBase } from "./config.js";
export { stopBackgroundRefresh } from "./data.js";
export { AUTH_FAILURES_PER_MINUTE } from "./httpApp.js";
