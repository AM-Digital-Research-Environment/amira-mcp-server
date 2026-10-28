// The queue behind the app's automatic selection updates (src/ui/contextSync.ts):
// one request in flight, the newest wanted selection next, nothing reported
// for a selection the page no longer shows. Ported from the IWAC server's
// mcpb/test/context-sync.test.ts, which the class itself comes from.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";

hermeticEnv();
const { ContextSync } = await import("../../server/lib.js");

function harness() {
  const calls = [], statuses = [];
  let active = 0, maxActive = 0;
  const sync = new ContextSync((value, signal) => {
    active++;
    maxActive = Math.max(maxActive, active);
    return new Promise((resolve, reject) => {
      calls.push({
        value, signal,
        resolve: () => { active--; resolve(); },
        reject: (error) => { active--; reject(error); },
      });
    });
  }, (status) => statuses.push(status));
  return { sync, calls, statuses, maxActive: () => maxActive };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
const selection = (value) => ({ selection: value });
const sent = (calls) => calls.map((call) => call.value.selection);

test("updates serialise, coalesce to the newest selection, and skip equal JSON", async () => {
  const { sync, calls, statuses, maxActive } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.publish(selection("C"));
  assert.deepEqual(sent(calls), ["A"]);
  calls[0].resolve();
  await turn();
  assert.deepEqual(sent(calls), ["A", "C"]);
  assert.deepEqual(statuses, ["pending"], "the stale A does not claim that C was shared");
  calls[1].resolve();
  await turn();
  sync.publish(selection("C"));
  assert.equal(calls.length, 2);
  assert.deepEqual(statuses, ["pending", "shared"]);
  assert.equal(maxActive(), 1);
});

test("A -> B -> A reuses the A in flight and drops the unsent B", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.publish(selection("A"));
  calls[0].resolve();
  await turn();
  assert.deepEqual(sent(calls), ["A"]);
  assert.deepEqual(statuses, ["pending", "shared"]);
});

test("A is sent again once B has gone out", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  calls[0].resolve();
  await turn();
  sync.publish(selection("B"));
  sync.publish(selection("A"));
  calls[1].resolve();
  await turn();
  assert.deepEqual(sent(calls), ["A", "B", "A"]);
  calls[2].resolve();
  await turn();
  assert.deepEqual(statuses, ["pending", "shared", "pending", "shared"]);
});

test("a failure moves on to newer work, and the failed snapshot is not retried", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  calls[0].reject(new Error("stale A failed"));
  await turn();
  assert.deepEqual(sent(calls), ["A", "B"]);
  assert.deepEqual(statuses, ["pending"]);
  calls[1].reject(new Error("B failed"));
  await turn();
  sync.publish(selection("B"));
  assert.equal(calls.length, 2);
  assert.deepEqual(statuses, ["pending", "failed"]);
  sync.publish(selection("C"));
  calls[2].resolve();
  await turn();
  assert.deepEqual(statuses, ["pending", "failed", "pending", "shared"]);
});

test("stop aborts the send in flight, drops queued work and silences later status", async () => {
  const { sync, calls, statuses } = harness();
  sync.publish(selection("A"));
  sync.publish(selection("B"));
  sync.stop();
  sync.stop();
  assert.equal(calls[0].signal.aborted, true);
  calls[0].reject(new Error("aborted"));
  await turn();
  sync.publish(selection("C"));
  assert.deepEqual(sent(calls), ["A"]);
  assert.deepEqual(statuses, ["pending"]);
});

test("status callbacks may publish, stop or throw without recursion or unhandled rejections", async () => {
  const values = [], statuses = [];
  let sync;
  sync = new ContextSync(async (value) => {
    values.push(value.selection);
    if (value.selection === "B") throw new Error("host rejected");
  }, (status) => {
    statuses.push(status);
    if (status === "pending" && values.length === 0) sync.publish(selection("B"));
    if (status === "failed") sync.publish(selection("C"));
    if (status === "shared") sync.stop();
    throw new Error("status rendering failed");
  });
  sync.publish(selection("A"));
  await turn();
  assert.deepEqual(values, ["B", "C"]);
  assert.deepEqual(statuses, ["pending", "failed", "pending", "shared"]);
  sync.publish(selection("D"));
  assert.deepEqual(values, ["B", "C"]);
});

test("a sender that throws synchronously fails the snapshot without nesting callbacks", async () => {
  let failures = 0, depth = 0, maxDepth = 0;
  let sync;
  sync = new ContextSync(() => { throw new Error("sync failure"); }, (status) => {
    if (status !== "failed") return;
    depth++;
    maxDepth = Math.max(maxDepth, depth);
    failures++;
    if (failures < 4) sync.publish(selection(String(failures)));
    depth--;
  });
  sync.publish(selection("initial"));
  await turn();
  assert.equal(failures, 4);
  assert.equal(maxDepth, 1);
});
