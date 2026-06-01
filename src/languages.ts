// Language code/name resolution.
//
// The source data mixes ISO 639-2 *bibliographic* (/B) and *terminological* (/T)
// codes plus a few bare names — most importantly French is split across BOTH
// "fre" (639-2/B) and "fra" (639-2/T), and German could appear as "ger" or "deu".
// A naive exact-code filter therefore under-counts. We resolve a user's query
// (a language name, a 639-1 code, or either 639-2 variant) to the full set of
// equivalent tokens, so `language="French"` (or "fr"/"fra"/"fre") matches every
// French item regardless of which code it carries.

interface LangGroup {
  label: string;
  tokens: string[]; // names + 639-1 + 639-2 B/T, all lowercase
}

// Keyed by a canonical token. Covers the languages actually present in the data
// plus common English/native names and 639-1 codes for them.
const LANG_GROUPS: Record<string, LangGroup> = {
  eng: { label: "English", tokens: ["english", "en", "eng"] },
  fra: { label: "French", tokens: ["french", "francais", "français", "fr", "fra", "fre"] },
  ger: { label: "German", tokens: ["german", "deutsch", "de", "ger", "deu"] },
  por: { label: "Portuguese", tokens: ["portuguese", "portugues", "português", "pt", "por"] },
  spa: { label: "Spanish", tokens: ["spanish", "espanol", "español", "es", "spa"] },
  ara: { label: "Arabic", tokens: ["arabic", "ar", "ara"] },
  swa: { label: "Swahili", tokens: ["swahili", "kiswahili", "sw", "swa"] },
  yor: { label: "Yoruba", tokens: ["yoruba", "yor"] },
  hau: { label: "Hausa", tokens: ["hausa", "ha", "hau"] },
  ibo: { label: "Igbo", tokens: ["igbo", "ig", "ibo"] },
  twi: { label: "Twi", tokens: ["twi", "tw"] },
  aka: { label: "Akan", tokens: ["akan", "ak", "aka"] },
  ewe: { label: "Ewe", tokens: ["ewe", "ee"] },
  gaa: { label: "Ga", tokens: ["ga", "gaa"] },
  fat: { label: "Fante", tokens: ["fante", "fanti", "fat"] },
  lug: { label: "Luganda", tokens: ["luganda", "ganda", "lg", "lug"] },
  mon: { label: "Mongolian", tokens: ["mongolian", "mn", "mon"] },
  heb: { label: "Hebrew", tokens: ["hebrew", "he", "heb"] },
  tur: { label: "Turkish", tokens: ["turkish", "tr", "tur"] },
  lat: { label: "Latin", tokens: ["latin", "la", "lat"] },
  cat: { label: "Catalan", tokens: ["catalan", "ca", "cat"] },
  her: { label: "Herero", tokens: ["herero", "hz", "her"] },
  sag: { label: "Sango", tokens: ["sango", "sg", "sag"] },
  kru: { label: "Kru", tokens: ["kru", "kro"] },
  luo: { label: "Luo (Dholuo)", tokens: ["luo", "dholuo"] },
  saq: { label: "Samburu", tokens: ["samburu", "saq"] },
  ach: { label: "Acholi", tokens: ["acholi", "ach"] },
  pcm: { label: "Nigerian Pidgin", tokens: ["nigerian pidgin", "pidgin", "naija", "pcm"] },
};

const TOKEN_TO_KEY = new Map<string, string>();
for (const [key, group] of Object.entries(LANG_GROUPS)) {
  TOKEN_TO_KEY.set(key.toLowerCase(), key);
  for (const t of group.tokens) TOKEN_TO_KEY.set(t.toLowerCase(), key);
}

/** Human-readable label for a language code/name, or null if unknown. */
export function languageLabel(code: string): string | null {
  const key = TOKEN_TO_KEY.get(code.trim().toLowerCase());
  const group = key ? LANG_GROUPS[key] : undefined;
  return group ? group.label : null;
}

/** Every acceptable lowercase token for a query (its full group, or just itself). */
export function resolveLanguageTokens(query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const key = TOKEN_TO_KEY.get(q);
  const group = key ? LANG_GROUPS[key] : undefined;
  if (key && group) return new Set([key.toLowerCase(), ...group.tokens.map((t) => t.toLowerCase())]);
  return new Set([q]);
}

/** True if any of an item's language codes belongs to the query's language group. */
export function languageMatches(itemLanguages: string[] | undefined, query: string): boolean {
  if (!itemLanguages || itemLanguages.length === 0) return false;
  const set = resolveLanguageTokens(query);
  return itemLanguages.some((l) => set.has(l.trim().toLowerCase()));
}
