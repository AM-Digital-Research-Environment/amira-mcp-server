// The store one tool call serves. The policy (src/tools/policy.ts) binds each
// call to the snapshot being served when it starts, so a refresh that swaps the
// store mid-call cannot mix two snapshots; handlers read that binding here
// instead of asking src/data.ts for whatever store is current by then.
import { AsyncLocalStorage } from "node:async_hooks";
import { withStore, type DataStore } from "../data.js";

const callScope = new AsyncLocalStorage<DataStore>();

/** Run `fn` as a tool call bound to `store` (its fold caches included). */
export function runWithCallStore<T>(store: DataStore, fn: () => T): T {
  return callScope.run(store, () => withStore(store, fn));
}

/** The store of the running tool call. Only handlers wrapped by the policy have one. */
export function callStore(): DataStore {
  const store = callScope.getStore();
  if (!store) throw new Error("callStore() outside a tool call");
  return store;
}
