#!/usr/bin/env node
// Build-time snapshot fetcher: crawl the public Omeka API into ./data (or the
// dir given as argv[2]), staged + atomically promoted. Replaces the
// dashboard-era scripts/fetch_data.mjs; the runtime live refresh runs the
// exact same crawl via src/snapshot.ts.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { API_BASE, config } from "./config.js";
import { crawlSnapshot, loadSnapshot, writeSnapshotAtomic } from "./snapshot.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] ?? path.resolve(MODULE_DIR, "..", "data"));

console.error(`[fetch] crawling ${API_BASE} -> ${dest}`);
const started = Date.now();
const out = await crawlSnapshot(API_BASE, (m) => console.error(`[fetch] ${m}`), undefined, { semanticRelease: config.semanticRelease });
// No verified corpus-vector release this time: keep the neighbours of the snapshot being replaced
// (they are filtered to the new snapshot at load, so a deleted record is never cited).
if (!out.semantic && config.semanticRelease !== "off") {
  const previous = await loadSnapshot(dest).catch(() => null);
  if (previous?.semantic) {
    out.semantic = previous.semantic;
    console.error(`[fetch] kept semantic neighbours ${previous.semantic.source.tag} from the previous snapshot`);
  }
}
await writeSnapshotAtomic(dest, out);
console.error(
  `[fetch] done in ${((Date.now() - started) / 1000).toFixed(0)}s — fetchedAt=${out.manifest.fetchedAt}, maxModified=${out.manifest.maxModified ?? "?"}`,
);
console.log(JSON.stringify(out.manifest.counts, null, 1));
