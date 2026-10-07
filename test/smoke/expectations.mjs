// Floors the smoke tests (test/smoke/stdio.mjs, test/smoke/http.mjs) assert
// against the REAL snapshot in data/ — the bundled one locally, a fresh
// `npm run fetch-data` crawl in CI. They are lower bounds, not exact counts:
// a routine data refresh must not red the build, but a snapshot that lost a
// corpus must. One constant per corpus, shared by both transports, so the two
// smoke tests can never disagree about what "the full snapshot" means again.
export const MIN_RESEARCH_ITEMS = 3975; // v0.2.0 parity
export const MIN_PUBLICATIONS = 240;
export const MIN_JOURNALS = 50;

let failures = 0;

/** Record one smoke check; a failure is printed and counted, never thrown. */
export function check(cond, label) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

/** Number of failed checks so far. */
export const failureCount = () => failures;

/**
 * Compare a listed tool surface with the expected names (derived from
 * manifest.json, never a hard-coded count) and describe any difference.
 */
export function checkToolSurface(names, expected, label) {
  const missing = expected.filter((name) => !names.includes(name));
  const unexpected = names.filter((name) => !expected.includes(name));
  check(
    names.length === expected.length && !missing.length && !unexpected.length,
    `${label}: expected ${expected.length} tools, got ${names.length}` +
      (missing.length ? `; missing ${missing.join(", ")}` : "") +
      (unexpected.length ? `; unexpected ${unexpected.join(", ")}` : ""),
  );
}
