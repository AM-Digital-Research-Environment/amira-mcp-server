import * as fs from "node:fs";
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

export function envValue(name: string): string | undefined {
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

/** Public REST API root: the instance's identity (snapshot manifest, cache
 * partition) and the API named in output. Fetches go to FETCH_BASE. */
export const API_BASE = `${SITE_BASE}/api`;

/**
 * Where the crawl and the refresh fetch the API from (AMIRA_API_BASE, the full
 * API URL including `/api`, e.g. `http://web/api`). Unset, it is API_BASE, as
 * before. A deployment beside Omeka points it at the internal network so that
 * keyed requests never pass a proxy that logs query strings, while every
 * returned link still uses AMIRA_SITE_BASE. An invalid value is kept as given
 * so the entry points can refuse it (src/access.ts).
 */
const API_BASE_SETTING = envValue("AMIRA_API_BASE") ?? null;
export const FETCH_BASE = API_BASE_SETTING ? API_BASE_SETTING.replace(/\/+$/, "") : API_BASE;

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

const LOCAL_ORIGIN_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Hostnames allowed in browser-supplied Origin headers. The MCP Streamable
 * HTTP specification requires servers to validate every present Origin header
 * to prevent DNS rebinding. Non-browser clients normally omit Origin and are
 * unaffected.
 *
 * Accept URLs as well as bare hostnames so deployment configuration can use
 * either `https://chatgpt.com` or `chatgpt.com`. Local origins stay enabled for
 * development. Invalid entries fail closed (they are ignored with a warning),
 * and a wildcard is deliberately not supported.
 */
export function parseAllowedOriginHostnames(raw: string | undefined): string[] {
  const allowed = new Set(LOCAL_ORIGIN_HOSTNAMES);
  for (const entry of raw?.split(",") ?? []) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const url = new URL(value.includes("://") ? value : `http://${value}`);
      if (!url.hostname || value === "*") throw new Error("wildcards are not valid origins");
      allowed.add(url.hostname.toLowerCase());
    } catch {
      console.error(
        `[amira] ignoring invalid AMIRA_ALLOWED_ORIGINS entry ${JSON.stringify(value)}; use a hostname or URL`,
      );
    }
  }
  return [...allowed];
}

/**
 * Optional bearer token for the HTTP transport, read from a mounted secret file
 * (AMIRA_MCP_TOKEN_FILE) or AMIRA_MCP_BEARER_TOKEN. Unset by default: the data
 * is public. Set it when a reverse proxy adds the header, so the container is
 * never reachable unauthenticated even if the proxy is bypassed — the IWAC
 * server's deployment model.
 */
function readBearerToken(): string | undefined {
  const file = envValue("AMIRA_MCP_TOKEN_FILE");
  if (file) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch {
      console.error(`[amira] AMIRA_MCP_TOKEN_FILE ${JSON.stringify(file)} is unreadable; falling back to AMIRA_MCP_BEARER_TOKEN`);
    }
  }
  return envValue("AMIRA_MCP_BEARER_TOKEN");
}

/**
 * Access mode (#26). `public` (default) serves the anonymous snapshot.
 * `curator` crawls the Omeka API with a service key, serves private records and
 * private values to holders of a personal token, and refuses to start unless
 * it is fully configured (src/access.ts). An unknown value is kept as given so
 * the entry points can refuse it; until then the server behaves as public.
 */
const ACCESS_SETTING = envValue("AMIRA_ACCESS")?.toLowerCase() ?? "public";
export const ACCESS: "public" | "curator" = ACCESS_SETTING === "curator" ? "curator" : "public";

/** The hosted curator endpoint the .mcpb relay forwards to by default (#26). */
export const DEFAULT_CURATOR_URL = "https://data.africamultiple.uni-bayreuth.de/curator/mcp";

