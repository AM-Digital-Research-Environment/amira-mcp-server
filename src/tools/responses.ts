import type { WindowField } from "./textWindows.js";
import { exposureMessage } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
export type Server = import("@modelcontextprotocol/server").McpServer;

/** Maximum length of any single free-text field returned to the model. */
export const CHARACTER_LIMIT = 25000;

// --- result / annotation helpers --------------------------------------------

/**
 * Behaviour hints shared by every tool. The display name lives in the tool's own
 * `title` (hosts prefer it over `annotations.title`), so the annotations no
 * longer repeat it — that duplicate cost ~250 discovery tokens. The explicit
 * read-only/destructive/open-world hints stay: OpenAI's app review checks them.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Standard tool result: COMPACT JSON text (pretty-printing cost ~24% of every
 * response pre-1.0) plus structuredContent for structured-data clients. */
export function textResult(payload: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

/**
 * Uniform structured error (report §error-handling): `{ error: { code, message,
 * suggested_tool?, available_values? } }`. `code` is a stable machine token
 * (`not_found`, `invalid_id`, …); `message` stays human-readable.
 *
 * With AMIRA_GUIDANCE=off only `code` and a message survive: `terse` when the
 * message also gives advice (another tool to call, what to do next), which is
 * then the message minus that advice. A message that only says what was wrong
 * with the call needs no `terse`.
 */
export function errorResult(
  code: string,
  message: string,
  extra: { suggested_tool?: string; available_values?: unknown[]; terse?: string } = {},
): ReturnType<typeof textResult> & { isError: true } {
  if (!guidanceEnabled()) return { ...textResult({ error: { code, message: extra.terse ?? message } }), isError: true };
  const error: Record<string, unknown> = { code, message };
  if (extra.suggested_tool) error.suggested_tool = extra.suggested_tool;
  if (extra.available_values && extra.available_values.length) error.available_values = extra.available_values;
  return { ...textResult({ error }), isError: true };
}

/** Structured refusal when an opt-in text is hidden by the exposure level. */
export function textAccessDisabledResult(field: WindowField): ReturnType<typeof textResult> {
  return errorResult("text_access_disabled", `The ${field} is hidden at this exposure level. ${exposureMessage("full")}`);
}

/** Structured refusal for a whole tool/filter gated by the exposure level. */
export function exposureRestrictedResult(needs: "descriptive" | "structured" | "full", what: string): ReturnType<typeof textResult> {
  return errorResult("exposure_restricted", `${what} is not available: ${exposureMessage(needs)}`);
}

/** Render a typed query-layer error (src/researchItemQuery.ts QueryError). */
export function queryErrorResult(err: { code: string; message: string; needs?: "descriptive" | "structured" | "full" }) {
  return err.needs ? errorResult("exposure_restricted", `${err.message}: ${exposureMessage(err.needs)}`) : errorResult(err.code, err.message);
}
