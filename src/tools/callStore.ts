// The store one tool call serves. The policy (src/tools/policy.ts) binds each
// call to the snapshot being served when it starts (`withStore`), so a refresh
// that swaps the store mid-call cannot mix two snapshots; handlers read that
// binding here instead of asking for whatever store is current by then.
import { scopedStore, withStore, type DataStore } from "../data.js";

/** Run `fn` as a tool call bound to `store` (its fold caches included). */
export function runWithCallStore<T>(store: DataStore, fn: () => T): T {
  return withStore(store, fn);
}

/** The store of the running tool call. Only handlers wrapped by the policy have one. */
export function callStore(): DataStore {
  const store = scopedStore();
  if (!store) throw new Error("callStore() outside a tool call");
  return store;
}
