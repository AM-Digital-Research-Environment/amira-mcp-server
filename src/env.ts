// Environment readers: the one place a setting's raw string becomes a value.
//
// src/config.ts reads most settings once, at import. The experiment flags
// (AMIRA_EXPOSURE, AMIRA_GUIDANCE), AMIRA_SKILLS and AMIRA_TOOL_PROFILE are read
// per call instead, so a test or benchmark harness can change them between
// calls; they go through the same readers, so every setting gets the same
// placeholder guard and the same spellings.

/**
 * Whether `raw` is unset: empty, or an UNSUBSTITUTED MCPB template placeholder.
 *
 * `manifest.json` wires settings through `"AMIRA_SITE_BASE": "${user_config.site_base}"`.
 * When an optional setting has no value, the MCPB runtime passes the placeholder
 * through verbatim rather than dropping the variable — so the process really
 * does receive the literal string `${user_config.site_base}`. Taking that as a
 * site base made every citation `${user_config.site_base}/s/amira/item/<id>`:
 * reported in the wild against v1.7.0, and the reason this guard is central
 * rather than a special case in one resolver.
 */
export function isTemplatePlaceholder(raw: string | undefined): boolean {
  const v = raw?.trim();
  // Only a WHOLE-string ${...} counts: a real URL that merely contains braces
  // is a genuine setting, not an unsubstituted template.
  return !v || /^\$\{[^}]*\}$/.test(v);
}

/** Where settings are read from: `process.env` unless a caller passes another (tests). */
export type Env = Readonly<Record<string, string | undefined>>;

/** An env var, trimmed; undefined when unset, empty or an unsubstituted placeholder. */
export function envValue(name: string, env: Env = process.env): string | undefined {
  const raw = env[name]?.trim();
  return isTemplatePlaceholder(raw) ? undefined : raw;
}

const warned = new Set<string>();
/** Report an unrecognised value once per variable and value: a typo would
 * otherwise run with the default silently. Only for boolean and enum settings,
 * whose values are never secrets. */
function warnOnce(name: string, raw: string, expected: string, fallback: string): void {
  const key = `${name}=${raw}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.error(`[amira] ignoring ${name}=${JSON.stringify(raw)}; use ${expected} (using ${fallback}).`);
}

const TRUE = ["1", "true", "yes", "on"];
const FALSE = ["0", "false", "no", "off"];

/** A boolean setting: 1/true/yes/on or 0/false/no/off, case-insensitive. Unset
 * means `fallback`; anything else is reported once and means `fallback`. */
export function bool(name: string, fallback: boolean, env: Env = process.env): boolean {
  const raw = envValue(name, env);
  if (raw === undefined) return fallback;
  const s = raw.toLowerCase();
  if (TRUE.includes(s)) return true;
  if (FALSE.includes(s)) return false;
  warnOnce(name, raw, "on or off", fallback ? "on" : "off");
  return fallback;
}

/** One of `values` (case-insensitive). Unset means `fallback`; anything else is
 * reported once and means `fallback`. */
export function enumOf<T extends string>(name: string, values: readonly T[], fallback: T, env: Env = process.env): T {
  const raw = envValue(name, env);
  if (raw === undefined) return fallback;
  const s = raw.toLowerCase();
  if ((values as readonly string[]).includes(s)) return s as T;
  warnOnce(name, raw, values.join(", "), fallback);
  return fallback;
}

/** A non-negative number (fractions allowed). Unset or invalid means `fallback`. */
export function nonNegative(name: string, fallback: number, env: Env = process.env): number {
  const raw = envValue(name, env);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
