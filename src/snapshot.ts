// Snapshot lifecycle: crawl the public Omeka API into typed records, write them
// to a directory (manifest LAST — a dir without a valid manifest is never
// loadable), load + validate, and the cheap freshness probe (D9/D11).
//
// Shared by the build-time fetch CLI (src/fetchCli.ts) and the runtime live
// refresh (src/storeLifecycle.ts), so fetch behaviour can never drift between
// the two. This module is the one import path; the code lives in src/snapshot/:
//   http.ts         GET with retries, the curator key, internal-URL rewriting
//   crawl.ts        the Omeka crawl into snapshot records
//   enrichments.ts  the GitHub-hosted full-text map and corpus-vector releases
//   probe.ts        the curator-key and freshness probes
//   disk.ts         disk layout, fingerprints and the atomic publish
export { fetchJSON } from "./snapshot/http.js";
export { crawlSnapshot, type CrawlOutput } from "./snapshot/crawl.js";
export { fetchFulltextMaps, fetchSemanticRelease } from "./snapshot/enrichments.js";
export { isStale, KEY_NOT_ACCEPTED, probeCuratorAuth, probeRemote, type RemoteProbe } from "./snapshot/probe.js";
export {
  loadSnapshot, readFingerprints, readManifest, readSnapshotPointer, snapshotFingerprints, writeSnapshot, writeSnapshotAtomic,
  type Fingerprint, type Fingerprints,
} from "./snapshot/disk.js";
