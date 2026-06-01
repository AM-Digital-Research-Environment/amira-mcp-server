import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Renamed from __dirname to avoid colliding with the esbuild banner shim that
// injects a top-level `__dirname` for bundled CJS dependencies.
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Public base URL of the amira dashboard. ALL citations and the optional
 * live-refresh fetches point here. It serves static JSON under `/data/*` with
 * no authentication — the MCP server never touches MongoDB directly, so end
 * users need neither a database nor the university VPN.
 */
export const DASHBOARD_BASE =
  process.env.AMIRA_DASHBOARD_BASE?.trim().replace(/\/+$/, "") ||
  "https://amira.africamultiple.uni-bayreuth.de";

/** Where the dashboard publishes its static data snapshot. */
export const DATA_BASE_URL = `${DASHBOARD_BASE}/data`;

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
 * Writable cache directory for data refreshed from the live dashboard. Falls
 * back to the bundled snapshot when empty or unreachable.
 */
function resolveCacheDir(): string {
  const raw = process.env.AMIRA_CACHE_DIR?.trim();
  if (raw && raw.length > 0) return path.resolve(raw);
  return path.join(os.homedir(), ".africa-multiple-mcp", "cache");
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off", ""].includes(s)) return false;
  return fallback;
}

export const config = {
  dashboardBase: DASHBOARD_BASE,
  dataBaseUrl: DATA_BASE_URL,
  bundledDataDir: resolveBundledDataDir(),
  cacheDir: resolveCacheDir(),
  /** When true (default), refresh the snapshot from the public dashboard JSON. */
  liveRefresh: parseBool(process.env.AMIRA_LIVE_REFRESH, true),
};

export type Config = typeof config;
