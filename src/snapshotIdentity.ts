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

export function snapshotCacheDir(root: string, apiBase: string): string {
  return path.join(root, createHash("sha256").update(normalizeApiBase(apiBase)).digest("hex").slice(0, 24));
}

export function assertSnapshotSource(manifest: SnapshotManifest, apiBase: string): void {
  if (normalizeApiBase(manifest.apiBase) !== normalizeApiBase(apiBase)) {
    throw new Error("Snapshot belongs to a different Omeka instance; configure AMIRA_SITE_BASE and AMIRA_DATA_DIR together");
  }
  if (!Number.isFinite(Date.parse(manifest.fetchedAt))) throw new Error("Invalid snapshot timestamp");
}

export function snapshotId(manifest: SnapshotManifest): string {
  return createHash("sha256").update(JSON.stringify([normalizeApiBase(manifest.apiBase), manifest.fetchedAt,
    manifest.maxModified, manifest.counts])).digest("hex").slice(0, 24);
}
