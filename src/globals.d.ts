/** Injected by esbuild `define` from package.json (single-sourced version). */
declare const __SERVER_VERSION__: string;

/**
 * Injected by esbuild `define` from scripts/skills.mjs — the files of every
 * valid SEP-2640 skill, `{ text, base64 }` by path, JSON-encoded. Both maps are
 * empty when the build found no skills.
 */
declare const __SKILLS_SNAPSHOT__: string;

/** The one MCP App page, ui://amira/app.html (scripts/build.mjs, src/ui/page.ts). */
declare const __APP_HTML__: string;

/** The bridge bundle decoded inside that page; the test library exports it. */
declare const __APP_BRIDGE__: string;
