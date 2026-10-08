// Curatorial-guidance switch for evaluation ablations (AMIRA_GUIDANCE).
//
// The server carries the DRE's knowledge of its data as text: the server
// instructions, tool titles and descriptions, parameter descriptions, the
// advice in error messages (`suggested_tool`, `available_values`, "use
// resolve_entity…"), the paging hints, empty-result hints and near-miss
// suggestions in results, resource descriptions, the prompts and the companion
// skill. An evaluation's guidance-ablation condition (M−) runs the SAME
// operations with that text removed, so comparing it with the full server
// measures what the guidance contributes. Like AMIRA_EXPOSURE this is an
// experiment flag, not an end-user setting:
//
//   on    everything above (the default, identical to a build without the switch).
//   off   the same tools with the same names, input schemas, types, enums and
//         required fields, and the same data in results. No instructions, no
//         tool or resource titles and descriptions, no `.describe()` text in
//         the schemas, no `anthropic/alwaysLoad` entry-point hint. Errors keep
//         their stable `code` and a terse message saying what was wrong; the
//         pointer to another tool, the candidate values and the advice go.
//         Results drop `*_hint` fields, the export note, the empty-search
//         `hint`, person suggestions, and search_research_items' relaxation
//         `suggestions` and `did_you_mean`. Prompts and the companion skill
//         are not registered.
//
// Any value other than `off` means on; an unrecognised one is reported on
// stderr, because a typo would otherwise run the wrong condition silently.
//
// The tool list is built when a server is created and hosts cache it, so set
// the variable before the server starts: the surface is read once, results
// read it per call (as AMIRA_EXPOSURE does) and agree as long as it is left
// alone. The evaluation harness restarts the server for each condition.

let warned = false;

/** False only when AMIRA_GUIDANCE=off. */
export function guidanceEnabled(): boolean {
  const raw = process.env.AMIRA_GUIDANCE?.trim().toLowerCase();
  if (!raw || raw === "on") return true;
  if (raw === "off") return false;
  if (!warned) {
    warned = true;
    console.error(`[amira] ignoring AMIRA_GUIDANCE=${JSON.stringify(process.env.AMIRA_GUIDANCE)}; use on or off (guidance stays on).`);
  }
  return true;
}

// --- schema stripping ----------------------------------------------------------

type Json = Record<string, unknown>;

/** JSON Schema keywords whose value is one subschema. */
const ONE = ["items", "additionalProperties", "not", "contains", "propertyNames", "if", "then", "else",
  "unevaluatedItems", "unevaluatedProperties"];
/** Keywords whose value is an array of subschemas. */
const MANY = ["anyOf", "oneOf", "allOf", "prefixItems"];
/** Keywords whose value maps names to subschemas (a property CALLED "description" survives). */
const MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

/** A copy of a JSON Schema without `title`, `description` or `examples` at any depth. */
export function stripSchemaText(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(stripSchemaText); // `items` in its tuple form
  if (!schema || typeof schema !== "object") return schema;
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    if (key === "title" || key === "description" || key === "examples") continue;
    if (ONE.includes(key)) out[key] = stripSchemaText(value);
    else if (MANY.includes(key) && Array.isArray(value)) out[key] = value.map(stripSchemaText);
    else if (MAP.includes(key) && value && typeof value === "object") {
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([name, sub]) => [name, stripSchemaText(sub)]));
    } else out[key] = value;
  }
  return out;
}

type JsonSchemaFn = (opts: { target: string }) => Json;
interface StandardWithJson {
  "~standard": { validate: unknown; vendor: string; version: number; jsonSchema?: { input: JsonSchemaFn; output: JsonSchemaFn } };
}

/**
 * The same Standard Schema with its JSON Schema stripped of text. Validation is
 * the original schema's, so every call that worked still works; only what
 * `tools/list` advertises changes. The SDK reads `~standard.jsonSchema`.
 */
export function withoutSchemaText<T>(schema: T): T {
  const std = (schema as unknown as StandardWithJson | undefined)?.["~standard"];
  if (!std?.jsonSchema) return schema;
  const { input, output } = std.jsonSchema;
  return {
    "~standard": {
      ...std,
      jsonSchema: {
        input: (opts: { target: string }) => stripSchemaText(input(opts)),
        output: (opts: { target: string }) => stripSchemaText(output(opts)),
      },
    },
  } as unknown as T;
}
