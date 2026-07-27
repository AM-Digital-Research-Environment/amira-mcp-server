import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Renamed from __dirname to avoid colliding with the esbuild banner shim that
// injects a top-level `__dirname` for bundled CJS dependencies.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read an env var, treating an UNSUBSTITUTED MCPB template placeholder as unset.
 *
 * `manifest.json` wires settings through `"AMIRA_SITE_BASE": "${user_config.site_base}"`.
 * When an optional setting has no value, the MCPB runtime passes the placeholder
 * through verbatim rather than dropping the variable — so the process really
 * does receive the literal string `${user_config.site_base}`. Taking that as a
 * site base made every citation `${user_config.site_base}/s/amira/item/<id>`:
 * reported in the wild against v1.7.0, and the reason this guard is central
 * rather than a special case in one resolver.
 */
export function isTemplatePlaceholder(raw: string | undefined): boolean {
  const v = raw?.trim();
  // Only a WHOLE-string ${...} counts: a real URL that merely contains braces
  // is a genuine setting, not an unsubstituted template.
  return !v || /^\$\{[^}]*\}$/.test(v);
}

function envValue(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return isTemplatePlaceholder(raw) ? undefined : raw;
}

/**
 * Public base URL of the Omeka S instance (site `amira`). ALL citations point at
 * its item pages, and the optional live refresh reads its public REST API at
 * `<base>/api`. Reads are anonymous — no key, database, or VPN.
 *
 * AMIRA_DASHBOARD_BASE is the pre-1.0 name of this setting; it is honoured with
 * a deprecation warning for one minor version (D12).
 */
function resolveSiteBase(): string {
  const current = envValue("AMIRA_SITE_BASE");
  if (current) return current.replace(/\/+$/, "");
  const legacy = envValue("AMIRA_DASHBOARD_BASE");
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
export const SITE_SLUG = envValue("AMIRA_SITE_SLUG") ?? "amira";

/** Public REST API root. */
export const API_BASE = `${SITE_BASE}/api`;

/**
 * Directory holding the JSON snapshot shipped inside the bundle. The esbuild
 * output lives at <bundle>/server/index.js, so the snapshot is at <bundle>/data.
 * Overridable for local development via AMIRA_DATA_DIR.
 */
function resolveBundledDataDir(): string {
  const raw = envValue("AMIRA_DATA_DIR");
  if (raw) return path.resolve(raw);
  return path.resolve(MODULE_DIR, "..", "data");
}

/**
 * Writable cache directory for snapshots refreshed from the live API. A new
 * location (vs the pre-1.0 ~/.africa-multiple-mcp) because the snapshot schema
 * changed — an old dashboard-shaped cache must never shadow the bundled data.
 */
function resolveCacheDir(): string {
  const raw = envValue("AMIRA_CACHE_DIR");
  if (raw) return path.resolve(raw);
  return path.join(os.homedir(), ".amira-mcp", "cache");
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return fallback;
}

function parseNonNegativeNumber(v: string | undefined, fallback: number): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  siteBase: SITE_BASE,
  siteSlug: SITE_SLUG,
  apiBase: API_BASE,
  bundledDataDir: resolveBundledDataDir(),
  cacheDir: resolveCacheDir(),
  /** When true (default), refresh the snapshot from the public Omeka API. */
  liveRefresh: parseBool(envValue("AMIRA_LIVE_REFRESH"), true),
  /** Periodic freshness check interval. 0 disables periodic checks. */
  refreshIntervalHours: parseNonNegativeNumber(envValue("AMIRA_REFRESH_INTERVAL_HOURS"), 24),
  /** Bind for the remote HTTP transport (server/http.js); ignored by the stdio
   * entry point. PORT/HOST are the conventional names; AMIRA_HTTP_* also work. */
  httpPort: Number(envValue("PORT") ?? envValue("AMIRA_HTTP_PORT") ?? "8787"),
  httpHost: envValue("HOST") ?? envValue("AMIRA_HTTP_HOST") ?? "0.0.0.0",
  /** Per-client requests/minute allowed on /mcp; 0 disables the limiter. A
   * courtesy cap against runaway clients — every query scans the whole
   * in-memory snapshot — not a security control. Put a real one in the proxy. */
  rateLimitPerMinute: parseNonNegativeNumber(envValue("AMIRA_RATE_LIMIT"), 120),
  /** Read the client IP from X-Forwarded-For. Only enable behind a proxy that
   * sets it: a direct client can forge the header and dodge the rate limit. */
  trustProxy: parseBool(envValue("AMIRA_TRUST_PROXY"), false),
};

export type Config = typeof config;
