// MCP round-trip smoke test: spawn the bundled server, list tools, exercise
// every tool family (including the get_* detail tools and transcript search),
// and assert the citation contract: amira_url everywhere, dashboard_url gone.
import { createHash } from "node:crypto";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

/** Extension methods are not in the client's spec table — supply a result schema. */
const ANY = z.looseObject({});

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["server/index.js"],
  stderr: "inherit",
  env: { ...process.env, AMIRA_LIVE_REFRESH: "0" }, // offline: bundled snapshot only
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
function check(cond, label) {
  if (!cond) {
    failures++;
    console.error(`  FAIL: ${label}`);
  }
}

const tools = await client.listTools();
console.log(`tools (${tools.tools.length}):`, tools.tools.map((t) => t.name).join(", "));
check(tools.tools.length === 26, `expected 26 tools, got ${tools.tools.length}`);

async function call(name, args, { expect = [] } = {}) {
  const res = await client.callTool({ name, arguments: args });
  const body = res.content?.[0]?.text ?? "";
  console.log(`\n[${name}] ${body.slice(0, 260).replace(/\s+/g, " ")}${body.length > 260 ? "…" : ""}`);
  check(!body.includes("dashboard_url"), `${name}: no dashboard_url`);
  check(!body.includes('"dre_id"'), `${name}: no DRE id fields in responses`);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    check(false, `${name}: response is valid JSON`);
    return {};
  }
  check(!parsed.error || expect.includes("error"), `${name}: no unexpected error (got: ${parsed.error ?? ""})`);
  for (const e of expect) if (e !== "error") check(JSON.stringify(parsed).includes(e), `${name}: contains ${e}`);
  return parsed;
}

const AMIRA = "https://data.africamultiple.uni-bayreuth.de/s/amira/item/";

const overview = await call("get_collection_overview", {}, { expect: ["podcasts", "youtube_videos"] });
check(overview.counts?.research_items >= 3975, "overview: >= 3975 research items (v0.2.0 parity)");
check(overview.counts?.publications >= 240, "overview: >= 240 publications");
check(overview.counts?.publications_with_fulltext >= 1, "overview: publications with fulltext counted");
check(overview.counts?.journals >= 50, "overview: journals corpus present");

const search = await call("search_research_items", { subject: "Islam", limit: 3 }, { expect: [AMIRA] });
check(search.results?.[0]?.amira_url?.startsWith(AMIRA), "search: amira_url shape");
check(search.results?.[0]?.omeka_id && search.results?.[0]?.id === String(search.results[0].omeka_id), "search: Omeka id exposed as id/omeka_id");

await call("search_research_items", { location: "Nigeria", resource_type: "Image", limit: 2 });
await call("search_research_items", { language: "fre", limit: 1 }, { expect: [AMIRA] }); // legacy code alias

// `country` is a real, advertised filter again (v1.4.1): it must NARROW to the
// country — not silently return the whole collection (the reported regression) —
// and stay a subset of the any-level `location` match for the same name.
const fullCount = overview.counts?.research_items ?? 3975;
const byCountry = await call("search_research_items", { country: "Nigeria", limit: 1 });
const byLocation = await call("search_research_items", { location: "Nigeria", limit: 1 });
check(byCountry.total_matches > 0 && byCountry.total_matches < fullCount, "search: `country` narrows (not the full collection)");
check(byCountry.filters?.country === "Nigeria", "search: `country` is echoed in filters");
check(byCountry.total_matches <= byLocation.total_matches, "search: country match ⊆ location match");

// zero-result relaxation hints (report §3): an impossible combo names the filter to drop.
const zero = await call("search_research_items", { subject: "Islam", resource_type: "NoSuchType" });
check(zero.total_matches === 0, "search: impossible AND combo is empty");
check(
  zero.suggestions?.some((s) => s.remove_filter === "resource_type" && s.would_match > 0),
  "search: zero-result suggests dropping resource_type",
);
const badYearSearch = await call("search_research_items", { year_from: 2000, year_to: 1900 }, { expect: ["error"] });
check(badYearSearch.error?.code === "invalid_range", "search: inverted year range is a structured error");

// structured error shape (report §error-handling).
const errItem = await call("get_research_item", { id: "NO_SUCH_ID" }, { expect: ["error"] });
check(errItem.error?.code === "not_found" && !!errItem.error?.suggested_tool, "get_research_item: structured error");

