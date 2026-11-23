// Which snapshot the process serves, and when it is replaced.
//
// Two data planes, offline-first (issue #1 D2):
//   1. A snapshot BUNDLED in the .mcpb — the server is fully usable from it
//      alone, with no network access.
//   2. With live refresh on (default), a one-request probe checks the public
//      Omeka API at startup and periodically; only when stale does a full
//      re-crawl run, staged + atomically promoted into the cache (D9), then
//      hot-swapped into memory.
//
// Whichever of {bundled, cache} carries the NEWER manifest wins at startup, so
// an old cache can never shadow a fresher bundled snapshot or vice versa.
//
// The store itself (records and indexes) is src/store.ts.

import { config } from "./config.js";
import { pickSemantic, semanticManifestEntry, servableSemantic, type SemanticNeighbours } from "./semantic.js";
import {
  carryEnrichments, crawlSnapshot, isStale, KEY_NOT_ACCEPTED, loadSnapshot, probeCuratorAuth, probeRemote, writeSnapshotAtomic, type CrawlOutput,
} from "./snapshot.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { setFoldCacheProvider } from "./text.js";
import * as path from "node:path";
import fs from "node:fs/promises";
import { assertSnapshotSource, snapshotCacheDir } from "./snapshotIdentity.js";
import { publicView } from "./visibility.js";
import { omekaKey, redactSecrets } from "./access.js";
import { DataStore } from "./store.js";
import type { SnapshotManifest } from "./types.js";
import { warmIndexes } from "./warm.js";

// -----------------------------------------------------------------------------
// Singleton + background refresh
// -----------------------------------------------------------------------------

let current: DataStore | null = null;

/** The store a tool call is serving, for the length of the call (src/tools/policy.ts). */
const storeScope = new AsyncLocalStorage<DataStore>();
/** Run `fn` against `store`: its fold caches, even after a refresh swaps `current`. */
export function withStore<T>(store: DataStore, fn: () => T): T {
  return storeScope.run(store, fn);
}
/** The store `withStore` bound for the running call, or undefined outside one. */
export function scopedStore(): DataStore | undefined {
  return storeScope.getStore();
}
setFoldCacheProvider(() => (storeScope.getStore() ?? current)?.folds);
let loading: Promise<DataStore> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshController: AbortController | null = null;
let stopped = false;
/** Aborted on shutdown: what the initial load awaits outside a refresh (the curator key probe) honours it. */
const lifecycle = new AbortController();
const refreshState = { last_attempt: null as string | null, last_success: null as string | null,
  error_class: null as string | null, in_flight: false };
export function refreshStatus() {
  return {
    ...refreshState,
    enabled: config.liveRefresh,
    ...(config.access === "curator"
      ? { data_verified_at: curator.verifiedAt ? new Date(curator.verifiedAt).toISOString() : null, blocked: curator.blocked }
      : {}),
  };
}
/**
 * Stop refreshing for good (shutdown): clear the timers, abort the refresh or
 * crawl in flight (every crawl runs as a background refresh, see
 * `loadInitialCurator`), and wait for it and for an initial load to settle, so
 * nothing is left writing to the cache (a `writer.lock`) when the process exits.
 */
export async function stopBackgroundRefresh(): Promise<void> {
  stopped = true;
  lifecycle.abort();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
  if (curator.retryTimer) clearTimeout(curator.retryTimer);
  curator.retryTimer = null;
  refreshController?.abort();
  await refreshInFlight;
  await loading?.catch(() => {});
}

export function cacheSnapshotDir(): string {
  return snapshotCacheDir(config.cacheDir, config.apiBase, config.access);
}

