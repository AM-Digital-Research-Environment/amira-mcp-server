// Pure matching helpers behind the 1.19 correctness fixes: typographic folding,
// keyword parsing, place aliases, typed ids, BibTeX escaping, authority ids and
// the central argument policy. No server, no snapshot.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";

hermeticEnv();
const lib = await import("../../server/lib.js");

test("fold maps curly quotes, dashes, spaces and ligatures to their plain forms", () => {
  assert.equal(lib.fold("Sankara’s Agenda"), lib.fold("Sankara's Agenda"));
  assert.equal(lib.fold("“Opera” — music"), '"opera" - music');
  assert.equal(lib.fold("œuvre"), "oeuvre");
  assert.equal(lib.fold("Straße"), "strasse");
  assert.equal(lib.fold("a b"), "a b");
  // Offsets stay exact through width changes (ß → ss) and decomposed accents.
  const text = "Die Straße von Côte d’Ivoire";
  const [match] = lib.foldedMatches(text, "d'ivoire").ranges;
  assert.equal(text.slice(match.start, match.end), "d’Ivoire");
  const [sharp] = lib.foldedMatches(text, "strasse").ranges;
  assert.equal(text.slice(sharp.start, sharp.end), "Straße");
});

test("foldedMatches pages every match and reports the total", () => {
  const text = "ab ".repeat(2500);
  const all = lib.foldedMatches(text, "ab", { take: 0 });
  assert.equal(all.total, 2500);
  assert.equal(all.capped, false);
  const page = lib.foldedMatches(text, "ab", { skip: 2000, take: 3 });
  assert.deepEqual(page.ranges.map((r) => r.start), [6000, 6003, 6006]);
  assert.equal(lib.foldedMatches(text, "ab", { cap: 10 }).capped, true);
});

test("keyword queries: words AND-match, quotes stay literal, stopwords drop", () => {
  assert.deepEqual(lib.parseKeyword("Kunst und Architektur"), { phrases: [], terms: ["kunst", "architektur"] });
  assert.deepEqual(lib.parseKeyword('"wall painting" Lagos'), { phrases: ["wall painting"], terms: ["lagos"] });
  assert.deepEqual(lib.parseKeyword("die"), { phrases: ["die"], terms: [] }, "an all-stopword query falls back to the literal");
  const q = lib.parseKeyword("Yoruba wall");
  assert.equal(lib.keywordMatches(q, ["Yoruba Architecture", "wall painting"]), true, "words may sit in different fields");
  assert.equal(lib.keywordMatches(q, ["Yoruba Architecture"]), false);
  assert.ok(lib.tokenize("o livro da história").every((t) => !["da", "o"].includes(t)), "Portuguese stopwords");
});

test("place aliases and word-prefix matching never reach a different country", () => {
  assert.ok(lib.placeAliases("Côte d'Ivoire").has("ivory coast"));
  assert.ok(lib.placeAliases("ivory coast").has("cote d'ivoire"));
  assert.ok(lib.placeAliases("congo").has("democratic republic of the congo"));
  assert.ok(lib.placeAliases("congo").has("republic of the congo"));
  assert.ok(!lib.placeAliases("Niger").has("nigeria"));
  assert.equal(lib.wordPrefixMatch("Ibadan", "Ibad"), true);
  assert.equal(lib.wordPrefixMatch("Dar es Salaam", "dar es"), true);
  assert.equal(lib.wordPrefixMatch("Papua New Guinea", "uinea"), false, "never mid-word");
});

test("typed ids: both vocabularies parse to one canonical form", () => {
  assert.deepEqual(lib.parseTypedId("item:7392"), { kind: "research_item", key: "7392" });
  assert.deepEqual(lib.parseTypedId("pub:29919"), { kind: "publication", key: "29919" });
  assert.equal(lib.canonicalTypedId("research_section:218"), "section:218");
  assert.equal(lib.canonicalTypedId("institution:1224"), "organisation:1224");
  assert.equal(lib.parseTypedId("7392"), null);
  assert.equal(lib.stripTypedId("project:37700", ["project"]), "37700");
  assert.equal(lib.stripTypedId("person:5", ["project"]), "person:5", "a foreign prefix is left alone");
});

test("BibTeX escapes LaTeX specials in field text", () => {
  assert.equal(lib.escBibtex("Opera & Music {Theatre} 100% #1 Bio_Ökonomie $5 a~b x^2"),
    "Opera \\& Music Theatre 100\\% \\#1 Bio\\_Ökonomie \\$5 a\\textasciitilde{}b x\\textasciicircum{}2");
});

test("authority identifiers are classified by scheme", () => {
  const item = { "dcterms:identifier": [
    { type: "uri", "@id": "https://d-nb.info/gnd/124120881", "o:label": "GND 124120881" },
    { type: "uri", "@id": "https://orcid.org/0000-0003-0959-2092" },
    { type: "uri", "@id": "http://www.wikidata.org/entity/Q1033" },
    { type: "uri", "@id": "http://id.loc.gov/authorities/subjects/sh00002539" },
    { type: "uri", "@id": "https://example.org/x/1", "o:label": "local" },
  ] };
  assert.deepEqual(lib.authorityIds(item, "dcterms:identifier").map((a) => [a.scheme, a.id]), [
    ["gnd", "124120881"], ["orcid", "0000-0003-0959-2092"], ["wikidata", "Q1033"], ["lcsh", "sh00002539"], ["example.org", "local"],
  ]);
});

test("argument policy trims strings, drops empty optionals and names empty required ones", () => {
  const shape = { id: { safeParse: (v) => ({ success: v !== undefined }) }, keyword: { safeParse: () => ({ success: true }) } };
  assert.deepEqual(lib.cleanArgs({ id: " 7 ", keyword: "  ", filters: { subject: " Islam ", country: " " }, ids: [" a ", ""] }, shape),
    { args: { id: "7", filters: { subject: "Islam" }, ids: ["a"] } });
  assert.deepEqual(lib.cleanArgs({ id: "  " }, shape), { emptyRequired: "id" });
});

test("instructions fit Claude Code's 2,048-character limit and lead with the citation rules", () => {
  assert.ok(lib.INSTRUCTIONS.length <= 2048, `${lib.INSTRUCTIONS.length} characters`);
  assert.match(lib.INSTRUCTIONS, /^CITATIONS/);
  for (const rule of ["amira_url", "never invent", "legacy DRE identifiers", "Surname, Forename", "not proof of absence"]) {
    assert.ok(lib.INSTRUCTIONS.includes(rule), rule);
  }
});
