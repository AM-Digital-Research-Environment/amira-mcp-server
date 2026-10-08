import { CHARACTER_LIMIT } from "./responses.js";
import { allowFullText } from "../exposure.js";
import { guidanceEnabled } from "../guidance.js";
// --- large-text windowing (transcripts, publication full text) ---------------
//
// One implementation behind get_podcast/get_video (`transcript`),
// get_publication (`fulltext`) and the ChatGPT `fetch` adapter, so the opt-in +
// offset/max paging contract can never drift between tools again (the v1.4.2
// lesson). Content is exposure-gated: under AMIRA_EXPOSURE below `full`, the
// existence flags stay but the text itself is reported as access-disabled.

export type WindowField = "transcript" | "fulltext";

export interface WindowOpts {
  include?: boolean;
  offset?: number;
  maxChars?: number;
  /**
   * Chars still available after the surrounding document body (the `fetch`
   * adapter, which wraps the window in a metadata header and then caps the
   * whole thing). Sizing the slice against what is LEFT keeps
   * `<field>_returned_chars` honest; capping the concatenation afterwards
   * trimmed the tail silently and made `offset + returned_chars` skip exactly
   * the header's worth of characters on the next page.
   */
  budget?: number;
}

/** Below this many free chars an appended window is not worth emitting. */
const MIN_WINDOW = 200;

function windowSlice(text: string, opts: WindowOpts): { slice: string; offset: number } {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const max = Math.max(
    1,
    Math.min(Math.floor(opts.maxChars ?? CHARACTER_LIMIT), CHARACTER_LIMIT, opts.budget ?? CHARACTER_LIMIT),
  );
  return { slice: text.slice(offset, offset + max), offset };
}

/**
 * Detail-tool shape: `has_<field>` + `<field>_length` always; the windowed text
 * plus offset/returned/truncated when opted in; a paging hint (or an
 * access-disabled marker under restricted exposure) when not. The hints are
 * guidance: AMIRA_GUIDANCE=off drops them, here and in textWindowAppend.
 */
export function textWindowFields(field: WindowField, text: string | null, opts: WindowOpts): Record<string, unknown> {
  const total = text?.length ?? 0;
  const has = total > 0;
  if (!allowFullText()) {
    return { [`has_${field}`]: has, [`${field}_length`]: total, ...(has ? { [`${field}_access`]: "disabled" } : {}) };
  }
  if (!opts.include) {
    return {
      [`has_${field}`]: has,
      [`${field}_length`]: total,
      ...(has && guidanceEnabled()
        ? { [`${field}_hint`]: `Set include_${field}=true for the text (page long ones with ${field}_offset / ${field}_max_chars).` }
        : {}),
    };
  }
  const { slice, offset } = windowSlice(text ?? "", opts);
  return {
    [`has_${field}`]: has,
    [field]: has ? slice : null,
    [`${field}_length`]: total,
    [`${field}_offset`]: offset,
    [`${field}_returned_chars`]: slice.length,
    [`${field}_truncated`]: offset + slice.length < total || undefined,
  };
}

/**
 * Fetch-adapter shape: the text to APPEND to the document body (or an omission
 * marker) plus the same paging metadata, mirroring textWindowFields.
 */
export function textWindowAppend(
  field: WindowField,
  label: string,
  text: string | null,
  opts: WindowOpts,
): { append: string | null; meta: Record<string, unknown> } {
  const total = text?.length ?? 0;
  const has = total > 0;
  if (!allowFullText()) {
    return {
      append: has ? `\n[${label} exists (${total} chars) but access is disabled by the server's exposure policy.]` : null,
      meta: { [`has_${field}`]: has, [`${field}_included`]: false, [`${field}_length`]: total, ...(has ? { [`${field}_access`]: "disabled" } : {}) },
    };
  }
  const guided = guidanceEnabled();
  if (!opts.include || !has) {
    return {
      append: !has
        ? null
        : guided
          ? `\n[${label} omitted (${total} chars) — call fetch again with include_${field}=true to append it (page long ones with ${field}_offset / ${field}_max_chars).]`
          : `\n[${label} omitted (${total} chars).]`,
      meta: {
        [`has_${field}`]: has,
        [`${field}_included`]: false,
        [`${field}_length`]: total,
        ...(has && guided
          ? { [`${field}_hint`]: `Set include_${field}=true to append the ${label.toLowerCase()} (page long ones with ${field}_offset / ${field}_max_chars).` }
          : {}),
      },
    };
  }
  // Asked for, but the document header already spent the caller's max_chars.
  // Say so rather than appending a slice that capText would then trim.
  if (opts.budget !== undefined && opts.budget < MIN_WINDOW) {
    return {
      append: guided
        ? `\n[${label} exists (${total} chars) but does not fit within max_chars — raise max_chars, or read it from the detail tool.]`
        : `\n[${label} exists (${total} chars) but does not fit within max_chars.]`,
      meta: {
        [`has_${field}`]: true,
        [`${field}_included`]: false,
        [`${field}_length`]: total,
        ...(guided ? { [`${field}_hint`]: `Raise max_chars (the record's metadata alone filled it) to append the ${label.toLowerCase()}.` } : {}),
      },
    };
  }
  const { slice, offset } = windowSlice(text ?? "", opts);
  return {
    append: `\n${label}:\n${slice}`,
    meta: {
      [`has_${field}`]: true,
      [`${field}_included`]: true,
      [`${field}_length`]: total,
      [`${field}_offset`]: offset,
      [`${field}_returned_chars`]: slice.length,
      [`${field}_truncated`]: offset + slice.length < total || undefined,
    },
  };
}
