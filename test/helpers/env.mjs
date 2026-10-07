// Hermetic environment for the test suites, the smoke tests and the
// measurement scripts (weigh, benchmark, preview-apps).
//
// The server reads its configuration from the environment ONCE, at module
// load (src/config.ts). Anything the shell exported therefore leaks into
// every test that imports server/lib.js: AMIRA_EXPOSURE, AMIRA_TOOL_PROFILE,
// AMIRA_SKILLS, AMIRA_SITE_* all change results, and a missing
// AMIRA_CACHE_DIR lets ~/.amira-mcp/cache (whatever the last live run left
// there) outrank the snapshot under test. So:
//
//   1. call hermeticEnv() BEFORE importing server/lib.js (use a dynamic
//      `await import(...)`, never a static import, in that file);
//   2. spawn children with childEnv(), never `{ ...process.env }`;
//   3. create temp dirs with tempDir(), which removes them on exit.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute repository root, independent of the caller's cwd. */
export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
/** The stdio entry point the .mcpb runs (manifest `server.entry_point`). */
export const SERVER_STDIO = path.join(REPO_ROOT, "server", "index.js");
/** The Streamable HTTP entry point (container / remote connector). */
export const SERVER_HTTP = path.join(REPO_ROOT, "server", "http.js");
/** The test library bundle, as an import specifier usable from anywhere. */
export const LIB_URL = new URL("../../server/lib.js", import.meta.url).href;

// --- temp directories --------------------------------------------------------

const registered = new Set();
let hooked = false;

/** Remove every temp dir created so far. Runs automatically on process exit. */
export function removeTempDirs() {
  for (const dir of registered) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Best effort: on Windows a handle a dying child still holds can block
      // removal. Never let cleanup turn a passing run into a failing one.
    }
  }
  registered.clear();
}

/**
 * Create a fresh `amira-<label>-XXXXXX` directory under the OS temp dir and
 * register it for removal when the process exits (node --test runs each file
 * in its own process, so this is per test file).
 */
export function tempDir(label = "tmp") {
  if (!hooked) {
    process.once("exit", removeTempDirs);
    hooked = true;
  }
  const dir = mkdtempSync(path.join(tmpdir(), `amira-${label}-`));
  registered.add(dir);
  return dir;
}

// --- environment ---------------------------------------------------------------

/** Server-reading variables: every AMIRA_* plus the conventional PORT/HOST.
 * Windows env names are case-insensitive, so compare upper-cased. */
const isServerVar = (key) => {
  const k = key.toUpperCase();
  return k.startsWith("AMIRA_") || k === "PORT" || k === "HOST";
};

/** A copy of `source` without any server-reading variable. */
export function sanitizedEnv(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (!isServerVar(key) && value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Make THIS process hermetic before server/lib.js is imported:
 *  - deletes every AMIRA_* variable plus PORT and HOST;
 *  - sets AMIRA_LIVE_REFRESH=0 (never crawl) and AMIRA_CACHE_DIR to a fresh
 *    temp dir (never read or write ~/.amira-mcp/cache);
 *  - with `dataDir: true`, points AMIRA_DATA_DIR at a fresh EMPTY dir for a
 *    fixture snapshot; with `dataDir: "absent"`, at a path that does not exist
 *    yet (inside a registered temp dir). Without it, AMIRA_DATA_DIR is unset
 *    and the server reads the repo's bundled data/ snapshot.
 *
 * Variables a test needs (AMIRA_EXPOSURE, AMIRA_SITE_BASE, ...) are set AFTER
 * this call. Returns `{ cacheDir, dataDir }` (dataDir undefined when unset).
 */
export function hermeticEnv({ dataDir = false } = {}) {
  for (const key of Object.keys(process.env)) {
    if (isServerVar(key)) delete process.env[key];
  }
  const cacheDir = tempDir("cache");
  process.env.AMIRA_LIVE_REFRESH = "0";
  process.env.AMIRA_CACHE_DIR = cacheDir;
  let data;
  if (dataDir === true) data = tempDir("data");
  else if (dataDir === "absent") data = path.join(tempDir("data"), "data");
  else if (dataDir !== false) throw new TypeError(`hermeticEnv: dataDir must be true, "absent" or false`);
  if (data) process.env.AMIRA_DATA_DIR = data;
  return { cacheDir, dataDir: data };
}

/**
 * Environment for a spawned server child: the parent's env minus every
 * AMIRA_* variable and PORT/HOST, plus AMIRA_LIVE_REFRESH=0 and a fresh temp
 * AMIRA_CACHE_DIR, then `extra` (which may override either). Pass
 * AMIRA_DATA_DIR in `extra` to serve a fixture; leave it out to serve the
 * bundled data/ snapshot.
 */
export function childEnv(extra = {}) {
  return {
    ...sanitizedEnv(),
    AMIRA_LIVE_REFRESH: "0",
    AMIRA_CACHE_DIR: tempDir("child-cache"),
    ...extra,
  };
}