// --- curator mode (#26) ---------------------------------------------------------
//
// Curator data is served only while it is known to be current and the service
// key is accepted:
//   - it never comes from the bundled snapshot, only from the curator cache
//     partition (AMIRA_CACHE_DIR, on tmpfs) or a fresh authenticated crawl;
//   - `verifiedAt` records when Omeka last confirmed it (a crawl, or a probe
//     that found nothing newer), and is persisted beside the cached snapshot
//     (VERIFIED_FILE) so a restart honours it. Past
//     AMIRA_CURATOR_MAX_STALE_HOURS without a confirmation (Omeka unreachable),
//     requests are refused, and retried on the fast schedule, until a refresh
//     succeeds;
//   - when Omeka answers 401/403 to the key (or ignores it, or the key file
//     stays unreadable), the store is dropped, the cache wiped, and requests
//     are refused until a later refresh succeeds;
//   - one crawl at a time: every crawl, the first one included, runs as a
//     background refresh, which shutdown aborts.
const curator = {
  verifiedAt: 0,
  blocked: false,
  retryTimer: null as ReturnType<typeof setTimeout> | null,
  /** Initial-load throttle: a failed crawl is not retried by every request. */
  nextAttempt: 0,
  /** Delay before the next timer-driven retry after a transient failure (backoff, reset on success). */
  retryDelayMs: 0,
  lastError: null as Error | null,
};
/** After a 401/403, retry this soon; transient failures back off up to it (capped by the refresh interval). */
const CURATOR_RETRY_MS = 5 * 60_000;
/** First retry after a transient failure with no store (AMIRA_CURATOR_RETRY_SECONDS; tests shorten it). */
const INITIAL_RETRY_MS = config.curatorRetrySeconds * 1000;

const maxStaleMs = (): number => config.curatorMaxStaleHours * 3_600_000;
const curatorStale = (): boolean => config.access === "curator" && Date.now() - curator.verifiedAt > maxStaleMs();

function curatorUnavailable(): Error {
  return new Error(curator.blocked
    ? `Curator data unavailable: ${KEY_NOT_ACCEPTED}. Private data was dropped; requests are refused until a refresh succeeds.`
    : `Curator data unavailable: not verified against Omeka for more than ${config.curatorMaxStaleHours} h. ` +
      "Requests are refused until a refresh succeeds.");
}

/** The key was refused (401/403), silently ignored (the authentication probe
 * found nothing private) or its file stayed unreadable: drop the store, wipe
 * the cache, refuse until a refresh succeeds. */
async function revokeCuratorData(err: { status?: number; keyFile?: string }): Promise<void> {
  current = null;
  curator.blocked = true;
  curator.verifiedAt = 0;
  await fs.rm(cacheSnapshotDir(), { recursive: true, force: true })
    .catch((e: Error) => console.error(`[amira] curator cache could not be wiped: ${e.message}`));
  const why = err.status ? `Omeka answered HTTP ${err.status} to the curator key`
    : err.keyFile ? "the Omeka key file stayed unreadable or malformed" : KEY_NOT_ACCEPTED;
  console.error(`[amira] ${why}: dropped the in-memory snapshot and wiped the curator cache; refusing requests until a refresh succeeds`);
  scheduleCuratorRetry();
}

/** Beside the curator snapshot: when Omeka last confirmed it, so a restart does not discard data confirmed minutes ago. */
const VERIFIED_FILE = "verified.json";

/**
 * When Omeka last confirmed the cached snapshot `manifest` describes: the
 * persisted confirmation when it belongs to this very snapshot (same
 * `fetchedAt`) and is neither older than the crawl nor in the future,
 * otherwise the crawl time itself.
 */
async function lastConfirmed(manifest: SnapshotManifest): Promise<number> {
  const fetched = Date.parse(manifest.fetchedAt);
  try {
    const stored = JSON.parse(await fs.readFile(path.join(cacheSnapshotDir(), VERIFIED_FILE), "utf8")) as { fetchedAt?: unknown; verifiedAt?: unknown };
    const at = typeof stored.verifiedAt === "string" ? Date.parse(stored.verifiedAt) : NaN;
    if (stored.fetchedAt === manifest.fetchedAt && at > fetched && at <= Date.now()) return at;
  } catch {
    // None yet, or unreadable: the crawl time is the last confirmation.
  }
  return fetched;
}

/** Persist a confirmation of the snapshot `manifest` describes (written whole, then renamed). Best effort. */
async function recordConfirmation(manifest: SnapshotManifest, at: number): Promise<void> {
  const dir = cacheSnapshotDir();
  const tmp = path.join(dir, `verified-${process.pid}-${at}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify({ fetchedAt: manifest.fetchedAt, verifiedAt: new Date(at).toISOString() }));
    await fs.rename(tmp, path.join(dir, VERIFIED_FILE));
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    // ENOENT: the cache was wiped meanwhile (a refused key); nothing to record.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[amira] curator confirmation not recorded: ${(err as Error).message}`);
  }
}

