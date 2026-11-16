// HTTP for the snapshot fetches: bounded retries on transient failures, the
// curator key attached to Omeka requests (and kept out of every message), and
// internal API URLs rewritten to the public site.

import { setTimeout as delay } from "node:timers/promises";
import { config, resolveFetchBase } from "../config.js";
import { omekaKeyFor, redactSecrets, withOmekaKey } from "../access.js";

const USER_AGENT = "amira-mcp-server (https://github.com/AM-Digital-Research-Environment/amira-mcp-server)";

export const sleep = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal });

interface FetchResult<T> {
  body: T;
  total: number;
}

export async function fetchJSON<T>(url: string, signal?: AbortSignal, timeoutMs = 30000): Promise<FetchResult<T>> {
  const internal = internalUrls(url);
  return fetchRetrying(url, async (res) => {
    const body = (await res.json()) as T;
    return { body: internal ? internal(body) : body, total: Number(res.headers.get("omeka-s-total-results") ?? NaN) };
  }, { signal, timeoutMs });
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * When the API is fetched from an internal base (AMIRA_API_BASE, e.g.
 * `http://web/api`), Omeka builds the URLs it returns (`@id`, `o:original_url`,
 * thumbnails) from that request's host. For a response from the fetch base,
 * this returns a rewrite of every such URL to the public site (AMIRA_SITE_BASE),
 * so no internal address reaches a snapshot, a tool result or a link. Null
 * when nothing needs rewriting (the default: fetch base = public API).
 */
function internalUrls(url: string): (<T>(body: T) => T) | null {
  // config.fetchBase is already normalised (src/config.ts), as is every URL built from it.
  const fetchBase = config.fetchBase;
  if (!url.startsWith(`${fetchBase}/`) || fetchBase === resolveFetchBase(null, config.apiBase)) return null;
  const root = fetchBase.endsWith("/api") ? fetchBase.slice(0, -"/api".length) : new URL(fetchBase).origin;
  const pattern = new RegExp(`${escapeRe(root)}(?=[/?#\\s"'<>)]|$)`, "g");
  const rewrite = (v: unknown): unknown => {
    if (typeof v === "string") return v.includes(root) ? v.replace(pattern, config.siteBase) : v;
    if (Array.isArray(v)) return v.map(rewrite);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x)]));
    return v;
  };
  return <T>(body: T) => rewrite(body) as T;
}

/**
 * An error safe to log or rethrow from a keyed request: the message with every
 * trace of the key removed, no `cause` (whose message may quote the URL), and
 * the fields callers branch on (`name`, `status`, `omekaAuth`) kept.
 */
function keySafeError(err: unknown): Error {
  const e = err as { name?: string; message?: string; status?: number; omekaAuth?: boolean };
  const safe = new Error(redactSecrets(String(e?.message ?? err)));
  if (e?.name) safe.name = e.name;
  return Object.assign(safe, e?.status !== undefined ? { status: e.status } : {}, e?.omekaAuth ? { omekaAuth: true } : {});
}

/** GET with bounded retries on transient failures; `read` consumes the body inside the retry.
 *
 * In curator mode a request to the Omeka API carries the service key, added
 * here and only here: `url` (and every message built from it) stays key-free.
 * Such a request never follows a redirect, and its 401/403 is flagged
 * `omekaAuth` so the caller can drop the private data (src/storeLifecycle.ts). */
export async function fetchRetrying<T>(url: string, read: (res: Response) => Promise<T>,
  opts: { signal?: AbortSignal; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const { signal, timeoutMs = 30000 } = opts;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    let retryAfter = 0;
    let keyed = false;
    try {
      const key = omekaKeyFor(url);
      keyed = key !== null;
      const timeout = AbortSignal.timeout(timeoutMs);
      const res = await fetch(key ? withOmekaKey(url, key) : url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { "User-Agent": USER_AGENT, ...opts.headers }, ...(key ? { redirect: "error" as const } : {}) });
      if (!res.ok) {
        const header = res.headers.get("retry-after");
        retryAfter = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
        await res.body?.cancel();
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status },
          keyed && (res.status === 401 || res.status === 403) ? { omekaAuth: true } : {});
      }
      return await read(res);
    } catch (err) {
      signal?.throwIfAborted();
      const status = (err as { status?: number }).status;
      const transient = status ? [408, 429, 500, 502, 503, 504].includes(status)
        : err instanceof TypeError || (err as Error).name === "TimeoutError";
      if (!transient || attempt >= 4) throw keyed ? keySafeError(err) : err;
      await sleep(Math.min(30_000, Math.max(retryAfter || 0, 600 * 2 ** (attempt - 1) + Math.random() * 300)), signal);
    }
  }
}
