// Property-based tests (fast-check) for three invariants whose failure modes
// hide in inputs nobody writes by hand:
//
//   1. accent folding and ORIGINAL-string offsets (src/text.ts): decomposed
//      accents shrink under folding, ligatures and ß grow, emoji are surrogate
//      pairs — and the two offset implementations (the sparse shift index of
//      foldedMatches and the per-character map of foldedRanges) must agree;
//   2. pagination: walking next_offset never skips or repeats a record and
//      stops exactly at total_matches, whatever the limit, the start offset or
//      the 40,000-character page budget does to a page;
//   3. citation exports stay well-formed for any title or name: BibTeX braces
//      balance and LaTeX specials are escaped, RIS keeps one tag per line,
//      CSL-JSON round-trips.
//
// Runs are kept modest so the file stays well under five seconds.
import test from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { buildFixture } from "../fixtures/fixture-data.mjs";
import { hermeticEnv } from "../helpers/env.mjs";
import { connectInMemory } from "../helpers/mcp.mjs";

const { dataDir } = hermeticEnv({ dataDir: true });
const lib = await import("../../server/lib.js");

// --- 1. folding and offsets ---------------------------------------------------

/** Building blocks: ASCII, precomposed and decomposed accents, typographic
 * quotes and dashes, ligatures and ß (which expand), surrogate pairs, plus a
 * few NFD expansions outside Latin (Hangul, Devanagari nukta). */
const FRAGMENTS = [
  "a", "e", "o", "s", "c", "i", "E", "O", "S", "x", "z", " ", " ", "'", '"', "-", ".", ",", "1", "oe",
  "é", "è", "ê", "ô", "ç", "É", "Ç", "ñ", "ü", "Å", "İ", "ı",
  "e\u0301", "E\u0301", "o\u0302", "c\u0327", "a\u0300", "u\u0308\u0304", "\u0301", "\u0323",
  "’", "‘", "“", "”", "«", "»", "´", "`", "–", "—", "‐", "−", "\u00a0", "\u202f",
  "œ", "Œ", "æ", "Æ", "ß", "ẞ",
  "😀", "👍🏽", "𝔸", "🇨🇮",
  "한", "\u0958",
];
const fragmentList = fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 40 });
/** Long haystacks take the memoised fold path (foldCached, >= 2000 chars). */
const haystack = fc.tuple(fragmentList, fc.boolean()).map(([parts, long]) => {
  const s = parts.join("");
  return long && s ? s.repeat(Math.ceil(2100 / s.length)) : s;
});
const VARIANTS = [(s) => s, (s) => lib.fold(s), (s) => s.toUpperCase(), (s) => s.normalize("NFD"), (s) => s.normalize("NFC")];
/** Needles cut from the same fragments (so they usually match), recased,
 * pre-folded or renormalised; or free fragments that may match nothing. */
const textAndNeedle = fc.oneof(
  fc.tuple(fragmentList.filter((p) => p.length > 0), fc.nat(), fc.nat({ max: 6 }), fc.nat({ max: VARIANTS.length - 1 }), fc.boolean())
    .map(([parts, from, span, variant, long]) => {
      const start = from % parts.length;
      const needle = VARIANTS[variant](parts.slice(start, start + 1 + span).join(""));
      const s = parts.join("");
      return { text: long ? s.repeat(Math.ceil(2100 / s.length)) : s, needle };
    }),
  fc.tuple(haystack, fc.array(fc.constantFrom(...FRAGMENTS), { minLength: 1, maxLength: 4 }))
    .map(([text, parts]) => ({ text, needle: parts.join("") })),
);

const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;
/** A character whose fold is longer than one unit (œ → oe, ß → ss, 한 → 3 jamo). */
const expands = (ch) => lib.fold(ch).length > 1;
const COMBINING = /^[\u0300-\u036f]$/;
/** An expanding character carrying a combining mark ("œ\u0301"): the one shape
 * on which foldedRanges and foldedMatches disagree (todo test below). */
const markedExpansion = (text) => {
  const chars = [...text];
  return chars.some((ch, i) => expands(ch) && COMBINING.test(chars[i + 1] ?? ""));
};