/**
 * Retry on a timer, without waiting for a request (the container healthcheck
 * sends none). A refused key retries after CURATOR_RETRY_MS; a transient
 * failure with no store (Omeka unreachable, a 502 while php restarts) backs
 * off from INITIAL_RETRY_MS, doubling up to the same cap. The retry is a
 * background refresh, which crawls afresh when no store exists and publishes
 * the result. One timer at most; a success resets the backoff.
 */
function scheduleCuratorRetry(kind: "auth" | "transient" = "auth"): void {
  if (stopped || !config.liveRefresh || curator.retryTimer) return;
  const interval = config.refreshIntervalHours > 0 ? config.refreshIntervalHours * 3_600_000 : CURATOR_RETRY_MS;
  const cap = Math.min(CURATOR_RETRY_MS, interval);
  let delay = cap;
  if (kind === "transient") {
    delay = Math.min(cap, curator.retryDelayMs || INITIAL_RETRY_MS);
    curator.retryDelayMs = Math.min(cap, delay * 2);
  }
  console.error(`[amira] curator: retrying in ${Math.round(delay / 1000)} s`);
  curator.retryTimer = setTimeout(() => {
    curator.retryTimer = null;
    triggerBackgroundRefresh();
  }, delay);
  curator.retryTimer.unref?.();
}

/** Carry the enrichments of the store being served into a crawl that could not fetch them (src/snapshot/enrichments.ts). */
function carryServedEnrichments(out: CrawlOutput): void {
  // `current.semantic` already satisfies the setting, so a pinned build is never replaced by another.
  carryEnrichments(out, current ? { fulltext: current.fulltextMaps, semantic: current.semantic } : null, config.semanticRelease);
}

