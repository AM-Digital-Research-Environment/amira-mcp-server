// Exact assertions for `fetch` on every record kind, and what each exposure level strips. The extended fixture and the
// helpers come from test/helpers/coverage-harness.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import {d, call, raw, url, errorOf, 
} from "../helpers/coverage-harness.mjs";

// --- fetch: every record kind -------------------------------------------------------------

test("fetch: research items, under both id vocabularies", async () => {
  const expected = {
    title: "Yoruba Architecture Study",
    text: [
      "Title: Yoruba Architecture Study", `AMIRA record: ${url(500)}`, "Type: Image", "University: University of Bayreuth",
      "Project: Fixture Art Worlds", "Contributors: Beier, Ulli (Author)", "Date: 2013", "Subjects: Architecture; Islam",
      "Places: Lagos (Nigeria)", "Languages: French", "Formats: photograph", "Sponsors: DFG", "Provenance: Iwalewahaus",
      "\nDescription:\nWall painting studies from Lagos.",
    ].join("\n"),
    url: url(500),
    metadata: { kind: "research_item", omeka_id: 500, amira_url: url(500), type: "Image", date: "2013", university: "University of Bayreuth",
      project_omeka_id: 300, subjects: ["Architecture", "Islam"], places: ["Lagos"], has_media: true },
  };
  for (const id of ["item:500", "research_item:500", "item:abg-fx-0500"]) {
    assert.deepEqual(await call("fetch", { id }), { id, ...expected }, id);
  }
  const capped = await call("fetch", { id: "item:500", max_chars: 50 });
  assert.equal(capped.text, expected.text.slice(0, 50));
  assert.equal(capped.metadata.truncated, true);
});

test("fetch: publications, with full-text opt-in and offset windowing", async () => {
  const fulltext = d.publications[0].fulltext;
  const meta = { kind: "publication", omeka_id: 510, amira_url: url(510), type: "article", year: 2024, authors: ["Fendler, Ute"],
    venue: "Society", venue_amira_url: url(520), doi: "https://doi.org/10.1000/fix510", publication_url: "https://doi.org/10.1000/fix510",
    repository_urls: ["https://epub.uni-bayreuth.de/id/eprint/510/"], has_fulltext: true };
  const head = ["Title: Decolonial Architecture Futures", `AMIRA record: ${url(510)}`, "Type: article", "Authors: Fendler, Ute",
    "Venue: Society", "Year: 2024", "Vol. 61, pp. 1-10", "DOI: https://doi.org/10.1000/fix510", "Status: Peer reviewed",
    "\nAbstract:\nOn architecture and decolonial thought."].join("\n");
  for (const id of ["pub:510", "publication:510", "pub:eref-510"]) {
    const doc = await call("fetch", { id });
    assert.deepEqual(doc, {
      id, title: "Decolonial Architecture Futures", url: url(510),
      text: `${head}\n[Full text omitted (${fulltext.length} chars) — call fetch again with include_fulltext=true to append it (page long ones with fulltext_offset / fulltext_max_chars).]`,
      metadata: { ...meta, fulltext_included: false, fulltext_length: fulltext.length,
        fulltext_hint: "Set include_fulltext=true to append the full text (page long ones with fulltext_offset / fulltext_max_chars)." },
    }, id);
  }
  const page = await call("fetch", { id: "pub:510", include_fulltext: true, fulltext_offset: 7, fulltext_max_chars: 100 });
  assert.equal(page.text, `${head}\nFull text:\n${fulltext.slice(7, 107)}`);
  assert.deepEqual(page.metadata, { ...meta, fulltext_included: true, fulltext_length: fulltext.length, fulltext_offset: 7,
    fulltext_returned_chars: 100, fulltext_truncated: true });

  const bare = await call("fetch", { id: "pub:511", include_fulltext: true });
  assert.deepEqual(bare.metadata, { kind: "publication", omeka_id: 511, amira_url: url(511), type: "working_paper", year: 2020,
    authors: ["Beier, Ulli"], venue: "Working Papers Series", publication_url: "https://eref.uni-bayreuth.de/id/eprint/511/",
    repository_urls: ["https://eref.uni-bayreuth.de/id/eprint/511/"], has_fulltext: false, fulltext_included: false, fulltext_length: 0 });
  assert.doesNotMatch(bare.text, /Full text/);
});

