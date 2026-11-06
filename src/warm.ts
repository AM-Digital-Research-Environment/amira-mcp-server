// Build a snapshot's heavy derived indexes before a request needs them.
//
// Each index is built once per snapshot (DataStore.cached), synchronously:
// the first request that touched one used to pay for it on the event loop
// (the semantic index took 170 ms, the entity graph about as much), and every
// other client's request waited behind it. A timer cannot interrupt that work
// (src/tools/policy.ts), so the only fix is to do it before serving: at
// startup in the background, and on a live refresh BEFORE the new snapshot is
// swapped in. Builders run one per event-loop turn, so a request can slip in
// between them.
import { setImmediate as nextTurn } from "node:timers/promises";
import type { DataStore } from "./data.js";
import { graphIndex } from "./entityGraph.js";
import { fulltextIndex } from "./fulltextMaps.js";
import { recordByOId } from "./recordKinds.js";
import { semanticIndex } from "./semantic.js";

const BUILDERS: readonly ((store: DataStore) => unknown)[] = [
  (store) => recordByOId(store, 0),
  semanticIndex,
  fulltextIndex,
  graphIndex,
];

export async function warmIndexes(store: DataStore, signal?: AbortSignal): Promise<void> {
  for (const build of BUILDERS) {
    await nextTurn();
    signal?.throwIfAborted();
    build(store);
  }
}
