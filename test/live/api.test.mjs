// Live integration tests against the public Omeka S API (network required):
// one real record per data type through the real transform, plus the API
// contracts the fetcher depends on (headers, GET-only, citation pages).
// Run via `npm run test:live`. The weekly refresh workflow runs these before
// packing, so an instance-side template change fails loudly, not silently.
import test from "node:test";
import assert from "node:assert/strict";
import { hermeticEnv } from "../helpers/env.mjs";

// AMIRA_SITE_BASE is the one deliberate input (test another Omeka instance);
// everything else is cleared and the cache isolated before the bundle loads.
const siteOverride = process.env.AMIRA_SITE_BASE;
hermeticEnv();
if (siteOverride) process.env.AMIRA_SITE_BASE = siteOverride;
const {
  probeRemote,
  transformJournal,
  transformPodcast,
  transformProject,
  transformPublication,
  transformResearchItem,
  transformVideo,
} = await import("../../server/lib.js");

const SITE = siteOverride?.replace(/\/+$/, "") || "https://data.africamultiple.uni-bayreuth.de";
const API = `${SITE}/api`;
const ctx = { roleLabel: () => null, classTerm: () => null };

// Every request carries its own deadline: a hung Omeka request must fail this
// test, not hold the job until the CI runner's 6-hour limit. (scripts/test.mjs
// also caps each test at 60 s; probeRemote() uses the server's own fetchJSON.)
const FETCH_TIMEOUT_MS = 30_000;
const fetchLive = (url) =>
  fetch(url, { headers: { "User-Agent": "amira-mcp-live-tests" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

async function get(url) {
  const res = await fetchLive(url);
  assert.ok(res.ok, `${url} -> HTTP ${res.status}`);
  return { body: await res.json(), headers: res.headers };
}

test("API paginates with Omeka-S-Total-Results and matches the snapshot scale", async () => {
  const { body, headers } = await get(`${API}/items?resource_template_id=10&per_page=1`);
  const total = Number(headers.get("omeka-s-total-results"));
  assert.ok(total >= 3975, `research items total ${total} >= 3975 (v0.2.0 parity)`);
  assert.equal(body.length, 1);
});

test("research item: live record transforms with dre:id, subjects, sponsor", async () => {
  const { body } = await get(`${API}/items/7392`);
  const it = transformResearchItem(body, ctx, () => "ubt");
  assert.equal(it.dre_id, "abg-99-0000");
  assert.ok(it.subjects.length > 0 && it.subjects.every((s) => s.o_id != null));
  assert.ok(it.sponsors.length > 0);
  assert.ok(it.contributors.some((c) => c.name === "Beier, Ulli"));
});

test("project: live Ext_ILAM record carries the External section", async () => {
  const { body } = await get(`${API}/items?resource_template_id=5&search=International Library of African Music&per_page=5`);
  const ilam = body.map(transformProject).find((p) => p.dre_id === "Ext_ILAM");
  assert.ok(ilam, "Ext_ILAM project found");
  assert.deepEqual(ilam.sections.map((s) => s.label), ["External"]);
});

test("publication: live record has identifier + repository uris", async () => {
  const { body } = await get(`${API}/items?item_set_id=29918&per_page=1`);
  const pub = transformPublication(body[0], ctx, null);
  assert.match(pub.pub_id, /^(eref|epub)-\d+/);
  assert.ok(pub.urls.length >= 1);
  assert.ok(pub.year == null || pub.year > 1990);
});

test("publication full text: open-access records carry bibo:content > 10k chars", async () => {
  // property 91 = bibo:content; `ex` keeps only records where it exists.
  const { body, headers } = await get(
    `${API}/items?item_set_id=29918&property%5B0%5D%5Bproperty%5D=91&property%5B0%5D%5Btype%5D=ex&per_page=3`,
  );
  const total = Number(headers.get("omeka-s-total-results"));
  assert.ok(total >= 1, `publications with full text on the instance: ${total}`);
  const pubs = body.map((p) => transformPublication(p, ctx, null));
  assert.ok(pubs.some((p) => p.fulltext && p.fulltext.length > 10000), "extracted full text > 10k chars");
});

test("publication detail mappings retain live conference, extent, access and authority metadata", async () => {
  // Stable examples from the September 2026 bibliography review. Compare source
  // values so a curator correcting a label does not invalidate the mapping test.
  const responses = await Promise.all([29928, 29935, 29949, 29926].map((id) => get(`${API}/items/${id}`)));
  const [book, conference, thesis, linked] = responses.map(({ body }) => transformPublication(body, ctx, null));
  assert.ok(book.num_pages);
  assert.equal(book.num_pages, responses[0].body["bibo:numPages"][0]["@value"]);
  assert.ok(book.publisher_ref?.o_id);
  assert.ok(book.access_rights.length);
  assert.deepEqual(conference.conference_details, responses[1].body["bibo:presentedAt"].map((v) => v["@value"]));
  assert.ok(thesis.advisers.some((r) => r.o_id));
  assert.ok(thesis.degree_granting_institutions.length);
  assert.equal(linked.external_links[0].url, responses[3].body["fabio:hasURL"][0]["@id"]);
});

test("journals: the venue authority (template 23) exists and transforms", async () => {
  const { body, headers } = await get(`${API}/items?resource_template_id=23&per_page=5`);
  const total = Number(headers.get("omeka-s-total-results"));
  assert.ok(total >= 50, `journals on the instance: ${total}`);
  const journals = body.map(transformJournal);
  assert.ok(journals.every((j) => j.o_id > 0 && j.title.length > 0));
  assert.ok(journals.some((j) => j.issn || j.country || j.url), "journals carry issn/country/url metadata");
});

test("video: at least one live video carries a transcript", async () => {
  const { body } = await get(`${API}/items?resource_template_id=22&per_page=25`);
  const videos = body.map((v) => transformVideo(v, ctx));
  assert.ok(videos.some((v) => v.transcript && v.transcript.length > 500), "some transcript > 500 chars");
  assert.ok(videos.every((v) => v.url == null || v.url.includes("youtube")));
});

test("podcast: live records transform; absent transcripts stay null", async () => {
  const { body } = await get(`${API}/items?resource_template_id=21&per_page=5`);
  const pods = body.map((p) => transformPodcast(p, ctx));
  assert.ok(pods.every((p) => p.series?.label));
  assert.ok(pods.every((p) => p.transcript === null || typeof p.transcript === "string"));
});

test("citation pages resolve: /s/amira/item/<o:id> -> 200", async () => {
  const res = await fetchLive(`${SITE}/s/amira/item/7392`);
  assert.equal(res.status, 200);
});

test("freshness probe returns a max o:modified and a total", async () => {
  const probe = await probeRemote(API);
  assert.ok(probe.maxModified, "maxModified present");
  assert.ok(probe.totalItems > 9000, `instance total ${probe.totalItems} > 9000`);
});
