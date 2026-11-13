import { createHash } from "node:crypto";
import * as path from "node:path";
import type { SnapshotManifest } from "./types.js";

/** Origin and installation path identify an Omeka instance; trailing slashes do not. */
export function normalizeApiBase(base: string): string {
  const url = new URL(base);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Snapshot API base must be an HTTP(S) URL without credentials, query or fragment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export type AccessMode = "public" | "curator";

/**
 * The cache partition of one Omeka instance and access mode. A public partition
 * hashes the API base alone, as before curator mode, so existing caches stay
 * valid; a curator partition hashes the access mode in as well, so the two can
 * never share a directory even under one AMIRA_CACHE_DIR.
 */
export function snapshotCacheDir(root: string, apiBase: string, access: AccessMode = "public"): string {
  const key = access === "public" ? normalizeApiBase(apiBase) : JSON.stringify([normalizeApiBase(apiBase), access]);
  return path.join(root, createHash("sha256").update(key).digest("hex").slice(0, 24));
}

/** The access mode a snapshot was crawled in (older snapshots predate the field and are public). */
export const snapshotAccess = (manifest: SnapshotManifest): AccessMode => manifest.access === "curator" ? "curator" : "public";

export function assertSnapshotSource(manifest: SnapshotManifest, apiBase: string, access: AccessMode = "public"): void {
  if (normalizeApiBase(manifest.apiBase) !== normalizeApiBase(apiBase)) {
    throw new Error("Snapshot belongs to a different Omeka instance; configure AMIRA_SITE_BASE and AMIRA_DATA_DIR together");
  }
  if (snapshotAccess(manifest) !== access) {
    throw new Error(`Snapshot was crawled in ${snapshotAccess(manifest)} mode; a ${access}-mode server refuses it`);
  }
  if (!Number.isFinite(Date.parse(manifest.fetchedAt))) throw new Error("Invalid snapshot timestamp");
}

export function snapshotId(manifest: SnapshotManifest): string {
  // The corpus-vector release names the semantic space a neighbour list came
  // from (#12). Appended only when present, so older snapshot ids are unchanged.
  const space = manifest.semanticNeighbours ? [manifest.semanticNeighbours.tag, manifest.semanticNeighbours.model] : [];
  // Likewise the access mode, only for curator snapshots: public ids are unchanged.
  const access = snapshotAccess(manifest) === "curator" ? ["curator"] : [];
  return createHash("sha256").update(JSON.stringify([normalizeApiBase(manifest.apiBase), manifest.fetchedAt,
    manifest.maxModified, manifest.counts, ...space, ...access])).digest("hex").slice(0, 24);
}
