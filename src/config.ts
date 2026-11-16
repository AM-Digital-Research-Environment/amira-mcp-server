import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bool, envValue, nonNegative, type Env } from "./env.js";
import { normalizeApiBase } from "./snapshotIdentity.js";

// The readers live in src/env.ts; re-exported for the importers of this module.
export { envValue, isTemplatePlaceholder } from "./env.js";

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
function resolveSiteBase(env: Env): string {
  const current = envValue("AMIRA_SITE_BASE", env);
  if (current) return current.replace(/\/+$/, "");
  const legacy = envValue("AMIRA_DASHBOARD_BASE", env);
  if (legacy) {
    console.error(
      "[amira] AMIRA_DASHBOARD_BASE is deprecated (the server now targets the Omeka S site); use AMIRA_SITE_BASE.",
    );
    return legacy.replace(/\/+$/, "");
  }
  return "https://data.africamultiple.uni-bayreuth.de";
}

/**
 * The fetch base in its one canonical spelling (lower-case host, no default
 * port, no trailing slash), so every request URL built from it and every
 * prefix compared against it agree: `http://WEB:80/api/` and `http://web/api`
 * are the same base. Built once here and used everywhere (the key is attached
 * only to URLs under it, src/access.ts). A value that cannot be parsed is kept
 * as given, minus trailing slashes, so the entry points can refuse it.
 */
export function resolveFetchBase(setting: string | null, apiBase: string): string {
  const raw = (setting ?? apiBase).replace(/\/+$/, "");
  try {
    return normalizeApiBase(raw);
  } catch {
    return raw;
  }
}

/**
 * Directory holding the JSON snapshot shipped inside the bundle. The esbuild
 * output lives at <bundle>/server/index.js, so the snapshot is at <bundle>/data.
 * Overridable for local development via AMIRA_DATA_DIR.
 */
function resolveBundledDataDir(env: Env): string {
  const raw = envValue("AMIRA_DATA_DIR", env);
  if (raw) return path.resolve(raw);
  return path.resolve(MODULE_DIR, "..", "data");
}

/**
 * Writable cache directory for snapshots refreshed from the live API. A new
 * location (vs the pre-1.0 ~/.africa-multiple-mcp) because the snapshot schema
 * changed — an old dashboard-shaped cache must never shadow the bundled data.
 */
function resolveCacheDir(env: Env): string {
  const raw = envValue("AMIRA_CACHE_DIR", env);
  if (raw) return path.resolve(raw);
  // A default, not a setting: the Docker image points it at /tmp/amira-cache.
  // Curator mode does not count it as AMIRA_CACHE_DIR set explicitly, so a
  // curator container started without its tmpfs cache refuses to start.
  const imageDefault = envValue("AMIRA_DEFAULT_CACHE_DIR", env);
  if (imageDefault) return path.resolve(imageDefault);
  return path.join(os.homedir(), ".amira-mcp", "cache");
}