test("property: foldedMatches and foldedRanges agree, and every range folds back to the needle", () => {
  fc.assert(fc.property(textAndNeedle, ({ text, needle }) => {
    const q = lib.fold(needle);
    fc.pre(q.length > 0);
    const matches = lib.foldedMatches(text, needle);
    const ranges = matches.ranges;
    assert.deepEqual(lib.foldedRanges(text, needle, Number.MAX_SAFE_INTEGER), ranges);
    assert.equal(matches.total, ranges.length);
    assert.equal(matches.capped, false);
    assert.equal(lib.foldedIndexOf(text, needle), ranges.length ? ranges[0].start : -1);
    // Non-overlapping occurrences of q in the folded text, counted directly.
    const folded = lib.fold(text);
    let count = 0;
    for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + q.length)) count++;
    assert.equal(ranges.length, count);

    let previousStart = 0, previousEnd = 0;
    for (const { start, end } of ranges) {
      assert.ok(start >= previousStart && end >= previousEnd && start < end && end <= text.length,
        JSON.stringify({ start, end, previousStart, previousEnd }));
      if (start < previousEnd) {
        // Matches are disjoint in FOLDED text; in the original they can share
        // only one expanding character that a boundary cut ("ẞS" + "ss":
        // ẞ→ss, so consecutive matches meet inside the ẞ). Nothing else.
        const shared = text.slice(start, previousEnd);
        const first = [...shared][0];
        assert.ok(expands(first) && lib.fold(shared) === lib.fold(first), `overlap ${JSON.stringify(shared)}`);
      }
      previousStart = start;
      previousEnd = end;
      // Never split a surrogate pair, never strand a combining mark.
      assert.ok(!isLow(text.charCodeAt(start)) || !isHigh(text.charCodeAt(start - 1)), "start inside a pair");
      assert.ok(!isLow(text.charCodeAt(end)) || !isHigh(text.charCodeAt(end - 1)), "end inside a pair");
      assert.ok(!COMBINING.test(text[end] ?? ""), `range ${start}-${end} leaves a mark behind`);
      const slice = text.slice(start, end);
      const back = lib.fold(slice);
      if (back !== q) {
        // Only an expanding character cut by the match boundary may add
        // folded text around the needle ("o" inside "œ" returns "œ").
        assert.ok(back.includes(q), `${JSON.stringify(slice)} folds to ${JSON.stringify(back)}, not ${JSON.stringify(q)}`);
        const chars = [...slice.replace(/[\u0300-\u036f]+$/, "")]; // the last BASE character
        assert.ok(expands(chars[0]) || expands(chars.at(-1)), `${JSON.stringify(slice)} folds to ${JSON.stringify(back)}`);
      }
    }
  }), { numRuns: 400 });
});

test("property: a needle cut from the text (as typed, folded or NFD) is always found", () => {
  const cut = fc.tuple(fragmentList.filter((p) => p.length > 0), fc.nat(), fc.nat({ max: 6 }), fc.constantFrom(0, 1, 3))
    .map(([parts, from, span, variant]) => {
      const start = from % parts.length;
      return { text: parts.join(""), needle: VARIANTS[variant](parts.slice(start, start + 1 + span).join("")) };
    });
  fc.assert(fc.property(cut, ({ text, needle }) => {
    fc.pre(lib.fold(needle).length > 0);
    assert.notEqual(lib.foldedIndexOf(text, needle), -1, JSON.stringify({ text, needle }));
    assert.ok(lib.foldedMatches(text, needle).total >= 1);
  }), { numRuns: 200 });
});

test("property: foldedMatches skip/take and foldedRanges limit/from are windows on their full match lists", () => {
  fc.assert(fc.property(textAndNeedle, fc.nat({ max: 8 }), fc.integer({ min: 1, max: 8 }), fc.nat({ max: 60 }),
    ({ text, needle }, skip, take, from) => {
      fc.pre(lib.fold(needle).length > 0);
      const all = lib.foldedMatches(text, needle).ranges;
      const page = lib.foldedMatches(text, needle, { skip, take });
      assert.equal(page.total, all.length);
      assert.deepEqual(page.ranges, all.slice(skip, skip + take));
      const ranges = lib.foldedRanges(text, needle, Number.MAX_SAFE_INTEGER);
      assert.deepEqual(lib.foldedRanges(text, needle, take, from), ranges.filter((r) => r.start >= from).slice(0, take));
      const capped = lib.foldedMatches(text, needle, { cap: 2 });
      assert.equal(capped.capped, all.length >= 2);
      assert.equal(capped.total, Math.min(all.length, 2));
    }), { numRuns: 200 });
});

test("foldedRanges agrees with foldedMatches when an expanding character carries a combining mark", {
  // Fixed in 1.19: foldedRanges extends every unit of an expanded letter over a following mark.
}, () => {
  // "œ" + U+0301 folds to "oe"; a match on its "o" half:
  assert.deepEqual(lib.foldedMatches("œ\u0301", "o").ranges, [{ start: 0, end: 2 }]);
  assert.deepEqual(lib.foldedRanges("œ\u0301", "o", 10), [{ start: 0, end: 2 }]); // actual: end 1, stranding the mark
  assert.deepEqual(lib.foldedRanges("ß\u0301x", "s", 10), lib.foldedMatches("ß\u0301x", "s").ranges);
});

