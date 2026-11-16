// The cheap probes (D11): whether the curator key is accepted, and whether the
// remote instance changed since a snapshot was taken.

import { config } from "../config.js";
import { FULLTEXT_SOURCE } from "../fulltextMaps.js";
import { systemDate, type OmekaItem } from "../omekaJSON.js";
import { SNAPSHOT_SCHEMA_VERSION, type SnapshotManifest } from "../types.js";
import { fetchJSON } from "./http.js";

/** Said when the authentication probe fails; quotes no secret. */
export const KEY_NOT_ACCEPTED = "Omeka key not accepted or lacks view-all";

/**
 * Curator mode: prove the service key is accepted and can see private
 * resources. Omeka answers an unknown, revoked or mistyped key with the
 * anonymous data (HTTP 200), never an error, so a crawl alone cannot tell; the
 * probe (AMIRA_CURATOR_AUTH_PROBE, by default `items?is_public=0&per_page=1`)
 * must return a non-empty array, and no element marked public (that would mean
 * the filter was ignored). Anything else fails closed, flagged `omekaAuth`
 * like a 401/403, so the caller drops the private data (src/storeLifecycle.ts).
 */
export async function probeCuratorAuth(apiBase: string, signal?: AbortSignal, probePath = config.curatorAuthProbe): Promise<void> {
  const { body } = await fetchJSON<unknown>(`${apiBase}/${probePath}`, signal);
  const ok = Array.isArray(body) && body.length > 0 &&
    !body.some((r) => r && typeof r === "object" && (r as Record<string, unknown>)["o:is_public"] === true);
  if (!ok) {
    throw Object.assign(new Error(`${KEY_NOT_ACCEPTED}: the authentication probe found no private resource`), { omekaAuth: true });
  }
}

/** One-request freshness probe: max o:modified + unfiltered item total (D11). */
export interface RemoteProbe { maxModified: string | null; totalItems: number; itemSetsSignature?: string; totalItemSets?: number }
export async function probeRemote(apiBase: string, signal?: AbortSignal): Promise<RemoteProbe> {
  const { body, total } = await fetchJSON<OmekaItem[]>(
    `${apiBase}/items?sort_by=modified&sort_order=desc&per_page=1`, signal,
  );
  if (!Array.isArray(body) || !Number.isSafeInteger(total) || total < 0 || (total > 0 && !body[0])) {
    throw new Error("Omeka freshness probe returned an invalid item list or total-results header");
  }
  const sets = await fetchJSON<OmekaItem[]>(`${apiBase}/item_sets?sort_by=modified&sort_order=desc&per_page=1`, signal);
  if (!Array.isArray(sets.body) || !Number.isSafeInteger(sets.total) || sets.total < 0 || (sets.total > 0 && !sets.body[0])) {
    throw new Error("Omeka item-set freshness probe returned an invalid item list or total-results header");
  }
  return { maxModified: body[0] ? systemDate(body[0], "o:modified") : null, totalItems: total,
    totalItemSets: sets.total, itemSetsSignature: JSON.stringify([sets.total, sets.body[0] ? systemDate(sets.body[0], "o:modified") : null]) };
}

/** True when the local manifest is older than what the probe reports. */
export function isStale(local: SnapshotManifest, probe: RemoteProbe): boolean {
  // An older snapshot schema lacks fields the current tools serve: recrawl.
  if (local.schemaVersion < SNAPSHOT_SCHEMA_VERSION) return true;
  if (probe.itemSetsSignature !== undefined && local.itemSetsSignature !== probe.itemSetsSignature) return true;
  if (probe.maxModified && (!local.maxModified || probe.maxModified > local.maxModified)) return true;
  if (local.totalItemsOnInstance != null && probe.totalItems !== local.totalItemsOnInstance) return true;
  // A full-text map from an older pin: the release moved the pin, so fetch the new files.
  if (local.fulltextMaps && local.fulltextMaps.tag !== FULLTEXT_SOURCE.tag) return true;
  return false;
}
