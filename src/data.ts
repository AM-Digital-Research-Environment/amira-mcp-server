// The data layer's one import path: the snapshot store (src/store.ts) and the
// process lifecycle that loads, refreshes and replaces it (src/storeLifecycle.ts).
export { DataStore, UNIVERSITY_LABELS } from "./store.js";
export {
  cacheSnapshotDir, chooseInitial, currentStore, ensureStore, refreshNow, refreshStatus, stopBackgroundRefresh, withStore,
} from "./storeLifecycle.js";