const item = await call("get_research_item", { id: 7392 }, { expect: [AMIRA, "sponsors"] });
check(item.omeka_id === 7392 && item.id === "7392", "item: Omeka id exposed as id/omeka_id");
check(item.contributors?.some((c) => c.name === "Beier, Ulli"), "item: contributor with role");
check("dates" in item, "item: dates exposed");
check(Array.isArray(item.collections), "item: collections exposed");
check("thumbnail" in item, "item: thumbnail exposed");

// Generated citation (issue #4): items almost never carry a
// dcterms:bibliographicCitation, so the server builds one — and it must always
// end on the citable amira_url (D3), whichever export format was asked for.
check(
  item.generated_citation?.includes("Beier, Ulli") && item.generated_citation.endsWith(`${AMIRA}7392.`),
  "item: generated citation names the creator and cites the amira_url",
);
check(item.bibtex?.startsWith("@misc{amira-7392,") && item.bibtex.includes("title = {Volume 8"), "item: BibTeX export");
const itemRis = await call("get_research_item", { id: 7392, citation_format: "ris" });
check(itemRis.ris?.startsWith("TY  - FIGURE") && itemRis.ris.endsWith("ER  - "), "item: RIS export");
const itemCsl = await call("get_research_item", { id: 7392, citation_format: "csl-json" });
check(itemCsl.csl_json?.type === "graphic" && itemCsl.csl_json?.URL === `${AMIRA}7392`, "item: CSL-JSON export");

await call("search_projects", { research_section: "Arts & Aesthetics", limit: 3 }, { expect: [AMIRA] });
const proj = await call("get_project", { id: 37700 }, { expect: ["External"] });
check(proj.item_count >= 1000, "ILAM project has its ~1k items");

await call("list_research_sections", {}, { expect: ["funding_phase"] });
await call("get_research_section", { name: "Translating" }, { expect: ["AM 2.0"] });
await call("list_subjects", { limit: 5 }, { expect: [AMIRA] });
const locs = await call("list_locations", { limit: 5 });
check(locs.results?.[0]?.item_count > 0 && !("level" in (locs.results?.[0] ?? {})), "list_locations: flat, ranked by item count (no level)");
const cappedLocs = await call("list_locations", { limit: 9999 });
check(cappedLocs.requested_limit === 9999 && cappedLocs.effective_limit === 300, "list_locations: effective-limit echo when capped");
await call("list_categories", { category: "formats", limit: 5 });

const years = await call("list_years", { from: 1900, to: 2000, sort: "count", limit: 5 });
check(years.dated_items > 0, "list_years: dated_items counted");
check(years.results?.[0]?.item_count > 0 && "year" in (years.results?.[0] ?? {}), "list_years: year buckets");
check(years.results?.every((a, i, arr) => i === 0 || arr[i - 1].item_count >= a.item_count), "list_years: sort=count descending");
const badYearFacet = await call("list_years", { from: 2000, to: 1900 }, { expect: ["error"] });
check(badYearFacet.error?.code === "invalid_range", "list_years: inverted year range is a structured error");
const decades = await call("list_years", { bucket: "decade", limit: 3 });
check(/^\d+s$/.test(decades.results?.[0]?.decade ?? ""), "list_years: decade label shape");

const colls = await call("list_collections", { limit: 5 }, { expect: ["item-set"] });
check(colls.results?.[0]?.item_count > 0, "collections: ranked by item count");
if (colls.results?.[0]?.collection) {
  const byColl = await call("search_research_items", { collection: colls.results[0].collection, limit: 2 });
  check(byColl.total_matches === colls.results[0].item_count, "collection filter round-trips the count");
}
await call("search_persons", { keyword: "Beier", limit: 3 }, { expect: [AMIRA] });

const person = await call("get_person", { name: "Ulli Beier" });
check(person.name === "Beier, Ulli", "get_person: canonical name resolved from either order");
check(person.contributed_item_count > 0, "get_person: contributions found");

const insts = await call("list_institutions", { keyword: "Bayreuth", limit: 3 });
if (insts.results?.[0]?.name) {
  const inst = await call("get_institution", { name: insts.results[0].name }, { expect: [AMIRA] });
  check(typeof inst.contributed_item_count === "number", "get_institution: contributed_item_count");
}
const partners = await call("list_cluster_partners", {});
check(partners.partner_count >= 26, "list_cluster_partners: partner network exposed");
const privileged = await call("list_cluster_partners", { category: "privileged" });
check(
  privileged.categories?.[0]?.partners?.some((p) => p.name === "Center for Afro-Oriental Studies"),
  "list_cluster_partners: Bahia/CEAO is a privileged partner",
);
const amrc = await call("list_cluster_partners", { category: "amrc" });
check(
  !(amrc.categories?.[0]?.partners ?? []).some((p) => p.name === "Center for Afro-Oriental Studies"),
  "list_cluster_partners: Bahia/CEAO is not listed under AMRCs",
);
const groups = await call("list_groups", { limit: 3 });
if (groups.results?.[0]?.name) {
  await call("get_institution", { name: groups.results[0].name }, { expect: ["group"] });
}

