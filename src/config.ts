import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Renamed from __dirname to avoid colliding with the esbuild banner shim that
// injects a top-level `__dirname` for bundled CJS dependencies.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Public base URL of the Omeka S instance (site `amira`). ALL citations point at
 * its item pages, and the optional live refresh reads its public REST API at
 * `<base>/api`. Reads are anonymous — no key, database, or VPN.
 *
 * AMIRA_DASHBOARD_BASE is the pre-1.0 name of this setting; it is honoured with
 * a deprecation warning for one minor version (D12).
 */
function resolveSiteBase(): string {
  const current = process.env.AMIRA_SITE_BASE?.trim();
  if (current) return current.replace(/\/+$/, "");
  const legacy = process.env.AMIRA_DASHBOARD_BASE?.trim();
  if (legacy) {
    console.error(
      "[amira] AMIRA_DASHBOARD_BASE is deprecated (the server now targets the Omeka S site); use AMIRA_SITE_BASE.",
    );
    return legacy.replace(/\/+$/, "");
  }
  return "https://data.africamultiple.uni-bayreuth.de";
}

export const SITE_BASE = resolveSiteBase();

/** Omeka S site slug — item pages live at `<base>/s/<slug>/item/<o:id>`. */
export const SITE_SLUG = process.env.AMIRA_SITE_SLUG?.trim() || "amira";

/** Public REST API root. */
export const API_BASE = `${SITE_BASE}/api`;

/**
 * Directory holding the JSON snapshot shipped inside the bundle. The esbuild
 * output lives at <bundle>/server/index.js, so the snapshot is at <bundle>/data.
 * Overridable for local development via AMIRA_DATA_DIR.
 */
function resolveBundledDataDir(): string {
  const raw = process.env.AMIRA_DATA_DIR?.trim();
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.resolve(MODULE_DIR, "..", "data");
}

/**
 * Writable cache directory for snapshots refreshed from the live API. A new
 * location (vs the pre-1.0 ~/.africa-multiple-mcp) because the snapshot schema
 * changed — an old dashboard-shaped cache must never shadow the bundled data.
 */
function resolveCacheDir(): string {
  const raw = process.env.AMIRA_CACHE_DIR?.trim();
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.join(os.homedir(), ".amira-mcp", "cache");
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return fallback;
}

export const config = {
  siteBase: SITE_BASE,
  siteSlug: SITE_SLUG,
  apiBase: API_BASE,
  bundledDataDir: resolveBundledDataDir(),
  cacheDir: resolveCacheDir(),
  /** When true (default), refresh the snapshot from the public Omeka API. */
  liveRefresh: parseBool(process.env.AMIRA_LIVE_REFRESH, true),
};

export type Config = typeof config;
