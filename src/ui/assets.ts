// Build artefacts of the app, injected by scripts/build.mjs as esbuild defines
// (declared in src/globals.d.ts). Kept apart from the view modules so the
// server bundle carries only the finished page, not the code that made it.

/** ui://amira/app.html, complete: CSS inline, script gzip-compressed inside. */
export const APP_HTML: string = __APP_HTML__;

/**
 * The bridge bundle as decoded inside APP_HTML, for the tests (src/lib.ts).
 * Unused by the servers, so esbuild drops it from their bundles.
 */
export const BRIDGE_JS: string = __APP_BRIDGE__;