test("fold is invariant under Unicode normalization (NFC vs NFD)", {
  // Fixed in 1.19: the typographic map runs again after NFD.
}, () => {
  assert.equal(lib.fold("Ǽ"), lib.fold("Æ\u0301")); // "Ǽ": actual "æ" vs "ae"
  assert.notEqual(lib.foldedIndexOf("Ǽlfric", "Ælfric"), -1); // "Ælfric" misses "Ǽlfric"
  fc.assert(fc.property(fragmentList, (parts) => {
    const s = parts.join("");
    assert.equal(lib.fold(s.normalize("NFC")), lib.fold(s.normalize("NFD")));
  }), { numRuns: 200 });
});

// --- 2. pagination ------------------------------------------------------------

// The shared fixture plus synthetic records: enough of them for many pages, a
// third with ~2,000-character titles so a large page hits PAGE_CHAR_BUDGET
// (response_limited), duplicate publication titles and years so ordering ties
// fall through to the id tiebreak, and subject counts that tie.
const fixture = buildFixture(lib.SNAPSHOT_SCHEMA_VERSION);
const itemTemplate = fixture.data.research_items.find((it) => it.o_id === 502);
const pubTemplate = fixture.data.publications.find((p) => p.o_id === 511);
const filler = (i) => (i % 3 === 0 ? ` ${"long-title-padding ".repeat(110)}` : "");
for (let i = 0; i < 120; i++) {
  const subjects = [...new Set([i % 40, (i * 7) % 40])].map((j) => ({ label: `Synthetic subject ${j}`, o_id: 20000 + j }));
  fixture.data.research_items.push({
    ...structuredClone(itemTemplate), o_id: 10000 + i, dre_id: `syn-${i}`,
    title: `Synthetic study ${i}${filler(i)}`, subjects, description: `Pagination-token record ${i}.`,
  });
}
for (let j = 0; j < 40; j++) fixture.data.subjects.push({ o_id: 20000 + j, name: `Synthetic subject ${j}`, vocabulary: "Tag", uri: null });
for (let i = 0; i < 90; i++) {
  fixture.data.publications.push({
    ...structuredClone(pubTemplate), o_id: 30000 + i, pub_id: `syn-pub-${i}`,
    title: `Synthetic paper ${i % 30}${filler(i)}`, year: 2000 + (i % 5), date: String(2000 + (i % 5)),
    abstract: "pagination-token abstract", urls: [`https://eref.uni-bayreuth.de/id/eprint/${30000 + i}/`],
  });
}
fixture.manifest.counts = Object.fromEntries(Object.entries(fixture.data).map(([k, v]) => [k, v.length]));
await lib.writeSnapshot(dataDir, fixture);

const conn = await connectInMemory(lib, {}, { name: "properties" });
test.after(() => conn.close());

const PAGED = {
  search_research_items: {
    max: 100,
    key: (r) => r.omeka_id,
    queries: [{}, { keyword: "pagination-token" }, { keyword: "synthetic study" }, { subject: "Synthetic subject 1" }, { keyword: "no-such-token" }],
  },
  search_publications: {
    max: 100,
    key: (r) => r.omeka_id,
    queries: [{}, { keyword: "synthetic paper" }, { keyword: "pagination-token" }, { year_from: 2002, year_to: 2003 }],
  },
  list_subjects: {
    max: 300,
    key: (r) => r.omeka_id ?? r.name,
    queries: [{}, { keyword: "synthetic" }, { keyword: "subject 1" }, { vocabulary: "lcsh" }],
  },
};

/** Ground truth per (tool, query): single-record pages, which no character
 * budget can cut short. */
const reference = new Map();
async function referenceIds(tool, query) {
  const cacheKey = `${tool}:${JSON.stringify(query)}`;
  if (!reference.has(cacheKey)) {
    const ids = [];
    let total;
    for (let offset = 0; ; offset++) {
      const page = await conn.call(tool, { ...query, limit: 1, offset });
      assert.equal(page.isError, undefined, JSON.stringify(page));
      total ??= page.total_matches;
      ids.push(...page.results.map(PAGED[tool].key));
      if (!page.has_more) break;
    }
    assert.equal(ids.length, total, `${cacheKey}: single-record walk reaches total_matches`);
    assert.equal(new Set(ids).size, ids.length, `${cacheKey}: ground truth has no duplicates`);
    reference.set(cacheKey, ids);
  }
  return reference.get(cacheKey);
}

