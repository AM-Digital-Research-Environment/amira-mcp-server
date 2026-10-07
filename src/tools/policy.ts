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
import type { RegisteredTool } from "@modelcontextprotocol/server";
import { errorResult } from "./responses.js";

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
export function applyToolPolicy(tools: ToolMap, allowed: ReadonlySet<string> | null): void {
  for (const [name, tool] of Object.entries(tools)) {
    if (allowed && !allowed.has(name)) {
      tool.remove();
      continue;
    }
    const handler = tool.handler as (args: unknown, ctx: unknown) => unknown;
    const shape = (tool.inputSchema as unknown as { shape?: Shape } | undefined)?.shape;
    tool.update({
      callback: (async (args: unknown, ctx: unknown) => {
        const cleaned = cleanArgs(args, shape);
        if ("emptyRequired" in cleaned) {
          return withoutStructuredError(errorResult("invalid_argument", `\`${cleaned.emptyRequired}\` must not be empty.`));
        }
        return withoutStructuredError(await handler(cleaned.args, ctx));
      }) as unknown as NonNullable<Parameters<RegisteredTool["update"]>[0]["callback"]>,
      ...(ALWAYS_LOAD.has(name) ? { _meta: { ...tool._meta, "anthropic/alwaysLoad": true } } : {}),
    });
  }
}