const pubs = await call("search_publications", { limit: 3 }, { expect: [AMIRA] });
if (pubs.results?.[0]?.id) {
  await call("get_publication", { id: pubs.results[0].id }, { expect: ["bibtex"] });
}

// Publication FULL TEXT (v1.6.0): opt-in + windowed, mirroring transcripts.
const ftPubs = await call("search_publications", { has_fulltext: true, limit: 3 });
check(ftPubs.total_matches >= 1, "search_publications: has_fulltext filter finds full-text publications");
check(ftPubs.results?.every((p) => p.has_fulltext === true), "search_publications: has_fulltext echoed on results");
if (ftPubs.results?.[0]?.id) {
  const ftDefault = await call("get_publication", { id: ftPubs.results[0].id });
  check(ftDefault.has_fulltext === true && !("fulltext" in ftDefault), "get_publication: fulltext omitted by default");
  check(ftDefault.fulltext_length > 0, "get_publication: fulltext_length reported");
  const ftWindow = await call("get_publication", { id: ftPubs.results[0].id, include_fulltext: true, fulltext_max_chars: 500 });
  check(typeof ftWindow.fulltext === "string" && ftWindow.fulltext.length <= 500, "get_publication: include_fulltext returns sliced text");
  check(ftWindow.fulltext_truncated === true, "get_publication: fulltext_truncated flag when sliced");
}

// Journals (v1.6.0): venue authority round-trips into the venue filter.
const journals = await call("list_journals", { limit: 5 }, { expect: [AMIRA] });
check(journals.total_matches >= 50, "list_journals: journal authority listed");
const topJournal = journals.results?.find((j) => j.publication_count > 0);
if (topJournal) {
  const byVenue = await call("search_publications", { venue: topJournal.journal, limit: 3 });
  check(byVenue.total_matches >= topJournal.publication_count, "venue filter finds at least the journal's linked publications");
  if (byVenue.results?.[0]?.id) {
    const linked = await call("get_publication", { id: byVenue.results[0].id });
    check(typeof linked.venue === "string" && linked.venue.length > 0, "get_publication: venue label present");
  }
}

const rel = await call("find_related", { entity_type: "subject", value: "Architecture", limit: 8 });
check(typeof rel.matching === "string" && rel.matching.length > 0, "find_related: matching semantics echoed");
const relPerson = await call("find_related", { entity_type: "person", value: "Ulli Beier", limit: 1 }, { expect: [AMIRA] });
check(relPerson.matched_items > 0 && relPerson.amira_url?.startsWith(AMIRA), "find_related: person seed URL resolves from either name order");
const relProject = await call("find_related", { entity_type: "project", value: "International Library of African Music", limit: 1 }, { expect: [AMIRA] });
check(relProject.matched_items > 0 && relProject.amira_url?.startsWith(AMIRA), "find_related: project seed URL resolves from label");

const pods = await call("search_podcasts", { limit: 3 });
check(pods.results?.[0] ? "date_status" in pods.results[0] : true, "search_podcasts: date_status present");
check(pods.results?.some((p) => p.has_transcript === true), "search_podcasts: podcast transcripts present (bulk-loaded 2026-06)");
if (pods.results?.[0]?.id) {
  const pod = await call("get_podcast", { id: pods.results[0].id });
  check(!("transcript" in pod), "get_podcast: transcript omitted by default");
}

const vids = await call("search_videos", { keyword: "Africa", limit: 3 });
check(vids.total_matches > 0, "videos: keyword search hits");
const transcriptHit = (await call("search_videos", { keyword: "decolonial", limit: 3 })).results?.find(
  (v) => v.matched_in === "transcript",
);
if (transcriptHit) check(typeof transcriptHit.transcript_snippet === "string", "search_videos: transcript hit carries a snippet");
if (vids.results?.[0]?.id) {
  const vid = await call("get_video", { id: vids.results[0].id });
  check("transcript_length" in vid, "get_video: transcript_length present");
  check(!("transcript" in vid), "get_video: transcript omitted by default (opt-in)");
}
// opt-in transcript with slicing: find a video that carries one.
const withTranscript = (await call("search_videos", { limit: 100 })).results?.find((v) => v.has_transcript);
if (withTranscript) {
  const full = await call("get_video", { id: withTranscript.id, include_transcript: true, transcript_max_chars: 500 });
  check(typeof full.transcript === "string" && full.transcript.length <= 500, "get_video: include_transcript returns sliced text");
  check(full.transcript_truncated === true, "get_video: transcript_truncated flag when sliced");
}
console.log(`\ntranscript-only hit found: ${transcriptHit ? "yes" : "no (keyword may appear in titles too)"}`);