test("the pagination fixture exercises multi-page walks and the character budget", async () => {
  const items = await conn.call("search_research_items", { limit: 100 });
  assert.ok(items.total_matches > 100);
  assert.equal(items.response_limited, true, "a 100-item page of long titles is cut by PAGE_CHAR_BUDGET");
  assert.equal(items.next_offset, items.count);
  const pubs = await conn.call("search_publications", { limit: 100 });
  assert.equal(pubs.response_limited, true);
  const subjects = await conn.call("list_subjects", { limit: 300 });
  assert.ok(subjects.total_matches > 40);
});

for (const [tool, spec] of Object.entries(PAGED)) {
  test(`property: ${tool} pages following next_offset never skip or repeat and stop at total_matches`, async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(...spec.queries),
      fc.oneof(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: spec.max + 50 })),
      fc.oneof(fc.constant(0), fc.nat({ max: 140 })),
      async (query, limit, start) => {
        const truth = await referenceIds(tool, query);
        const effective = Math.min(limit, spec.max);
        const seen = [];
        let offset = start;
        for (let pages = 0; ; pages++) {
          assert.ok(pages <= truth.length + 1, "walk terminates");
          const page = await conn.call(tool, { ...query, limit, offset });
          assert.equal(page.isError, undefined);
          assert.equal(page.total_matches, truth.length);
          assert.equal(page.offset, offset);
          assert.equal(page.count, page.results.length);
          assert.ok(page.results.length <= effective);
          if (offset < truth.length) assert.ok(page.results.length > 0, "a page before the end makes progress");
          if (!page.response_limited && offset < truth.length) {
            assert.equal(page.results.length, Math.min(effective, truth.length - offset), "a full page unless budget-limited");
          }
          if (limit > spec.max) assert.equal(page.effective_limit, spec.max);
          seen.push(...page.results.map(spec.key));
          assert.equal(page.has_more, offset + page.results.length < truth.length);
          if (!page.has_more) {
            assert.equal(page.next_offset, undefined);
            break;
          }
          assert.equal(page.next_offset, offset + page.results.length);
          offset = page.next_offset;
        }
        assert.deepEqual(seen, truth.slice(start), "pages concatenate to exactly the records from `start`");
      },
    ), { numRuns: 60 });
  });
}

// --- 3. citation well-formedness ------------------------------------------------

const LATEX = ["&", "%", "$", "#", "_", "{", "}", "~", "^", "\\"];
const fieldText = fc.string({
  unit: fc.constantFrom(..."abcXYZ019 ,.;:'\"@=-()é’—œ", ...LATEX, "\n", "\r", "\r\n", "\t"),
  minLength: 1, maxLength: 30,
});
const nameText = fc.oneof(fieldText, fc.tuple(fieldText, fieldText).map(([family, given]) => `${family}, ${given}`));

const basePub = structuredClone(buildFixture(lib.SNAPSHOT_SCHEMA_VERSION).data.publications.find((p) => p.o_id === 510));
const publication = fc.record({
  type: fc.constantFrom("article", "book", "chapter", "doctoral_thesis", "working_paper", "habilitation", "unknown_type"),
  title: fieldText,
  authors: fc.array(nameText, { maxLength: 3 }),
  editors: fc.array(nameText, { maxLength: 2 }),
  venue: fc.option(fieldText, { nil: null }),
  publisher: fc.option(fieldText, { nil: null }),
  volume: fc.option(fieldText, { nil: null }),
  pages: fc.option(fc.oneof(fieldText, fc.constant("12–34")), { nil: null }),
  doi: fc.option(fc.oneof(fc.constant("https://doi.org/10.1000/a_b%c#d"), fieldText), { nil: null }),
  series: fc.option(fc.array(fieldText, { minLength: 1, maxLength: 2 }), { nil: undefined }),
  subjects: fc.array(fieldText, { maxLength: 2 }),
  places: fc.array(fieldText, { maxLength: 2 }),
}).map((r) => ({
  ...basePub,
  type: r.type, title: r.title, venue: r.venue, publisher: r.publisher, volume: r.volume, pages: r.pages, doi: r.doi,
  ...(r.series ? { series: r.series } : {}),
  authors: r.authors.map((label, i) => ({ label, o_id: i ? null : 100 })),
  editors: r.editors.map((label) => ({ label, o_id: null })),
  subjects: r.subjects.map((label) => ({ label, o_id: null })),
  places_of_publication: r.places.map((label) => ({ label, o_id: null })),
}));