/** Crawl with the key and publish to the curator cache; the published snapshot. Runs inside a background refresh only. */
async function curatorCrawl(signal: AbortSignal): Promise<CrawlOutput> {
  omekaKey(); // throws (naming only the variable) when the key file is missing or malformed
  const out = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`), signal,
    { semanticRelease: config.semanticRelease, access: "curator", fetchBase: config.fetchBase });
  signal.throwIfAborted();
  carryServedEnrichments(out);
  const published = (await writeSnapshotAtomic(cacheSnapshotDir(), out, signal)) ?? await loadSnapshot(cacheSnapshotDir());
  assertSnapshotSource(published.manifest, config.apiBase, "curator");
  return published;
}

interface Loaded { source: "bundled" | "cache"; out: CrawlOutput }

async function tryLoad(dir: string, source: "bundled" | "cache"): Promise<Loaded | null> {
  try {
    const out = await loadSnapshot(dir);
    assertSnapshotSource(out.manifest, config.apiBase, config.access);
    return { source, out: config.access === "public" ? publicOnly(out, source) : out };
  } catch (err) {
    if (source === "bundled" || config.access === "curator") {
      console.error(`[amira] ${source === "bundled" ? "bundled" : "cached"} snapshot unusable: ${(err as Error).message}`);
    }
    return null;
  }
}

/** Public mode, defence in depth: drop private records and values a public-labelled snapshot should never hold. */
function publicOnly(out: CrawlOutput, source: string): CrawlOutput {
  const { data, dropped } = publicView(out.data);
  if (data === out.data) return out;
  console.error(`[amira] public mode: removed ${dropped} private record(s) and every private value from the ${source} snapshot`);
  const counts = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (v as unknown[]).length])) as SnapshotManifest["counts"];
  return { ...out, data, manifest: { ...out.manifest, counts } };
}

/**
 * A store over `loaded`, serving `semantic` (already checked against the
 * setting). The manifest entry is rewritten to match what is served, since the
 * snapshot id names the semantic space.
 */
function storeOf(source: "bundled" | "cache", loaded: CrawlOutput, semantic: SemanticNeighbours | null): DataStore {
  const { semanticNeighbours: _stored, ...manifest } = loaded.manifest;
  return new DataStore(source, loaded.data, semantic ? { ...manifest, semanticNeighbours: semanticManifestEntry(semantic) } : manifest,
    loaded.fulltext, semantic);
}

/**
 * Pick the snapshot to serve at startup: the newest manifest, ties to the cache
 * (it descends from a refresh). Its neighbours come from whichever candidate
 * offers the best servable set: a cache written by a server older than 1.33.0,
 * or while GitHub was unreachable, carries none, and being newer it used to hide
 * the bundled neighbours until the next upstream change.
 */
export function chooseInitial(cache: Loaded | null, bundled: Loaded | null, semanticSetting: string): DataStore | null {
  const winner = cache && bundled ? (cache.out.manifest.fetchedAt >= bundled.out.manifest.fetchedAt ? cache : bundled) : cache ?? bundled;
  if (!winner) return null;
  const other = winner === cache ? bundled : cache;
  const semantic = pickSemantic([servableSemantic(winner.out.semantic, semanticSetting), servableSemantic(other?.out.semantic, semanticSetting)]);
  if (semantic && semantic !== winner.out.semantic) {
    console.error(`[amira] serving semantic neighbours ${semantic.source.tag} from the ${other!.source} snapshot`);
  }
  return storeOf(winner.source, winner.out, semantic);
}

/**
 * Curator mode: the cached curator snapshot when Omeka confirmed it recently
 * enough (null when there is none to serve). Past the refresh interval since
 * the last confirmation, the key is probed before the cache is trusted: a
 * refused key drops it; an unreachable Omeka is a transient failure, and the
 * cache serves within the staleness limit.
 */
async function loadCuratorCache(): Promise<DataStore | null> {
  omekaKey();
  const cached = await tryLoad(cacheSnapshotDir(), "cache");
  if (!cached) return null;
  const confirmed = await lastConfirmed(cached.out.manifest);
  if (Date.now() - confirmed > maxStaleMs()) {
    console.error(`[amira] curator cache not confirmed for more than ${config.curatorMaxStaleHours} h; crawling afresh`);
    return null;
  }
  if (Date.now() - confirmed > config.refreshIntervalHours * 3_600_000) {
    await probeCuratorAuth(config.fetchBase, lifecycle.signal).catch((err: Error & { omekaAuth?: boolean }) => {
      if (err.omekaAuth || lifecycle.signal.aborted) throw err;
      console.error(`[amira] curator authentication probe skipped: ${redactSecrets(err.message)}`);
    });
  }
  lifecycle.signal.throwIfAborted();
  // A refresh may have refused the key while this load awaited: never serve the cache then.
  if (curator.blocked) throw curatorUnavailable();
  curator.verifiedAt = confirmed;
  return chooseInitial(cached, null, config.semanticRelease)!;
}

/**
 * Curator mode: the cached curator snapshot when recent enough, otherwise a
 * fresh authenticated crawl. The crawl runs as a background refresh, so there
 * is only ever one (a request arriving while the retry timer crawls waits for
 * that crawl instead of starting a second), shutdown aborts it, and its
 * success clears every failure state, `blocked` included.
 */
async function loadInitialCurator(): Promise<DataStore> {
  if (curator.blocked) throw curatorUnavailable();
  if (Date.now() < curator.nextAttempt && curator.lastError) throw curator.lastError;
  if (!refreshInFlight) {
    try {
      const store = await loadCuratorCache();
      if (store) return store;
      if (!config.liveRefresh) throw new Error("no curator snapshot recent enough to serve, and live refresh is off");
    } catch (err) {
      const safe = new Error(`curator snapshot unavailable: ${redactSecrets((err as Error).message)}`);
      curator.lastError = safe;
      curator.nextAttempt = Date.now() + INITIAL_RETRY_MS;
      if ((err as { omekaAuth?: boolean }).omekaAuth) await revokeCuratorData(err as { status?: number; keyFile?: string });
      // A transient failure retries on its own: nothing else would until a request arrived.
      else if (!current) scheduleCuratorRetry("transient");
      throw safe;
    }
    // Another load may have started a refresh while this one read the cache.
    if (!refreshInFlight) {
      console.error("[amira] curator mode: crawling the Omeka API with the service key");
      triggerBackgroundRefresh();
    }
  }
  await refreshInFlight;
  if (current) return current;
  // The refresh logged the failure, set `lastError` and scheduled the retry.
  curator.nextAttempt = Date.now() + INITIAL_RETRY_MS;
  throw curator.lastError ?? (stopped ? new Error("curator snapshot unavailable: the server is shutting down")
    : curatorUnavailable());
}

async function loadInitial(): Promise<DataStore> {
  if (config.access === "curator") return loadInitialCurator();
  const [partitioned, bundled, legacy] = await Promise.all([
    tryLoad(cacheSnapshotDir(), "cache"),
    tryLoad(config.bundledDataDir, "bundled"),
    tryLoad(path.join(config.cacheDir, "current"), "cache"),
  ]);
  const store = chooseInitial(partitioned ?? legacy, bundled, config.semanticRelease);
  if (!store) throw new Error("no usable data snapshot (bundled data missing or corrupt)");
  return store;
}

export async function ensureStore(): Promise<DataStore> {
  if (current) {
    if (curatorStale()) throw curatorUnavailable();
    return current;
  }
  if (config.access === "curator" && curator.blocked) throw curatorUnavailable();
  if (!loading) {
    loading = loadInitial()
      .then((store) => {
        current = store;
        // Settled: drop the promise, or it would keep this first store alive
        // after a refresh replaces it or a curator revocation drops it (#46).
        loading = null;
        if (config.access === "curator") {
          // Loaded: a pending timer-driven retry is no longer needed.
          if (curator.retryTimer) clearTimeout(curator.retryTimer);
          curator.retryTimer = null;
          curator.retryDelayMs = 0;
        }
        // In the background: a request arriving first builds what it needs itself.
        void warmIndexes(store).catch((err: Error) => console.error(`[amira] index warm-up failed: ${err.message}`));
        if (config.liveRefresh) startBackgroundRefresh();
        return store;
      })
      // Do NOT cache the rejection: a transient failure (a half-written cache
      // dir, a momentary EBUSY) used to be latched forever, because every later
      // caller awaited the same rejected promise and the HTTP surface pinned
      // /healthz at 503 with no path back. Clear it so the next call retries.
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

/**
 * Entry points: load the snapshot (and kick off the background refresh) without
 * blocking startup, logging what was loaded or why it failed. Requests await
 * ensureStore() themselves and surface any load error; `onFailure` receives the
 * failure's message too (the HTTP entry reports it on /healthz).
 */
export function loadInBackground(onFailure?: (message: string) => void): void {
  void ensureStore()
    .then((store) =>
      console.error(
        `[amira] loaded ${store.items.length} research items / ${store.projects.length} projects / ` +
          `${store.videos.length} videos from ${store.source} snapshot (fetchedAt=${store.manifest.fetchedAt})`,
      ),
    )
    .catch((err) => {
      const message = (err as Error).message;
      onFailure?.(message);
      console.error(`[amira] initial data load failed: ${message}`);
    });
}

/** The store currently being served, or null before the first load resolves.
 * Read this (not a captured reference) so callers see post-refresh swaps.
 * In curator mode, also null while the data may not be served (unverified for
 * too long, or the key refused). */
export function currentStore(): DataStore | null {
  return curatorStale() ? null : current;
}

/** Run one background refresh now and wait for it (tests; the timer runs the same). */
export async function refreshNow(): Promise<void> {
  triggerBackgroundRefresh();
  await refreshInFlight;
}

function startBackgroundRefresh(): void {
  if (stopped) return;
  triggerBackgroundRefresh();

  if (refreshTimer || config.refreshIntervalHours <= 0) return;
  const intervalMs = config.refreshIntervalHours * 60 * 60 * 1000;
  refreshTimer = setInterval(() => triggerBackgroundRefresh(), intervalMs);
  refreshTimer.unref?.();
}

function triggerBackgroundRefresh(): void {
  if (refreshInFlight || stopped) return;
  refreshController = new AbortController();
  refreshState.in_flight = true;
  refreshInFlight = backgroundRefresh().finally(() => {
    refreshInFlight = null;
    refreshController = null;
    refreshState.in_flight = false;
  });
}

/**
 * Probe the live API; on staleness, re-crawl into the cache (staged + atomic)
 * and hot-swap the in-memory store. Every failure is non-fatal — the loaded
 * snapshot keeps serving.
 */
async function backgroundRefresh(): Promise<void> {
  const curatorMode = config.access === "curator";
  try {
    const local = current?.manifest;
    // Curator mode without a store (the key was refused, or the first crawl
    // failed) crawls afresh; public mode always has a store to compare with.
    if (!local && !curatorMode) return;
    refreshState.last_attempt = new Date().toISOString();
    const signal = AbortSignal.any([refreshController!.signal, AbortSignal.timeout(15 * 60_000)]);
    if (local) {
      // Every curator refresh first proves the key still works: a key revoked
      // mid-life returns anonymous data, which the freshness probe alone would miss.
      if (curatorMode) await probeCuratorAuth(config.fetchBase, signal);
      const probe = await probeRemote(config.fetchBase, signal);
      const forced = Date.now() - Date.parse(local.fetchedAt) >= config.fullRefreshHours * 3_600_000;
      if (!isStale(local, probe) && !forced) {
        if (curatorMode) {
          curator.verifiedAt = Date.now();
          curator.lastError = null;
          curator.retryDelayMs = 0;
          await recordConfirmation(local, curator.verifiedAt);
        }
        refreshState.last_success = new Date().toISOString(); refreshState.error_class = null; return;
      }
      console.error(`[amira] snapshot stale (local ${local.maxModified ?? "?"} < remote ${probe.maxModified ?? "?"}); refreshing…`);
    }

    let published: CrawlOutput;
    if (curatorMode) {
      published = await curatorCrawl(signal);
    } else {
      const out: CrawlOutput = await crawlSnapshot(config.apiBase, (m) => console.error(`[amira] refresh: ${m}`), signal,
        { semanticRelease: config.semanticRelease, fetchBase: config.fetchBase });
      signal.throwIfAborted();
      carryServedEnrichments(out);
      // The writer returns what it verified; only when another process published
      // a newer generation first is the served snapshot read back from disk.
      published = (await writeSnapshotAtomic(cacheSnapshotDir(), out, signal)) ?? await loadSnapshot(cacheSnapshotDir());
      assertSnapshotSource(published.manifest, config.apiBase, config.access);
      published = publicOnly(published, "refreshed");
    }
    signal.throwIfAborted();
    // Another process may have published first, under another setting or version.
    const next = storeOf("cache", published, servableSemantic(published.semantic, config.semanticRelease));
    // Built before the swap, so no request on the new snapshot pays for an index.
    await warmIndexes(next, signal);
    signal.throwIfAborted();
    current = next;
    if (curatorMode) {
      curator.verifiedAt = Date.now();
      curator.blocked = false;
      curator.lastError = null;
      curator.nextAttempt = 0;
      curator.retryDelayMs = 0;
      await recordConfirmation(published.manifest, curator.verifiedAt);
      if (!refreshTimer && config.liveRefresh) startBackgroundRefresh();
    }
    refreshState.last_success = new Date().toISOString();
    refreshState.error_class = null;
    console.error(`[amira] refreshed snapshot (fetchedAt=${published.manifest.fetchedAt}, ${published.data.research_items.length} research items)`);
  } catch (err) {
    const auth = curatorMode && (err as { omekaAuth?: boolean }).omekaAuth;
    refreshState.error_class = auth ? "omeka_auth_refused" : (err as Error).name === "AbortError" ? "cancelled"
      : (err as Error).name === "TimeoutError" ? "timeout" : "refresh_failed";
    console.error(`[amira] live refresh skipped: ${redactSecrets((err as Error).message)}`);
    if (curatorMode) curator.lastError = new Error(`curator snapshot unavailable: ${redactSecrets((err as Error).message)}`);
    if (auth) await revokeCuratorData(err as { status?: number; keyFile?: string });
    // Retry on the fast schedule while nothing may be served (no store, or one
    // past its staleness limit after a long outage), and after a key file that
    // could not be read (an atomic rotation in progress, or a removed file,
    // which then fails closed at the retry): the hourly interval is too slow.
    else if (curatorMode && (!current || curatorStale() || (err as { keyFile?: string }).keyFile === "transient")) {
      scheduleCuratorRetry("transient");
    }
  }
}
