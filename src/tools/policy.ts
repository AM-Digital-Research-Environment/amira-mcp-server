// Cross-cutting tool policy, applied once after registration through the SDK's
// public RegisteredTool API (`remove()`, `update({ callback, _meta })`) — this
// replaces the old monkey-patched `server.registerTool`.
//
//   - Profiles: tools outside AMIRA_TOOL_PROFILE are removed, not merely
//     disabled, so a call to one fails like any unknown tool.
//   - Arguments: every string is trimmed. A trailing space used to turn
//     `subject="Architecture "` from 4 matches into 0, and `collection=" "` matched
//     all 3,975 items. Empty optional strings are dropped; an empty REQUIRED one
//     is refused with a clear error.
//   - Errors: `isError` results carry the error as text only. Structured content
//     on an error does not match a tool's output schema (10 of 11 schemas had no
//     error branch), and clients may validate it.
//   - Discovery: hosts that defer tool loading (Claude Code's tool search) keep
//     the entry tools loaded via `_meta["anthropic/alwaysLoad"]`.
//   - Guidance (AMIRA_GUIDANCE=off): titles, descriptions and schema text go,
//     and so does the entry-point hint, which only restates the instructions'
//     workflow. Names, schemas and handlers stay (src/guidance.ts).
//   - Schemas: the safe-integer bounds zod writes on every `.int()` are left out
//     of tools/list (~250 tokens per turn); validation keeps them.
//   - Structured content travels only where a client reads it: tools with an
//     output schema (the SDK requires it there) and tools that render an app
//     (the page reads it). Everywhere else it repeated the text block byte for
//     byte, doubling the wire size of the result. The IWAC server does the same.
//   - Deadline: a call that has not answered after CALL_DEADLINE_MS returns a
//     `deadline_exceeded` error instead of holding the client open.
//   - Curator mode (#26): every result passes through src/tools/curator.ts,
//     which marks visibility, swaps a private record's public URL for its admin
//     URL and adds the restricted block to detail results.
import type { RegisteredTool } from "@modelcontextprotocol/server";
import { errorResult } from "./responses.js";
import { currentStore, ensureStore, withStore } from "../data.js";
import { dropSafeIntegerBounds, dropSchemaNoise, withJsonSchema, withoutSchemaText } from "../guidance.js";
import { config } from "../config.js";
import { curatorToolResult } from "./curator.js";
import type { DataStore } from "../data.js";

/** How long one tool call may run before the client gets an error. Every
 * query runs on the in-memory snapshot; the slowest measured calls (text
 * passages over every full text, the largest graph) finish in under 2 s.
 *
 * A timer cannot interrupt synchronous work: once a handler is past its
 * awaits it runs to completion, and its result wins the race. The deadline
 * therefore bounds the ASYNC part of a call (waiting for the first snapshot
 * load, reading retained snapshots from disk), not a long computation. Heavy
 * indexes are warmed when a store loads (src/data.ts), so requests do not pay
 * for them. */
export const CALL_DEADLINE_MS = 60_000;

function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Run a handler bound to the snapshot being served when it starts, so a
 * refresh that swaps the store mid-call cannot mix two snapshots' caches.
 * The store comes back with the result (curator decoration reads it). */
async function inStore<T>(fn: () => T): Promise<{ result: Awaited<T>; store: DataStore }> {
  const store = currentStore() ?? await ensureStore();
  return { result: await withStore(store, fn), store };
}

function withoutStructured<T>(result: T): T {
  if (result && typeof result === "object" && "structuredContent" in result) {
    const { structuredContent: _omit, ...rest } = result as Record<string, unknown>;
    return rest as T;
  }
  return result;
}

export type ToolMap = Record<string, RegisteredTool>;

/** The tools the instructions tell a model to call first. */
export const ALWAYS_LOAD = new Set(["get_collection_overview", "resolve_entity"]);