// --- Skills over MCP (draft SEP-2640) ---------------------------------------
// The companion skill has to survive the round trip a HOST makes: read the
// catalog, fetch a file, re-hash it, compare. A digest that does not match what
// resources/read returns is treated as tampering and the skill is discarded —
// silently, from our side — so the match is asserted here rather than assumed.
const caps = client.getServerCapabilities();
check(caps?.extensions?.["io.modelcontextprotocol/skills"]?.directoryRead === true, "skills: extension declared with directoryRead");
check(!!caps?.tools && !!caps?.resources, "skills: declaring extensions does not drop the tools/resources capabilities");

const skillList = await client.request({ method: "skills/list", params: {} }, ANY);
check(skillList.skills?.length === 1, `skills/list: 1 skill, got ${skillList.skills?.length}`);
const skill = skillList.skills?.[0];
check(skill?.uri === "skill://amira-mcp/SKILL.md", "skills/list: expected skill uri");
check(skill?.frontmatter?.name === "amira-mcp", "skills/list: frontmatter name matches the directory");
check(typeof skill?.frontmatter?.description === "string", "skills/list: frontmatter carries a description");
check(skill?.resources?.length === 4, `skills/list: complete manifest (4 files), got ${skill?.resources?.length}`);
check(skill?.resources?.every((r) => /^sha256:[0-9a-f]{64}$/.test(r.digest)), "skills/list: every file carries a sha256 digest");
check(skillList.cacheScope === "public" && skillList.ttlMs > 0, "skills/list: carries a cache hint");

const skillGet = await client.request({ method: "skills/get", params: { uri: skill.uri } }, ANY);
check(skillGet.skill?.uri === skill.uri, "skills/get: returns the requested skill");

const skillRoot = await client.request({ method: "resources/directory/read", params: { uri: "skill://amira-mcp" } }, ANY);
const rootNames = (skillRoot.resources ?? []).map((r) => `${r.name}:${r.mimeType}`);
check(rootNames.includes("SKILL.md:text/markdown"), "directory/read: SKILL.md listed at the skill root");
check(rootNames.includes("references:inode/directory"), "directory/read: subdirectory listed as a directory resource");
check(skillRoot.resources?.length === 2, "directory/read: direct children only, not recursive");

const refDir = await client.request(
  { method: "resources/directory/read", params: { uri: "skill://amira-mcp/references" } },
  ANY,
);
check(refDir.resources?.length === 3, `directory/read: 3 reference files, got ${refDir.resources?.length}`);

const REF_URI = "skill://amira-mcp/references/data-model.md";
const refRead = await client.readResource({ uri: REF_URI });
const refText = refRead.contents?.[0]?.text ?? "";
const rehashed = `sha256:${createHash("sha256").update(Buffer.from(refText, "utf8")).digest("hex")}`;
check(rehashed === skill.resources.find((r) => r.uri === REF_URI)?.digest, "resources/read: digest verifies against the manifest");

const listed = (await client.listResources()).resources.map((r) => r.uri);
check(listed.filter((u) => u.startsWith("skill://")).length === 4, "resources/list: skill files are readable resources");
check(listed.some((u) => u.startsWith("ui://")), "resources/list: the ui:// apps are still there");

for (const [method, params, label] of [
  ["skills/get", { uri: "skill://absent/SKILL.md" }, "unknown skill"],
  ["resources/directory/read", { uri: "skill://amira-mcp/absent" }, "unknown directory"],
]) {
  await client
    .request({ method, params }, ANY)
    .then(() => check(false, `skills: ${label} rejected`))
    .catch((err) => check(err?.code === -32602, `skills: ${label} rejected with INVALID_PARAMS (got ${err?.code})`));
}

await client.close();
await transport.close();

if (failures > 0) {
  console.error(`\nsmoke test FAILED: ${failures} check(s)`);
  process.exit(1);
}
console.log("\nsmoke test complete — all checks passed");