/** A TCP port (0 = any free port), or null when `raw` is not one. */
export function parsePort(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n <= 65535 ? n : null;
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
function readBearerToken(env: Env): string | undefined {
  const file = envValue("AMIRA_MCP_TOKEN_FILE", env);
  if (file) {
    try {
      const token = fs.readFileSync(file, "utf8").trim();
      if (token) return token;
    } catch {
      console.error(`[amira] AMIRA_MCP_TOKEN_FILE ${JSON.stringify(file)} is unreadable; falling back to AMIRA_MCP_BEARER_TOKEN`);
    }
  }
  return envValue("AMIRA_MCP_BEARER_TOKEN", env);
}

/** The hosted curator endpoint the .mcpb relay forwards to by default (#26). */
export const DEFAULT_CURATOR_URL = "https://data.africamultiple.uni-bayreuth.de/curator/mcp";

/**
 * The configuration `env` describes. The server reads it once, from
 * process.env, at import (`config` below); tests may build others in-process.
 */
export function loadConfig(env: Env) {
  const siteBase = resolveSiteBase(env);
  /** Omeka S site slug — item pages live at `<base>/s/<slug>/item/<o:id>`. */
  const siteSlug = envValue("AMIRA_SITE_SLUG", env) ?? "amira";
  /** Public REST API root: the instance's identity (snapshot manifest, cache
   * partition) and the API named in output. Fetches go to the fetch base. */
  const apiBase = `${siteBase}/api`;
  /**
   * Where the crawl and the refresh fetch the API from (AMIRA_API_BASE, the full
   * API URL including `/api`, e.g. `http://web/api`). Unset, it is the API base, as
   * before. A deployment beside Omeka points it at the internal network so that
   * keyed requests never pass a proxy that logs query strings, while every
   * returned link still uses AMIRA_SITE_BASE. An invalid value is kept as given
   * so the entry points can refuse it (src/access.ts).
   */
  const apiBaseSetting = envValue("AMIRA_API_BASE", env) ?? null;
  const httpPortSetting = envValue("PORT", env) ?? envValue("AMIRA_HTTP_PORT", env) ?? "8787";
  /**
   * Access mode (#26). `public` (default) serves the anonymous snapshot.
   * `curator` crawls the Omeka API with a service key, serves private records and
   * private values to holders of a personal token, and refuses to start unless
   * it is fully configured (src/access.ts). An unknown value is kept as given so
   * the entry points can refuse it; until then the server behaves as public.
   */
  const accessSetting = envValue("AMIRA_ACCESS", env)?.toLowerCase() ?? "public";
  const access: "public" | "curator" = accessSetting === "curator" ? "curator" : "public";

  return {
    siteBase,
    siteSlug,
    apiBase,
    /** The API base the crawl and refresh fetch from (AMIRA_API_BASE; default apiBase). */
    fetchBase: resolveFetchBase(apiBaseSetting, apiBase),
    /** AMIRA_API_BASE as given (null when unset), for the startup check. */
    apiBaseSetting,
    bundledDataDir: resolveBundledDataDir(env),
    cacheDir: resolveCacheDir(env),
    /** When true (default), refresh the snapshot from the public Omeka API. */
    liveRefresh: bool("AMIRA_LIVE_REFRESH", true, env),
    /** Periodic freshness check interval. 0 disables periodic checks. Curator mode
     * checks hourly by default: its data stops being served once unverified for
     * longer than `curatorMaxStaleHours`. */
    refreshIntervalHours: nonNegative("AMIRA_REFRESH_INTERVAL_HOURS", access === "curator" ? 1 : 24, env),
    /** Refresh vocabularies even when item timestamps do not change (minimum one hour). */
    fullRefreshHours: Math.max(1, nonNegative("AMIRA_FULL_REFRESH_HOURS", 168, env)),
    /** Corpus-vector release for semantic neighbours (src/semantic.ts): "latest"
     * (default), "off", or a pinned tag such as semantic-embeddings-v1-35. */
    semanticRelease: envValue("AMIRA_SEMANTIC_RELEASE", env) ?? "latest",
    /** Test hook: serve the GitHub-hosted enrichments (the full-text map, the
     * corpus-vector releases) from `<base>/raw`, `<base>/api` and
     * `<base>/download` instead of GitHub, so a refresh test stays offline. */
    enrichmentBase: envValue("AMIRA_ENRICHMENT_BASE", env)?.replace(/\/+$/, "") ?? null,
    /** Bind for the remote HTTP transport (server/http.js); ignored by the stdio
     * entry point. PORT/HOST are the conventional names; AMIRA_HTTP_* also work. */
    httpPort: parsePort(httpPortSetting) ?? Number.NaN,
    /** PORT / AMIRA_HTTP_PORT as given, so an invalid port can be refused at startup (src/access.ts). */
    httpPortSetting,
    httpHost: envValue("HOST", env) ?? envValue("AMIRA_HTTP_HOST", env) ?? "127.0.0.1",
    /** Browser Origin hostnames accepted by the Streamable HTTP endpoint. MCP
     * clients without an Origin header are unaffected. */
    allowedOriginHostnames: parseAllowedOriginHostnames(envValue("AMIRA_ALLOWED_ORIGINS", env)),
    /** Per-client requests/minute allowed on /mcp; 0 disables the limiter. A
     * courtesy cap against runaway clients querying the in-memory snapshot — not a security control. Put a real one in the proxy. */
    rateLimitPerMinute: nonNegative("AMIRA_RATE_LIMIT", 120, env),
    /** Attribute requests to the address a trusted reverse proxy observed
     * (X-Real-IP, else the X-Forwarded-For hop AMIRA_PROXY_HOPS from the right)
     * instead of the socket peer. Enable it behind a proxy — otherwise every
     * request comes from the proxy and all clients share one rate-limit bucket —
     * and never when clients connect directly: they could then forge the header. */
    trustProxy: bool("AMIRA_TRUST_PROXY", false, env),
    /** Trusted proxies in front of the server (1 = a single nginx). */
    proxyHops: Math.max(1, Math.floor(nonNegative("AMIRA_PROXY_HOPS", 1, env))),
    /** When set, /mcp and /metrics require `Authorization: Bearer <token>`. */
    bearerToken: readBearerToken(env),
    /** `public` or `curator` (AMIRA_ACCESS); see `access` above. */
    access,
    /** AMIRA_ACCESS as given, so a typo can be refused at startup. */
    accessSetting,
    /** Curator mode: file holding the Omeka service key (key_identity, key_credential).
     * Only its path lives here; the key is read by src/access.ts and never copied into config. */
    omekaKeyFile: envValue("AMIRA_OMEKA_KEY_FILE", env) ?? null,
    /** Curator mode: file of personal tokens, one `name sha256hex` per line. */
    tokensFile: envValue("AMIRA_MCP_TOKENS_FILE", env) ?? null,
    /** Curator mode: stop serving data not verified against Omeka for this long (hours). */
    curatorMaxStaleHours: nonNegative("AMIRA_CURATOR_MAX_STALE_HOURS", 24, env),
    /** Curator mode: first retry delay (seconds) after a transient failure leaves no data; it
     * doubles up to 5 minutes. Default 60; tests shorten it. */
    curatorRetrySeconds: Math.max(0.1, nonNegative("AMIRA_CURATOR_RETRY_SECONDS", 60, env)),
    /** Curator mode: the keyed request that must return a non-empty array before
     * any crawl or refresh, proving the key is accepted and has view-all (Omeka
     * answers an unknown key with anonymous data, not an error). Relative to the API base. */
    curatorAuthProbe: envValue("AMIRA_CURATOR_AUTH_PROBE", env) ?? "items?is_public=0&per_page=1",
    /** Whether AMIRA_CACHE_DIR was set explicitly (curator mode requires it: point it at tmpfs).
     * AMIRA_DEFAULT_CACHE_DIR (the Docker image's /tmp/amira-cache) does not count. */
    cacheDirConfigured: envValue("AMIRA_CACHE_DIR", env) !== undefined,
    /** Curator relay: answer a forwarded request with a relay error when the curator server has not
     * answered it within this many seconds (AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS, default 300). */
    curatorRelayTimeoutSeconds: Math.max(1, nonNegative("AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS", 300, env)),
    /** Curator relay (stdio only): whether AMIRA_CURATOR_TOKEN is set. Empty, or
     * the unsubstituted `${user_config.curator_token}` of an unset .mcpb setting,
     * means public mode. The token is read by src/relay.ts and never copied here. */
    curatorRelay: envValue("AMIRA_CURATOR_TOKEN", env) !== undefined,
    /** Curator relay: the curator endpoint it forwards to (AMIRA_CURATOR_URL). */
    curatorUrl: envValue("AMIRA_CURATOR_URL", env) ?? DEFAULT_CURATOR_URL,
    /** Whether a single shared bearer token is configured (refused in curator mode). */
    bearerTokenConfigured: envValue("AMIRA_MCP_TOKEN_FILE", env) !== undefined || envValue("AMIRA_MCP_BEARER_TOKEN", env) !== undefined,
  };
}

export type Config = ReturnType<typeof loadConfig>;

export const config: Config = loadConfig(process.env);

export const SITE_BASE = config.siteBase;
export const SITE_SLUG = config.siteSlug;
export const API_BASE = config.apiBase;
export const FETCH_BASE = config.fetchBase;
export const ACCESS = config.access;