type Shape = Record<string, { safeParse?: (v: unknown) => { success: boolean } }>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

function trimObject(obj: Record<string, unknown>, dropEmpty: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed || !dropEmpty) out[key] = trimmed;
    } else out[key] = value;
  }
  return out;
}

/**
 * Trim the validated arguments of one call. Returns the cleaned arguments, or
 * the name of a required string argument that was empty.
 */
export function cleanArgs(args: unknown, shape?: Shape): { args: unknown } | { emptyRequired: string } {
  if (!isPlainObject(args)) return { args };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) out[key] = trimmed;
      else if (shape?.[key]?.safeParse?.(undefined).success === false) return { emptyRequired: key };
    } else if (Array.isArray(value)) {
      out[key] = value
        .map((v) => (typeof v === "string" ? v.trim() : isPlainObject(v) ? trimObject(v, false) : v))
        .filter((v) => v !== "");
    } else if (isPlainObject(value)) {
      out[key] = trimObject(value, true); // nested filter objects: every field is optional
    } else out[key] = value;
  }
  return { args: out };
}

function withoutStructuredError<T>(result: T): T {
  if (result && typeof result === "object" && (result as { isError?: boolean }).isError && "structuredContent" in result) {
    const { structuredContent: _omit, ...rest } = result as Record<string, unknown>;
    return rest as T;
  }
  return result;
}

/** Remove tools outside the profile and wrap the rest with the shared policy. */
export function applyToolPolicy(tools: ToolMap, allowed: ReadonlySet<string> | null, opts: { guidance?: boolean } = {}): void {
  const guidance = opts.guidance ?? true;
  for (const [name, tool] of Object.entries(tools)) {
    if (allowed && !allowed.has(name)) {
      tool.remove();
      continue;
    }
    const handler = tool.handler as (args: unknown, ctx: unknown) => unknown;
    const shape = (tool.inputSchema as unknown as { shape?: Shape } | undefined)?.shape;
    const keepStructured = Boolean(tool.outputSchema) || Boolean((tool._meta as { ui?: unknown } | undefined)?.ui);
    // Memoised per tool: what a tool advertises is fixed for the process (given guidance).
    const advertised = <S>(schema: S, side: "in" | "out"): S => withJsonSchema(guidance ? schema : withoutSchemaText(schema),
      (json) => dropSchemaNoise(dropSafeIntegerBounds(json), { output: side === "out" }), `${name}:${guidance ? "g" : "-"}:${side}`);
    tool.update({
      callback: (async (args: unknown, ctx: unknown) => {
        const cleaned = cleanArgs(args, shape);
        if ("emptyRequired" in cleaned) {
          return withoutStructuredError(errorResult("invalid_argument", `\`${cleaned.emptyRequired}\` must not be empty.`));
        }
        const run = inStore(() => handler(cleaned.args, ctx)).then(({ result, store }) =>
          config.access === "curator" ? curatorToolResult(name, result, cleaned.args, store) : result);
        const result = withoutStructuredError(
          await withDeadline(run, CALL_DEADLINE_MS, () =>
            errorResult("deadline_exceeded", `${name} did not answer within ${CALL_DEADLINE_MS / 1000} s; narrow the call and retry.`),
          ),
        );
        return keepStructured ? result : withoutStructured(result);
      }) as unknown as NonNullable<Parameters<RegisteredTool["update"]>[0]["callback"]>,
      ...(guidance && ALWAYS_LOAD.has(name) ? { _meta: { ...tool._meta, "anthropic/alwaysLoad": true } } : {}),
      paramsSchema: advertised(tool.inputSchema, "in"),
      ...(tool.outputSchema ? { outputSchema: advertised(tool.outputSchema, "out") } : {}),
    });
    if (!guidance) {
      // `update()` skips undefined values, so clearing takes an assignment.
      tool.title = undefined;
      tool.description = undefined;
    }
  }
}
