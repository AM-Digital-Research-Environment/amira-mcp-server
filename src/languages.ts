// Language resolution over the Language authority corpus (item set 19).
//
// Omeka stores one canonical record per language ("French", code "fra") and
// items link to it, so the pre-1.0 fre/fra split is gone at source. What
// remains is QUERY-side aliasing: users type "fr", "fre", "français", "deu"…
// and should still hit the canonical record. The index is built from the
// snapshot's languages corpus plus a small static alias table.

import type { LanguageRec, LinkedRef } from "./types.js";
import { fold } from "./text.js";

/** Extra query tokens per canonical language name (lowercase). */
const EXTRA_ALIASES: Record<string, string[]> = {
  english: ["en"],
  french: ["fr", "fre", "francais", "français"],
  german: ["de", "ger", "deutsch"],
  portuguese: ["pt", "portugues", "português"],
  spanish: ["es", "espanol", "español"],
  arabic: ["ar"],
  swahili: ["sw", "kiswahili"],
  yoruba: ["yo"],
  hausa: ["ha"],
  igbo: ["ig"],
  twi: ["tw"],
  ewe: ["ee"],
  ga: ["gaa"],
  fanti: ["fante", "fat"],
  luganda: ["lg", "ganda"],
  mongolian: ["mn"],
  hebrew: ["he"],
  turkish: ["tr"],
  latin: ["la"],
  catalan: ["ca"],
  herero: ["hz"],
  sango: ["sg"],
  maasai: ["masai", "mas"],
  dholuo: ["luo"],
  samburu: ["saq"],
  "nigerian pidgin": ["pidgin", "naija", "pcm"],
  kru: ["kro"],
  acholi: ["ach"],
};

export class LanguageIndex {
  /** Folded token (name, code, alias) -> canonical name ("French"). Folding
   * (src/text.ts) makes the accented aliases below reachable unaccented too. */
  private readonly tokenToName = new Map<string, string>();
  readonly all: LanguageRec[];

  constructor(languages: LanguageRec[]) {
    this.all = languages;
    for (const lang of languages) {
      const canonical = lang.name;
      const tokens = [fold(lang.name), ...(lang.code ? [fold(lang.code)] : [])];
      for (const extra of EXTRA_ALIASES[fold(lang.name)] ?? []) tokens.push(fold(extra));
      for (const t of tokens) if (t) this.tokenToName.set(t, canonical);
    }
  }

  /** Canonical language name for a query token, or null if unknown. */
  resolve(query: string): string | null {
    return this.tokenToName.get(fold(query.trim())) ?? null;
  }

  /** True if any of the item's language refs denotes the queried language. */
  matches(refs: LinkedRef[] | undefined, query: string): boolean {
    if (!refs || refs.length === 0) return false;
    const canonical = this.resolve(query);
    const q = fold(query.trim());
    return refs.some((r) => (canonical != null && r.label === canonical) || fold(r.label) === q);
  }
}
