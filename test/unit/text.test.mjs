// Folding primitives (src/text.ts): the accent-insensitive comparison every
// keyword filter is built on, its memoisation, and the offset guarantee
// matchSnippet relies on.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";

hermeticEnv();
const { clearFoldCache, fold, foldCached, foldedIndexOf } = await import("../../server/lib.js");

test("fold: lowercases and strips diacritics, both directions", () => {
  assert.equal(fold("Côte d'Ivoire"), "cote d'ivoire");
  assert.equal(fold("COTE D'IVOIRE"), "cote d'ivoire");
  assert.equal(fold("développement"), "developpement");
  assert.equal(fold("Ouagadougou"), "ouagadougou");
  // Non-Latin scripts are left alone apart from case.
  assert.equal(fold("العربية"), "العربية");
  assert.equal(fold(""), "");
});

test("fold: precomposed and decomposed spellings converge", () => {
  const precomposed = "Côte".normalize("NFC"); // "ô" as one code point
  const decomposed = "Côte".normalize("NFD"); // "o" + combining circumflex
  assert.notEqual(precomposed, decomposed, "the two encodings really do differ");
  assert.equal(fold(precomposed), "cote");
  assert.equal(fold(decomposed), "cote");
});

test("foldCached: memoises large texts and returns the same result as fold", () => {
  clearFoldCache();
  const big = "Développement régional en Côte d'Ivoire. ".repeat(200); // > 2000 chars
  assert.ok(big.length > 2000);
  const first = foldCached(big);
  const second = foldCached(big);
  assert.equal(first, fold(big));
  assert.equal(second, first);
  assert.ok(first.includes("cote d'ivoire"));

  // Short strings bypass the cache but must agree.
  assert.equal(foldCached("Côte"), fold("Côte"));
  clearFoldCache();
  assert.equal(foldCached(big), first, "result survives a cache clear");
});

test("foldedIndexOf: accent-insensitive offsets stay valid in the ORIGINAL string", () => {
  const text = "Rapport sur le développement régional publié à Abidjan.";
  const i = foldedIndexOf(text, "DEVELOPPEMENT"); // unaccented, uppercase query
  assert.ok(i > 0);
  // The offset must index the original text, not the folded copy.
  assert.equal(text.slice(i, i + "développement".length), "développement");
  assert.equal(foldedIndexOf(text, "abidjan"), text.indexOf("Abidjan"));
  assert.equal(foldedIndexOf(text, "absent-token"), -1);
});

test("foldedIndexOf: maps normalization length changes to original offsets", () => {
  // NFD input: folding contracts it, so a folded offset would slice the
  // original in the wrong place. The helper detects the length change and
  // maps the folded match back to the original.
  const decomposed = "prefix Côte d'Ivoire suffix".normalize("NFD");
  assert.notEqual(fold(decomposed).length, decomposed.length);
  const i = foldedIndexOf(decomposed, "d'Ivoire");
  assert.equal(decomposed.slice(i, i + 8), "d'Ivoire");
});

test("foldedIndexOf: sparse offsets survive balanced expansions, accents and cache invalidation", () => {
  const text = "각 café\u0301\u0301 tail 😀";
  assert.equal(fold(text).length, text.length);
  for (let i = 0; i < 2; i++) {
    assert.equal(foldedIndexOf(text, "cafe"), text.indexOf("café"));
    assert.equal(foldedIndexOf(text, "tail"), text.indexOf("tail"));
    assert.equal(foldedIndexOf(text, "😀"), text.indexOf("😀"));
    clearFoldCache();
  }
});
