// Serialised, latest-wins delivery of the app's selection to the model
// (`ui/update-model-context`). Ported from the IWAC server's
// mcpb/src/app/contextSync.ts, whose tests it shares in spirit
// (test/unit/context-sync.test.mjs).
//
// Why a queue at all: a reader ticking five checkboxes fires five updates in a
// second. Sent concurrently they could land out of order, and the host keeps
// only the LAST one it received, which might then be the second tick. Sent one
// at a time with the queue collapsed to the newest wanted snapshot, the host
// ends on what the page shows, with at most one request in flight.
//
// Dependency-free so the browser bundle (src/ui/bridge.ts) and the node test
// library (src/lib.ts) can both import it.

export type ContextSyncStatus = "pending" | "shared" | "failed";

interface Snapshot<T> {
  key: string;
  value: T;
  settled: boolean;
}

interface Flight<T> {
  snapshot: Snapshot<T>;
  controller: AbortController;
}

/**
 * Serialises context updates and keeps only the newest requested snapshot.
 * Values must be JSON-serialisable and stay unchanged after `publish`. A
 * failed snapshot is not retried until different content is published. The
 * sender owns its timeout; `stop` aborts an outstanding send.
 */
export class ContextSync<T> {
  private wanted?: Snapshot<T>;
  private flight?: Flight<T>;
  private status?: ContextSyncStatus;
  private stopped = false;

  constructor(
    private readonly send: (value: T, signal: AbortSignal) => Promise<void>,
    private readonly onStatus: (status: ContextSyncStatus) => void = () => {},
  ) {}

  publish(value: T): void {
    if (this.stopped) return;
    const key = JSON.stringify(value);
    if (this.wanted && this.wanted.key === key) return;
    this.wanted = { key, value, settled: false };
    this.report("pending");
    this.drain();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wanted = undefined;
    this.flight?.controller.abort();
  }

  private report(status: ContextSyncStatus): void {
    if (this.stopped || this.status === status) return;
    // Commit before calling out: the callback may publish or stop.
    this.status = status;
    try {
      this.onStatus(status);
    } catch {
      // A status line that fails to render must not break the queue.
    }
  }

  private drain(): void {
    if (this.stopped || this.flight || !this.wanted || this.wanted.settled) return;
    const flight = { snapshot: this.wanted, controller: new AbortController() };
    this.flight = flight;
    void this.dispatch(flight);
  }

  private async dispatch(flight: Flight<T>): Promise<void> {
    let status: "shared" | "failed" = "shared";
    try {
      await this.send(flight.snapshot.value, flight.controller.signal);
    } catch {
      status = "failed";
      // Yield even after a synchronous throw, so a failed-status callback that
      // publishes new work cannot recurse into another failure on this stack.
      await Promise.resolve();
    }
    this.flight = undefined;
    if (this.stopped) return;
    const wanted = this.wanted;
    if (wanted && wanted.key === flight.snapshot.key) {
      // A -> B -> A while A was in flight: the A that just completed is what
      // the page shows, so B is dropped and A is not sent twice.
      wanted.settled = true;
      this.report(status);
    }
    // A stale completion reports nothing for the newer selection, which is
    // sent now that the previous request has settled.
    this.drain();
  }
}
