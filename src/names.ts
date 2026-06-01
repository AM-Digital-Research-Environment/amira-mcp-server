// Person-name matching that is order-independent and diacritic-insensitive.
//
// People are stored "Surname, Forename" (e.g. "Baumann, Oliver"), but users
// (and other systems) often write "Forename Surname" ("Oliver Baumann"). These
// helpers let a query in either order — and with or without accents/hyphens —
// match the stored form, so person search/lookup/filtering "just works".

/** Lowercase, accent-stripped, comma/dot/hyphen-split tokens of a name. */
export function nameTokens(name: string): string[] {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .toLowerCase()
    .replace(/[.,;'\-]/g, " ") // commas, dots, hyphens, apostrophes -> space
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Order-independent identity key — "Baumann, Oliver" and "Oliver Baumann" share it. */
export function nameKey(name: string): string {
  return [...nameTokens(name)].sort().join(" ");
}

/** True if two names denote the same person regardless of token order/accents. */
export function samePerson(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ka = nameKey(a);
  return ka.length > 0 && ka === nameKey(b);
}

/**
 * Fuzzy, order-independent match for search/filter: every token of `query` must
 * match a token of `candidate` (equal or prefix). So "Oliver Baumann",
 * "Baumann, Oliver", "Baumann" and "Oliver" all match "Baumann, Oliver".
 */
export function nameMatchesQuery(candidate: string | null | undefined, query: string): boolean {
  if (!candidate) return false;
  const ct = nameTokens(candidate);
  const qt = nameTokens(query);
  if (qt.length === 0 || ct.length === 0) return false;
  return qt.every((q) => ct.some((c) => c === q || c.startsWith(q)));
}