/** Parse `@type{key,\n  name = {value},\n ...\n}` with brace-depth tracking. */
function parseBibtex(entry) {
  const head = entry.match(/^@([a-z]+)\{([^,{}\s]+),\n/);
  assert.ok(head, `entry header: ${JSON.stringify(entry.slice(0, 40))}`);
  const fields = [];
  let i = head[0].length;
  for (;;) {
    const m = /^ {2}([a-z]+) = \{/.exec(entry.slice(i));
    assert.ok(m, `field at ${i}: ${JSON.stringify(entry.slice(i, i + 40))}`);
    i += m[0].length;
    let depth = 1;
    const start = i;
    for (; depth > 0; i++) {
      assert.ok(i < entry.length, "unterminated field");
      if (entry[i] === "{") depth++;
      else if (entry[i] === "}") depth--;
    }
    fields.push([m[1], entry.slice(start, i - 1)]);
    if (entry.slice(i) === "\n}") return { type: head[1], key: head[2], fields };
    assert.equal(entry.slice(i, i + 2), ",\n", "fields are comma-separated");
    i += 2;
  }
}

/** A value with every legitimate escape removed must hold no raw special. */
const ESCAPES = /\\textbackslash\{\}|\\textasciitilde\{\}|\\textasciicircum\{\}|\\[&%$#_]/g;

test("property: publication BibTeX balances braces and escapes every LaTeX special outside url/doi", () => {
  fc.assert(fc.property(publication, (pub) => {
    const bib = lib.publicationBibtex(pub);
    assert.equal(lib.publicationCitation(pub, "bibtex").export, bib);
    let depth = 0;
    for (const ch of bib) {
      depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
      assert.ok(depth >= 0, "brace depth never negative");
    }
    assert.equal(depth, 0, "braces balance");
    const { key, fields } = parseBibtex(bib);
    assert.equal(key, pub.pub_id);
    const names = fields.map(([name]) => name);
    assert.equal(new Set(names).size, names.length, "no duplicate fields");
    assert.ok(names.includes("title"));
    for (const [name, value] of fields) {
      if (name === "url" || name === "doi") {
        assert.doesNotMatch(value, /[{}]/, `${name} is raw but brace-free`);
        continue;
      }
      let rest = value.replace(ESCAPES, "");
      // Author/editor lists brace-protect whole corporate names: {Name} and {Other}.
      if (name === "author" || name === "editor") rest = rest.split(" and ").map((n) => n.replace(/^\{([^{}]*)\}$/, "$1")).join(" and ");
      assert.doesNotMatch(rest, /[\\&%$#_~^{}]/, `${name} = {${value}}`);
    }
  }), { numRuns: 200 });
});

test("property: publication RIS has one TY, one closing ER and no value spanning lines", () => {
  fc.assert(fc.property(publication, (pub) => {
    const { field, export: ris } = lib.publicationCitation(pub, "ris");
    assert.equal(field, "ris");
    assert.doesNotMatch(ris, /\r/);
    const lines = ris.split("\n");
    assert.equal(lines.filter((l) => l.startsWith("TY  - ")).length, 1);
    assert.ok(lines[0].startsWith("TY  - "));
    assert.equal(lines.filter((l) => l.startsWith("ER  - ")).length, 1);
    assert.equal(lines.at(-1), "ER  - ");
    for (const line of lines) assert.match(line, /^[A-Z][A-Z0-9] {2}- /, JSON.stringify(line));
    const flat = (s) => s.replace(/[\r\n]+/g, " ");
    assert.deepEqual(lines.filter((l) => l.startsWith("TI  - ")), [`TI  - ${flat(pub.title)}`]);
    assert.deepEqual(lines.filter((l) => l.startsWith("AU  - ")), pub.authors.map((a) => `AU  - ${flat(a.label)}`));
  }), { numRuns: 200 });
});

test("property: publication CSL-JSON is valid JSON that preserves the title and names", () => {
  fc.assert(fc.property(publication, (pub) => {
    const { field, export: csl } = lib.publicationCitation(pub, "csl-json");
    assert.equal(field, "csl_json");
    const round = JSON.parse(JSON.stringify(csl));
    assert.deepEqual(round, csl);
    assert.equal(round.title, pub.title);
    assert.equal(round.id, `amira-${pub.o_id}`);
    assert.deepEqual((round.author ?? []).map((n) => n.literal ?? `${n.family}, ${n.given}`),
      pub.authors.map((a) => {
        const comma = a.label.indexOf(",");
        const family = a.label.slice(0, comma).trim(), given = a.label.slice(comma + 1).trim();
        return comma === -1 || !given ? a.label : `${family}, ${given}`;
      }));
  }), { numRuns: 200 });
});