export const config = {
  siteBase: SITE_BASE,
  siteSlug: SITE_SLUG,
  apiBase: API_BASE,
  /** The API base the crawl and refresh fetch from (AMIRA_API_BASE; default apiBase). */
  fetchBase: FETCH_BASE,
  /** AMIRA_API_BASE as given (null when unset), for the startup check. */
  apiBaseSetting: API_BASE_SETTING,
  bundledDataDir: resolveBundledDataDir(),
  cacheDir: resolveCacheDir(),
  /** When true (default), refresh the snapshot from the public Omeka API. */
  liveRefresh: parseBool(envValue("AMIRA_LIVE_REFRESH"), true),
  /** Periodic freshness check interval. 0 disables periodic checks. Curator mode
   * checks hourly by default: its data stops being served once unverified for
   * longer than `curatorMaxStaleHours`. */
  refreshIntervalHours: parseNonNegativeNumber(envValue("AMIRA_REFRESH_INTERVAL_HOURS"), ACCESS === "curator" ? 1 : 24),
  /** Refresh vocabularies even when item timestamps do not change (minimum one hour). */
  fullRefreshHours: Math.max(1, parseNonNegativeNumber(envValue("AMIRA_FULL_REFRESH_HOURS"), 168)),
  /** Corpus-vector release for semantic neighbours (src/semantic.ts): "latest"
   * (default), "off", or a pinned tag such as semantic-embeddings-v1-35. */
  semanticRelease: envValue("AMIRA_SEMANTIC_RELEASE") ?? "latest",
  /** Test hook: serve the GitHub-hosted enrichments (the full-text map, the
   * corpus-vector releases) from `<base>/raw`, `<base>/api` and
   * `<base>/download` instead of GitHub, so a refresh test stays offline. */
  enrichmentBase: envValue("AMIRA_ENRICHMENT_BASE")?.replace(/\/+$/, "") ?? null,
  /** Bind for the remote HTTP transport (server/http.js); ignored by the stdio
   * entry point. PORT/HOST are the conventional names; AMIRA_HTTP_* also work. */
  httpPort: Number(envValue("PORT") ?? envValue("AMIRA_HTTP_PORT") ?? "8787"),
  httpHost: envValue("HOST") ?? envValue("AMIRA_HTTP_HOST") ?? "127.0.0.1",
  /** Browser Origin hostnames accepted by the Streamable HTTP endpoint. MCP
   * clients without an Origin header are unaffected. */
  allowedOriginHostnames: parseAllowedOriginHostnames(envValue("AMIRA_ALLOWED_ORIGINS")),
  /** Per-client requests/minute allowed on /mcp; 0 disables the limiter. A
   * courtesy cap against runaway clients querying the in-memory snapshot — not a security control. Put a real one in the proxy. */
  rateLimitPerMinute: parseNonNegativeNumber(envValue("AMIRA_RATE_LIMIT"), 120),
  /** Attribute requests to the address a trusted reverse proxy observed
   * (X-Real-IP, else the X-Forwarded-For hop AMIRA_PROXY_HOPS from the right)
   * instead of the socket peer. Enable it behind a proxy — otherwise every
   * request comes from the proxy and all clients share one rate-limit bucket —
   * and never when clients connect directly: they could then forge the header. */
  trustProxy: parseBool(envValue("AMIRA_TRUST_PROXY"), false),
  /** Trusted proxies in front of the server (1 = a single nginx). */
  proxyHops: Math.max(1, Math.floor(parseNonNegativeNumber(envValue("AMIRA_PROXY_HOPS"), 1))),
  /** When set, /mcp and /metrics require `Authorization: Bearer <token>`. */
  bearerToken: readBearerToken(),
  /** `public` or `curator` (AMIRA_ACCESS); see ACCESS. */
  access: ACCESS,
  /** AMIRA_ACCESS as given, so a typo can be refused at startup. */
  accessSetting: ACCESS_SETTING,
  /** Curator mode: file holding the Omeka service key (key_identity, key_credential).
   * Only its path lives here; the key is read by src/access.ts and never copied into config. */
  omekaKeyFile: envValue("AMIRA_OMEKA_KEY_FILE") ?? null,
  /** Curator mode: file of personal tokens, one `name sha256hex` per line. */
  tokensFile: envValue("AMIRA_MCP_TOKENS_FILE") ?? null,
  /** Curator mode: stop serving data not verified against Omeka for this long (hours). */
  curatorMaxStaleHours: parseNonNegativeNumber(envValue("AMIRA_CURATOR_MAX_STALE_HOURS"), 24),
  /** Curator mode: the keyed request that must return a non-empty array before
   * any crawl or refresh, proving the key is accepted and has view-all (Omeka
   * answers an unknown key with anonymous data, not an error). Relative to the API base. */
  curatorAuthProbe: envValue("AMIRA_CURATOR_AUTH_PROBE") ?? "items?is_public=0&per_page=1",
  /** Whether AMIRA_CACHE_DIR was set explicitly (curator mode requires it: point it at tmpfs). */
  cacheDirConfigured: envValue("AMIRA_CACHE_DIR") !== undefined,
  /** Curator relay (stdio only): whether AMIRA_CURATOR_TOKEN is set. Empty, or
   * the unsubstituted `${user_config.curator_token}` of an unset .mcpb setting,
   * means public mode. The token is read by src/relay.ts and never copied here. */
  curatorRelay: envValue("AMIRA_CURATOR_TOKEN") !== undefined,
  /** Curator relay: the curator endpoint it forwards to (AMIRA_CURATOR_URL). */
  curatorUrl: envValue("AMIRA_CURATOR_URL") ?? DEFAULT_CURATOR_URL,
  /** Whether a single shared bearer token is configured (refused in curator mode). */
  bearerTokenConfigured: envValue("AMIRA_MCP_TOKEN_FILE") !== undefined || envValue("AMIRA_MCP_BEARER_TOKEN") !== undefined,
};

export type Config = typeof config;
