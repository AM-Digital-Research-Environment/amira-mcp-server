#!/usr/bin/env node
// Build-time snapshot fetcher: crawl the public Omeka API into ./data (or the
// dir given as argv[2]), staged + atomically promoted. Replaces the
// dashboard-era scripts/fetch_data.mjs; the runtime live refresh runs the
// exact same crawl via src/snapshot.ts.
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { API_BASE, config } from "./config.js";
import { carryEnrichments, crawlSnapshot, loadSnapshot, writeSnapshotAtomic } from "./snapshot.js";
import { refuseMisconfiguration } from "./access.js";

// The bundled snapshot is public by definition (#26): never crawl it with a key.
refuseMisconfiguration("fetch");

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] ?? path.resolve(MODULE_DIR, "..", "data"));

console.error(`[fetch] crawling ${config.fetchBase} -> ${dest}`);
const started = Date.now();
const out = await crawlSnapshot(API_BASE, (m) => console.error(`[fetch] ${m}`), undefined,
  { semanticRelease: config.semanticRelease, fetchBase: config.fetchBase });
// GitHub unreachable this time: keep the enrichments of the snapshot being
// replaced, as the server's live refresh does (src/snapshot/enrichments.ts).
if (!out.fulltext || !out.semantic) {
  const previous = await loadSnapshot(dest).catch(() => null);
  for (const kept of carryEnrichments(out, previous, config.semanticRelease)) console.error(`[fetch] kept ${kept} from the previous snapshot`);
}
await writeSnapshotAtomic(dest, out);
console.error(
  `[fetch] done in ${((Date.now() - started) / 1000).toFixed(0)}s — fetchedAt=${out.manifest.fetchedAt}, maxModified=${out.manifest.maxModified ?? "?"}`,
);
console.log(JSON.stringify(out.manifest.counts, null, 1));