test("fetch: videos and podcasts, with transcript opt-in and windowing", async () => {
  const vt = d.videos[0].transcript;
  const video = await call("fetch", { id: "video:540", include_transcript: true });
  assert.equal(video.text, [`Title: A Fixture Lecture`, `AMIRA record: ${url(540)}`, "Date: 2023-11-02", "Speakers: Beier, Ulli",
    "Playlists: Lectures", "Watch: https://www.youtube.com/watch?v=fixture540", "\nDescription:\nA lecture recording.",
    `Transcript:\n${vt}`].join("\n"));
  assert.deepEqual(video.metadata, { kind: "youtube_video", omeka_id: 540, amira_url: url(540), date: "2023-11-02",
    date_status: "published", playlists: ["Lectures"], speakers: ["Beier, Ulli"], watch_url: "https://www.youtube.com/watch?v=fixture540",
    has_transcript: true, transcript_included: true, transcript_length: vt.length, transcript_offset: 0, transcript_returned_chars: vt.length });
  const noTranscript = await call("fetch", { id: "video:541", include_transcript: true });
  assert.deepEqual(noTranscript.metadata, { kind: "youtube_video", omeka_id: 541, amira_url: url(541), date: "2022-01-01",
    date_status: "published", watch_url: "https://www.youtube.com/watch?v=fixture541", has_transcript: false,
    transcript_included: false, transcript_length: 0 });

  const pt = d.podcasts[0].transcript;
  const podcast = await call("fetch", { id: "podcast:530" });
  assert.deepEqual(podcast.metadata, { kind: "podcast", omeka_id: 530, amira_url: url(530), series: "Cluster Conversations", episode: 1,
    date: "2021-03-01", date_status: "published", listen_url: "https://example.org/podcast/1", has_transcript: true,
    transcript_included: false, transcript_length: pt.length,
    transcript_hint: "Set include_transcript=true to append the transcript (page long ones with transcript_offset / transcript_max_chars)." });
  assert.match(podcast.text, /^Title: Fixture Conversations Episode 1\nAMIRA record: .+\nSeries: Cluster Conversations\nEpisode: 1\nDate: 2021-03-01\nPeople: Fendler, Ute \(Speaker\)\nListen: https:\/\/example.org\/podcast\/1\n\nDescription:\nTalking about research.\n\[Transcript omitted/);
  const window = await call("fetch", { id: "podcast:530", include_transcript: true, transcript_offset: 10, transcript_max_chars: 30 });
  assert.ok(window.text.endsWith(`\nTranscript:\n${pt.slice(10, 40)}`));
  assert.deepEqual([window.metadata.transcript_offset, window.metadata.transcript_returned_chars, window.metadata.transcript_truncated],
    [10, 30, true]);
  assert.equal((await call("fetch", { id: "podcast:531" })).metadata.date_status, "scheduled");
});

test("fetch: projects and research sections", async () => {
  for (const id of ["project:300", "project:UBT_Fixture2019"]) {
    assert.deepEqual(await call("fetch", { id }), {
      id, title: "Fixture Art Worlds", url: url(300),
      text: ["Project: Fixture Art Worlds", `AMIRA record: ${url(300)}`, "University: University of Bayreuth",
        "Research sections: Arts & Aesthetics", "Principal investigators: Beier, Ulli", "Members: Fendler, Ute",
        "Funded by: University of Bayreuth", "Dates: 2019-06-01 – 2022-05-31", "Digitised items: 2",
        "\nDescription:\nA fixture project about art worlds."].join("\n"),
      metadata: { kind: "project", omeka_id: 300, amira_url: url(300), university: "University of Bayreuth",
        research_sections: ["Arts & Aesthetics"], item_count: 2 },
    }, id);
  }
  for (const id of ["section:400", "research_section:400"]) {
    assert.deepEqual(await call("fetch", { id }), {
      id, title: "Arts & Aesthetics", url: url(400),
      text: ["Research section: Arts & Aesthetics", `AMIRA record: ${url(400)}`, "Dates: 2019 – 2025",
        "Principal investigators: Beier, Ulli", "\nDescription:\nFixture section on arts."].join("\n"),
      metadata: { kind: "research_section", omeka_id: 400, amira_url: url(400), dates: { start: "2019", end: "2025" } },
    }, id);
  }
  assert.match((await call("fetch", { id: "section:402" })).text, /\nSpokesperson: Kaboré, Awa\n/);
});

test("fetch: unknown ids and kinds fetch cannot render are text-only not_found errors", async () => {
  for (const id of ["item:999999", "pub:999999", "video:1", "podcast:1", "project:1", "section:1", "section:abc",
    "person:100", "subject:600", "500", "nonsense"]) {
    assert.deepEqual(await errorOf("fetch", { id }),
      { code: "not_found", message: `No record with id '${id}'.`, suggested_tool: "search" }, id);
  }
});

// --- exposure levels ------------------------------------------------------------------------

/** The structured-only tools this file covers, each with valid arguments. */
const STRUCTURED_ONLY = [
  ["list_institutions", {}], ["get_institution", { name: "UBT" }], ["list_cluster_partners", {}], ["list_groups", {}],
  ["search_projects", {}], ["get_project", { id: 300 }], ["list_research_sections", {}], ["get_research_section", { id: 400 }],
  ["search_persons", {}], ["get_person", { id: 100 }], ["list_collections", {}],
  ["list_categories", { category: "languages" }], ["list_categories", { category: "genres" }],
];

for (const level of ["minimal", "descriptive", "structured"]) {
  test(`exposure=${level}: structured-only tools ${level === "structured" ? "answer" : "refuse with exposure_restricted"}`, async () => {
    process.env.AMIRA_EXPOSURE = level;
    try {
      for (const [name, args] of STRUCTURED_ONLY) {
        if (level === "structured") {
          const result = await raw(name, args);
          assert.equal(result.isError, undefined, `${name} must answer at structured`);
          continue;
        }
        const error = await errorOf(name, args);
        assert.equal(error.code, "exposure_restricted", name);
        assert.match(error.message, new RegExp(`AMIRA_EXPOSURE=${level}\\b.*'structured'`), name);
      }
      // Resource types are minimal-level metadata: always available.
      assert.equal((await call("list_categories", { category: "resource_types" })).total_matches, 3);
    } finally {
      delete process.env.AMIRA_EXPOSURE;
    }
  });
}

test("exposure: get_podcast and fetch strip what each level hides", async () => {
  try {
    process.env.AMIRA_EXPOSURE = "minimal";
    const pod = await call("get_podcast", { id: 530 });
    assert.equal(pod.abstract, null);
    assert.ok(!("series" in pod) && !("people" in pod) && !("languages" in pod));
    assert.deepEqual([pod.has_transcript, pod.transcript_access, pod.transcript_hint], [true, "disabled", undefined]);
    assert.equal((await errorOf("get_podcast", { id: 530, include_transcript: true })).code, "text_access_disabled");
    const item = await call("fetch", { id: "item:500" });
    assert.equal(item.text, ["Title: Yoruba Architecture Study", `AMIRA record: ${url(500)}`, "Type: Image", "Date: 2013"].join("\n"));
    assert.deepEqual(item.metadata, { kind: "research_item", omeka_id: 500, amira_url: url(500), type: "Image", date: "2013", has_media: true });

    process.env.AMIRA_EXPOSURE = "descriptive";
    const described = await call("fetch", { id: "item:500" });
    assert.match(described.text, /\n\nDescription:\nWall painting studies from Lagos\.$/);
    assert.doesNotMatch(described.text, /Subjects:|Project:|Contributors:/);
    assert.equal((await call("get_podcast", { id: 530 })).abstract, "Talking about research.");
    assert.equal((await call("fetch", { id: "section:400" })).text.includes("Principal investigators"), false);

    process.env.AMIRA_EXPOSURE = "structured";
    const pub = await call("fetch", { id: "pub:510", include_fulltext: true });
    const length = d.publications[0].fulltext.length;
    assert.ok(pub.text.endsWith(`\n[Full text exists (${length} chars) but access is disabled by the server's exposure policy.]`));
    assert.deepEqual([pub.metadata.fulltext_included, pub.metadata.fulltext_access, pub.metadata.authors],
      [false, "disabled", ["Fendler, Ute"]]);
    const video = await call("fetch", { id: "video:540", include_transcript: true });
    assert.equal(video.metadata.transcript_access, "disabled");
    assert.ok(!video.text.includes("planetary-token"), "no transcript text leaks into the body");
    const structuredPod = await call("get_podcast", { id: 531 });
    assert.deepEqual([structuredPod.series.title, structuredPod.transcript_access], ["Cluster Conversations", "disabled"]);
  } finally {
    delete process.env.AMIRA_EXPOSURE;
  }
});
