# Changelog — amira-mcp-server

What each release changed, newest first. Dates are tag dates. The
[GitHub releases](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/releases)
carry the full notes and assets; [ROADMAP.md](ROADMAP.md) holds the decisions in
force and what comes next.

## Unreleased

- **Curator mode with personal tokens** (#26, step 1). `AMIRA_ACCESS=curator`
  runs an internal, read-only endpoint for AMIRA's developers and data
  curators that also serves private records and private values. It crawls the
  Omeka API with a service key (`AMIRA_OMEKA_KEY_FILE`), added to each request
  inside the fetch and kept out of the API base, the manifest, errors, logs,
  `/healthz` and returned URLs. Clients authenticate with personal tokens:
  `AMIRA_MCP_TOKENS_FILE` lists one `name sha256hex` line per curator, compared
  in constant time and re-read every 2 s, so deleting a line revokes that
  curator without a restart; `node server/tokenCli.js <name>` generates a
  256-bit token. Each MCP request is audited with the curator's name and the
  tool, never a token or an argument. OAuth sign-in for the chat applications
  is the next step. See [docs/curator.md](docs/curator.md).
- **Curator mode fails closed.** It refuses to start without the key, the
  tokens, an explicit `AMIRA_CACHE_DIR` (meant for tmpfs) or a refresh interval
  shorter than `AMIRA_CURATOR_MAX_STALE_HOURS` (default 24); it refuses stdio,
  the `.mcpb`, `fetch-data` and a shared bearer token. A public server refuses
  to start with an Omeka key or a tokens file.
- **Private data is marked, never mixed in.** In curator mode every record
  carries `visibility`; a private record gets `admin_url` and a
  `citation_note` instead of `amira_url`, and its generated citation, BibTeX,
  RIS and CSL-JSON say it is private and link nothing public. Private values
  (`dre:mongoId`, `dre:security`, `dre:bitstream`, a private description, …)
  sit in a separate `restricted` block on detail results, never in the public
  fields. The private ILAM OCR full text (`bibo:content` on research items,
  read for the first time) and private publication full texts are searchable
  in `search_research_items` / `search_publications` and paged with
  `include_fulltext` on `get_research_item` (curator-only parameters) and
  `get_publication`. The overview and `amira://dataset` split counts into
  public and private.
- **Snapshots and caches are isolated by access mode.** The manifest records
  `access` (`public` for every new public snapshot; absent means public), the
  curator cache partition hashes the mode in (public partitions keep their
  hash, so existing caches stay valid), and each mode refuses the other's
  snapshot. Curator mode never loads the bundled snapshot, refuses data Omeka
  has not confirmed within the staleness limit, and on a 401/403 from Omeka
  drops its store, wipes its cache and refuses requests until a refresh
  succeeds. Its `/healthz` shows no counts.
- **Public mode drops private content even if it arrives.** The crawl now
  splits every resource's private values off before transforming it and drops
  private resources, private media and links to them; loading a snapshot drops
  any private record or `restricted` block again. Omeka's anonymous API never
  sends these, so public output is unchanged: tool results, resources, exports
  and `tools/list` are byte-identical on the test fixture, and the new keys
  appear only in curator mode. The one visible difference is the `access`
  field in newly written snapshot manifests.

## 1.35.1 — 2026-11-10

A security release for the container image; the server itself is unchanged
from 1.35.0. Deployments that run the GHCR image should move to this one.

- **The container image ships without its fixable high and critical CVEs.**
  The 1.35.0 image carried ten, all inherited from `node:26-slim`: six in the
  copies of `brace-expansion` and `undici` that npm vendors, two in zlib and
  one in apt (counted for `apt` and `libapt-pkg7.0`). The runtime stage now
  applies Debian's security updates and removes npm, which the self-contained
  bundle never loads, and the base digest moves to the 5 November build. Trivy
  finds none left.
- **CI scans the image.** The container job fails on any fixable high or
  critical vulnerability, and a new weekly workflow (`image-scan.yml`) scans
  the published `latest` image and keeps an issue assigned to the maintainer
  open until a release clears it. Dependabot PRs are assigned to the
  maintainer too.

## 1.35.0 — 2026-11-07

The first published release since 1.33.0: the 1.34.0 tag never produced
release assets (its crawl ran while the upstream Omeka sync was writing), so
this release also ships everything listed under 1.34.0 below: explained
recommendations, `include_similar`, the `find_related` record pivot and
`get_semantic_map`. On top of it, a fix that brings the semantic tools back
on installs whose cache predates them, and a refactoring pass after the 1.33
and 1.34 semantic work: shared code where copies had begun to disagree, less
work and memory on the request path, a cheaper tool surface, and CI gates
that actually run. The refactor added or renamed no tool.

- **Semantic tools no longer go dark behind a newer cache.** At startup the
  newest snapshot wins, and a cache written by a server older than 1.33.0 (or
  while GitHub was unreachable) carries no neighbours: being newer than the
  bundled snapshot, it hid the bundled neighbours, and `get_similar_items`
  answered `semantic_unavailable` until the next upstream change, since a
  refresh only runs when Omeka changes. Startup now serves the best
  neighbours either snapshot holds (one with the semantic map first, then the
  newest build), and the next refresh writes them into the cache. Seen on a
  v1.33.0 install whose cache a v1.32 server had refreshed minutes earlier.
- **`AMIRA_SEMANTIC_RELEASE` is honoured at load.** `off` served the stored
  neighbours anyway and a pinned tag served whichever build a snapshot held;
  both now apply to every snapshot read, bundled or cached.
- **An unreadable `semantic_neighbours.json` costs the semantic tools, not the
  snapshot.** It used to reject the whole cache; the writer still verifies
  strictly, so a bad file is never published.
- **`get_semantic_map` explains neighbours without a map** (stored before
  1.34.0) instead of saying no corpus-vector release exists, and points to
  `get_similar_items`, which works.
- **Tool surface: about 1,000 fewer tokens per turn** (stdio 13,003 → 12,042,
  HTTP 13,896 → 12,841) with every field still documented. `tools/list` no
  longer repeats `$schema` (MCP reads a schema without one as 2020-12) or
  `propertyNames: string`, and output schemas drop `additionalProperties:
  false`; input schemas stay closed objects.
- **Semantic results share one record shape** (`title`, `type`, `omeka_id`,
  `amira_url`). `get_similar_items` and the `similar` block of the detail
  tools no longer return `id`, which repeated `omeka_id` as a string.
- **A typed id of the wrong kind names the right tool.** `get_podcast` with
  `video:540` is still `not_found`, now with `suggested_tool: get_video` and a
  message saying which kind the id is. All detail tools resolve ids through one
  registry of record kinds (`src/recordKinds.ts`).
- **Counts merge accent variants of unlinked values.** Facets keyed unlinked
  labels by `toLowerCase`, so `list_categories formats` listed "Vidéo/MP4"
  and "video/mp4" as two formats; every count now keys on the authority id or
  the folded label, as `find_related` already did. On the real snapshot every
  other `find_related`, `get_similar_items`, `get_semantic_map` and facet
  answer checked is unchanged.
- **Fixes:** `find_related entity_type=project` no longer matches the value
  `undefined` against items without a project; `get_semantic_map` reports
  `invalid_argument` like every other tool (it said `invalid_arguments`); the
  record resource (`amira://record/…`) follows the tool profile.
- **Faster and leaner.** The heavy indexes (record ids, semantic index,
  full-text map, entity graph) are built when a snapshot loads, and on a live
  refresh before the swap: the first `get_similar_items` call fell from 170 ms
  to 10 ms. `get_snapshot_changes` diffs per-record fingerprints
  (`fingerprints.json`, written with every snapshot) instead of keeping whole
  retained snapshots in memory. A refresh parses the new snapshot once, not
  three times. Each snapshot owns its folded-text cache. A server builds in
  0.3 ms instead of 2.8 ms (the HTTP transport builds one per request).
- **Tests and CI.** The real-bundle allowlist test now runs in CI (it skipped
  in every lane), and the Windows packaging step fails when it should.
  `weigh --check` fails when a probe stops being measured, and new probes
  cover `find_related@record`, `get_semantic_map@group` and
  `get_publication@fulltext+similar`. The evaluation set's identity questions
  run on every real crawl. The refresh tests no longer download from GitHub
  (`AMIRA_ENRICHMENT_BASE`, a test hook), and the unit suite went from 19 s to
  8 s. The app views' scripts moved to `src/ui/views/`, where Biome lints them
  and `npm run typecheck` checks them. CI reuses one crawl per week, and the
  release and data refresh share their gate (`.github/actions/verify-and-pack`)
  and no longer build twice.

## 1.34.0 — 2026-11-06

The second phase of semantic discovery (#12): recommendations that say why,
a pivot by meaning, and a map of the whole collection, all from the same
verified corpus vectors and still with no model at request time.

- **Explained recommendations** (#12, phase 2). Every neighbour that
  `get_similar_items` returns now says what the pair also shares in the
  catalogue: `shared` names up to three subjects, places (a place shares its
  country), people or the project, with `shared_counts` when there are more
  (research sections are too broad to count: nearly every pair shares one),
  and `basis: "wording_only"` marks a pair linked by wording alone. An agent can weigh a recommendation instead of
  reading similar wording as a link.
- **`include_similar`** on `get_research_item`, `get_publication`,
  `get_podcast`, `get_video` and `get_project` adds the same five explained
  neighbours as a `similar` block. A record without neighbours carries the
  reason there (`low_signal`, `not_in_release`, or the space unavailable at
  this exposure level or in this snapshot) instead of an error.
- **`find_related entity_type=record`**: a semantic pivot next to the
  subject, place, person and project pivots. The seed is any embedded record
  (an `omeka_id` or typed id); its 20 closest records by meaning, of any
  type, stand in for the matched records, and the `related_*` lists
  count what they share, per corpus (`video_count`, `podcast_count`,
  `project_count` and `section_count` join the usual research-item and
  publication counts on this pivot only). A seed without neighbours is a
  `no_neighbours` error that says why.
- **`get_semantic_map`**, a new tool: the collection as unnamed groups of
  records close in meaning. The crawl groups the clustered records by seeded
  spherical k-means over the same verified vectors (k-means++ starts, about a
  hundred records per group, at most 30 groups, low-signal records left out)
  and stores each group's member ids, nearest the centre first, in
  `semantic_neighbours.json`; `map.php` is not used, since the release
  checksum does not cover it. Without arguments the tool lists the groups,
  largest first, each with its type mix, most frequent subjects, countries
  and projects, and the records nearest its centre; `group` lists one
  group's records and `id` finds the group a record falls in. Groups are
  described by their contents, never named, and their ids hold for one
  snapshot. `get_data_quality` reports the number of groups. 36 core tools on
  stdio, 38 over HTTP; it joins the `discovery` profile.
- **Surface:** stdio `tools/list` 12,541 → 13,003 estimated tokens (+3.7%);
  the `discovery` profile's ceiling moves from 6,500 to 6,800 for its new
  tool. The token baseline is re-measured on the 6 November snapshot.

## 1.33.0 — 2026-11-06

Similarity by meaning across the whole collection, collections cited by their
project, and an explicit tier on every place.

- **`get_similar_items`**, a new tool (#12, phase 1): the records whose
  catalogue descriptions read most alike, across research items,
  publications, videos, podcasts, projects and research sections, with cosine
  scores and `amira_url`s. `types` narrows the answer exactly (the ten best of
  each type are kept), `limit` goes up to 10, and a record without neighbours
  says why: `low_signal` (too little own text, excluded by the producer) or
  `not_in_release` (newer than the vector build). It needs the `structured`
  exposure level, since the vectors encode subjects and places too, and joins
  the `research` and `discovery` profiles. 35 core tools on stdio, 37 over
  HTTP.
- **Verified corpus vectors, neighbours only in the bundle.** The crawl
  downloads the newest DRE Visualizations release
  `semantic-embeddings-v1-<build>` (`AMIRA_SEMANTIC_RELEASE` pins a tag or
  turns it `off`) and refuses it unless the model (`google/embeddinggemma-2`),
  768 dimensions, float32-le, L2-normalised rows, row count, byte length and
  SHA-256 all match its manifest. It then computes the neighbours of every
  record in the snapshot and stores them as `semantic_neighbours.json`, never
  the ~15 MB of vectors: no model and no vector at request time. Records
  absent from the snapshot are dropped before ranking and again at load, so a
  neighbour is always citable. The computation yields to the event loop, so a
  live refresh keeps serving; when no release verifies, the neighbours
  already served are kept. `get_data_quality` reports the release and its
  coverage per type, `amira://dataset` names the space
  (`amira:semantic_space`), and the release joins the snapshot id and the
  rolling-release signature. The crawl steps in CI and in the release and
  refresh workflows pass the read-only workflow token to list releases.
- **Collections are projects** (#18). Every research project exists in Omeka
  both as the project item and as the item set its records are filed in, and
  the set page now redirects to the project. The crawl reads each set's
  project (`dcterms:isPartOf`) and code (`dre:id`); older snapshots infer the
  project from the set's members. `list_collections` lists one row per
  project, cited by the project page, with `project_id`, `item_sets [{id,
  code}]` and the IIIF collection link (`project` only when its name differs
  from the set's title). The `collection` filter and `compare_collections`
  take a project id, `dre:id`, item-set id or code and all resolve to the same
  records. `get_research_item.collections`, export rows, the collection
  record, entity-graph nodes, snapshot changes and the ILAM full-text map cite
  the project page too. Membership follows each item's own project link, so
  nothing depends on the per-project item sets staying public.
- **`list_locations` rows carry `level`** (#3): `country` for a hierarchy root,
  `place` for everything under it (a city, region, province or site). An
  output field, not a filter, so stale connector schemas see it at once.
- **Surface and size:** stdio `tools/list` 12,223 → 12,541 estimated tokens
  (+2.6%); the `research` profile's ceiling moves from 10,450 to 10,700. The
  neighbours add about 0.6 MB compressed to the bundle (7.46 MB in 1.32.0).
  The token baseline is re-measured on the 6 November snapshot.

## 1.32.0 — 2026-11-04

The ILAM journal *African Music* (item set 27724) beyond its metadata. Its full
text is private in Omeka, so the public API never carries it and nothing here
reads or quotes it. DRE Visualizations v2.48.0 computed a full-text map from it
offline and committed only derived, public files; the server now serves them.

- **The map travels with the snapshot.** The crawl fetches two public files of
  DRE Visualizations at the pinned tag `v2.48.0` (`FULLTEXT_SOURCE` in
  `src/fulltextMaps.ts`): the map (ids, groups with AI-generated labels, the 8
  nearest neighbours by full-text embedding with cosine scores, and per-article
  country counts) and the word counts per year. Both are validated against
  their expected shape and stored, declared fields only, as
  `fulltext_maps.json` beside the snapshot; the manifest records the tag and
  article count, and a load fails if the two disagree. A failed fetch never
  blocks a refresh: the snapshot ships without the map, a live refresh keeps
  the files already served, and the surfaces below answer
  `fulltext_map_unavailable`. A snapshot from an older pin is stale. Every
  result is filtered to research items present in the snapshot and filed in
  the item set, and cites them by `amira_url`.
- **`get_research_item`** adds, for an article on the map,
  `closest_in_content` (its closest articles by full text, with titles, scores
  and `amira_url`s) and `full_text_map` (its content group, marked
  `label_ai_generated`, and the countries its text names, each with a note on
  method and limits). An ILAM article off the map says so.
- **`find_related entity_type=research_item`** pivots from an article to its
  closest articles by full text, with the subjects, people, countries and
  formats they share; the hub view names the seed by its title.
- **`mentions_country`**, a new research-item filter, keeps articles whose
  full text names a country at least three times (gazetteer counts, journal
  addresses excluded; country aliases apply), with `country_mentions` on each
  row. It is part of the shared selector, so `list_years`, `list_locations`,
  `compare_collections` and exports take it too.
- **`get_fulltext_map`**, a new tool: the content groups with sample articles
  and a caveat that their names are AI-generated (Claude Opus 5.5, from
  article titles) and experimental, the countries named across the journal,
  one group's articles (`group`), or the rate per 10,000 words per year of up
  to six words (`words`), with each year's word and article counts, years
  under 12,000 words or three articles marked `sparse`, and near forms
  suggested for words not counted (only words in 10 or more
  articles are). 34 core tools on stdio, 36 over HTTP; it joins the
  `research` profile.
- **Limits are stated where the data is served:** neighbour scores sit in a
  narrow band (compare ranks), a country mention is not a subject, and 657 of
  about 1,000 articles are on the map. Every surface needs the `descriptive`
  exposure level. Passage search over the text itself is a separate rights
  decision with ILAM and Rhodes University and is not offered.
- **Surface:** stdio `tools/list` 11,916 → 12,223 estimated tokens (+2.6%);
  the `research` profile's ceiling moves from 10,200 to 10,450 for its new
  tool. The token baseline is re-measured on the 4 November snapshot.

## 1.31.1 — 2026-10-29

The first published release of the 1.31 line. The v1.31.0 tag was never
published: its release build wrote `release-notes.md` into the checkout before
packing, and the packaging allowlist test stopped it, as it should. Under the
new immutability rule the fix ships as a new version rather than a moved tag.
Everything listed under 1.31.0 is in this release: one 181 KB app page for all
seven views with the selection shared with the model, a 242-token leaner tool
surface, structured content only where it is read, scrubbed output, a call
deadline, the skill's references visible without the Skills extension,
`/metrics` and an optional bearer token, immutable attested releases with a
published GHCR image, Biome lint, the Node 22.0.0 lane and the installed-bundle
check on Windows and macOS.

- **Release files stay out of the bundle.** `.mcpbignore` excludes
  `release-notes.md`, `*.sha256` and `*.tar`, which the release workflow writes
  into the checkout.
- **Tests run on the declared floor.** On Node 22.0.0 `fetch` is an accessor on
  `globalThis`, which `t.mock.method` refuses; the snapshot tests now replace it
  with a small restoring helper. The whole unit suite passes on Node 22.0.0.

## 1.31.0 — 2026-10-29 (tagged, not published)

What the IWAC server does well, carried over after a comparison of the two
servers on 28 October: one small app page, the selection shared with the model,
immutable and attested releases with a published image, and a leaner tool
surface. Tool names, arguments and result fields are unchanged; structured
content now travels only where a client reads it.

- **Apps: one page for all seven views.** Every app-rendering tool now points
  `_meta.ui.resourceUri` at `ui://amira/app.html`, which picks the view from the
  host's `toolInfo` (from the result's shape when a host sends none). The seven
  `ui://amira/<view>` resources are gone. Each had embedded its own copy of the
  Apps SDK and zod; together they weighed 4.7 MB (660–722 KB each). The one page
  is 181 KB, 471 KB once its script is decoded: zod's non-English locales are
  stubbed out of the browser bundle, the views script is minified, the map
  outline is written as integer relative moves, and the script ships
  gzip-compressed and is expanded by the browser's `DecompressionStream`. A unit
  test fails above 300 KB for the page or 500 KB for the decoded script. View
  CSS is scoped per view. The views, their table alternatives, keyboard use,
  allowlisted tool calls and theming are unchanged, and the page still loads
  nothing from the network. The resource is registered while any of the seven
  tools survives `AMIRA_TOOL_PROFILE`. The tools/list surface grows by 5
  characters.
- **Apps: the selection reaches the model.** The bibliography (filters and
  selected publications, or the page in view), the map (filters, the opened
  place and its research items) and the graph (centre, type chips, selected
  neighbour and the records behind its link) send a bounded summary through
  `ui/update-model-context` on hosts that advertise it: one update at a time,
  the newest winning, never a new turn, at most 25 records and 10,000 bytes,
  with cuts named in `truncated_fields`. Every record keeps its `amira_url`.
  Titles and filter values travel as JSON marked as research data, not
  instructions. On hosts that accept app messages, "Ask about this selection"
  sends a question carrying its own snapshot.
- **Leaner tool surface.** tools/list no longer carries the
  `±9007199254740991` bounds zod writes on every unbounded `.int()`:
  12,158 → 11,916 estimated tokens per turn on stdio (13,099 → 12,809 over
  HTTP). Validation is unchanged.
- **Structured content where it is read.** Tools with an output schema or an
  app keep `structuredContent`; the others return their compact JSON text
  alone, instead of the same bytes twice.
- **Clean output.** Control and private-use characters are scrubbed from every
  result, so a stray one in an Omeka field cannot break a link or a citation key.
- **Call deadline.** A tool call that has not answered within 60 seconds returns
  a `deadline_exceeded` error instead of holding the client.
- **The skill's references are visible without the extension.**
  `resources/list` names all four skill files with a title and a one-line
  summary, and the instructions (2,005 characters) point at
  `skill://amira-mcp/SKILL.md`; hosts without the Skills extension can now find
  and read the workflow and its references.
- **Prompts budget their calls.** Each prompt asks to batch independent calls
  (hosts stop after roughly 20 rounds) and to open with an evidence ledger.
- **HTTP: `/metrics` and an optional bearer token.** `/metrics` reports the
  request count and p50/p95 latency of recent `/mcp` requests, rate-limit
  buckets and refresh state. `AMIRA_MCP_BEARER_TOKEN` (or
  `AMIRA_MCP_TOKEN_FILE`) makes `/mcp` and `/metrics` require a token, for a
  reverse proxy that adds the header; `/healthz` stays open.
- **Immutable, attested releases and a published image.** A release guard
  refuses a version already published on GitHub or the MCP Registry; the
  release is created as a draft with this changelog section as its notes,
  filled with bytes whose SHA-256 the build job recorded, and only then made
  public. The tested image goes to
  `ghcr.io/am-digital-research-environment/amira-mcp-server` with build
  provenance, and the Registry publisher is pinned and checksum-verified.
- **CI.** Biome lint (rules only), `@types/node` held to the Node 22 floor, a
  Node 22.0.0 lane, and the packed `.mcpb` unpacked and smoke-tested on Windows
  and macOS (`scripts/mcpb.mjs unpack`). Agent worktrees under
  `.claude/worktrees/` stay out of local packs and the image build context.
- **Retrieval evaluation.** `npm run evaluate-retrieval` scores search tools
  against researcher-authored judgments (precision, recall, nDCG and MRR at k).

## 1.30.0 — 2026-10-28

The rest of the collaborator fix from the review of 1.27.0 answers. One
researcher's profile listed 51 collaborators; on the same snapshot it now
lists 7, the people the researcher recognised.

- **Publications pair people in the same role.** Two people share a
  publication only as co-authors or as co-editors. The editors of a volume are
  no longer collaborators of its chapter authors, and co-editing counts once
  per volume, although chapter records repeat the volume's editors.
  `top_collaborators` adds `shared_authorships` and `shared_editorships`;
  `shared_publications` is now their sum.
- **Large-team works add no collaborators.** Publications with more than ten
  authors stay listed but no longer feed `top_collaborators`;
  `large_team_publication_count` reports how many there are. A 25-author
  position paper had made 24 people one researcher's collaborators.
- **`collaborators_note`** (guidance on) says the list shows shared credits,
  not a measure of collaboration, and that `shared_recordings` counts joint
  podcast or video appearances. With the two new fields, `get_person` grows by
  about 100 tokens (25%) on the weigh sample.
- **Publication repository links** come from the linked identifiers.
  MongoDB2OmekaS now writes each ERef/EPub id as a `dcterms:identifier` link
  (label `eref-N`, the permalink as its target) and keeps only the URN in
  `bibo:uri`. `urls` takes the permalinks from there (from `bibo:uri` on older
  records) and then the URN, so citation and repository links keep the
  ERef/EPub page.

## 1.29.0 — 2026-10-27

Fixes from a review of 1.27.0 answers by the researchers they described.

- **`get_person` collaborators share the work.** A record links two people
  only when both hold a collaborative role on it. Production crew and
  custodial or sponsoring credits (sound engineer, transcriber, repository,
  sponsor, publisher, provider, copyright holder, owner, former owner, patron)
  no longer make collaborators, in either direction: a podcast's sound
  engineer had been listed among the speakers' collaborators. The records
  themselves are still listed under the person's podcasts and items.
- **The coverage note states the harvest's selection.** `coverage_note` now
  says that only works from 2019 on filed under the Cluster (its repository
  division or the EXC 2052 grant) are harvested, so a Bayreuth researcher's
  other publications are absent too, and asks that the profile be presented as
  a summary of the records. Told only the source, a researcher asked why the
  answer had not completed the list from ERef. The `person_profile` caveat and
  `docs/publications.md` say the same. `get_person` grows by about 50 tokens
  (15%) on the weigh sample.

## 1.28.1 — 2026-10-26

- **Dependencies:** `fast-uri` 3.1.9 (through `ajv`), for four moderate
  advisories (GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr,
  GHSA-333x-w4r6-6crp). `npm audit` reports no vulnerabilities. No tool
  changes.

## 1.28.0 — 2026-10-26

Fixes from a test pass through the installed 1.27.0 connector.

- **`get_institution`** resolves a name made of whole words of one
  institution's name or variant, so an acronym in parentheses ("LACC") now
  finds the record `list_institutions` lists. When the words belong to several
  names, it returns `ambiguous_entity` with up to ten candidates. A fragment
  ("LAC") stays `not_found`.
- **Citation links on team lists.** `get_project` and `get_research_section`
  add `principal_investigator_refs` and `member_refs`, and `get_institution`
  adds `affiliated_person_refs` and an `amira_url` on each project. Each ref is
  `{label, omeka_id, amira_url}`, as `author_refs` on publications are. The name
  arrays stay unchanged. `get_research_section` grows by about 20% on the
  weigh sample.
- **`find_related` pivots on one person.** A `person` value matching several
  authority records ("Vierke") now returns `ambiguous_entity` with their ids,
  where it used to pool everyone matched into one set of counts. A full name or
  `person:<id>` pivots on that record, by id on linked credits. A name with no
  authority record keeps the old name match.
- **`get_person` collaborators are people.** Groups and institutions credited
  on the same record ("Institute of African Studies") no longer appear in
  `top_collaborators` or `collaborator_count`.
- **`search_projects`**: the `principal_investigator` example names a PI
  (`Alber, Erdmute`); `Baumann, Oliver` leads no project, so the old example
  found nothing.

## 1.27.0 — 2026-10-26

- **MCP TypeScript SDK 2.4.0**: `@modelcontextprotocol/server` and `client`
  2.4.0, `node` 2.1.2. `@hono/node-server` becomes a direct dependency pinned to
  2.x (2.1.5); it was a transitive 1.19.17.
- **The companion skill is served by the SDK's Skills extension**
  (`@modelcontextprotocol/server/ext/skills`), which replaces our own
  `skills/list`, `skills/get` and `resources/directory/read` handlers and the
  hand-declared capability. The SDK computes digests and sizes, checks every
  `resources/read` against the published entry, pages directory reads and
  declares the capability when it attaches. The build validates the skill
  through the same SDK loader, so a catalog the build accepts is one the server
  serves. For the same files, the skill URIs (`skill://amira-mcp/…`), the
  digests and the directory levels are identical to 1.26.0's, and the Inspector's
  `skills/list --verify --require-digests` passes. `AMIRA_SKILLS=0` still
  withdraws the whole surface. A host may notice the following:
  - `resources/list` lists the skill's `SKILL.md` alone, named `amira-mcp`
    with its description. The reference files stay readable through the new
    `skill://{+path}` resource template.
  - Directory entries carry each file's `size`.
  - `ttlMs` and `cacheScope` on skill results are sent on 2026-07-28
    connections only, where those fields exist.
  - A directory URI must be sent as listed, without a trailing slash.
  - Errors for an unknown skill or directory keep `-32602`, with the SDK's
    wording.
- **HTTP:** every 405 from `/mcp` now carries `Allow: POST`, an SDK fix that a
  test now pins.
- The skill tests and both smoke scripts read the skill through the client
  SDK's `SkillsClient`, which re-hashes every file against its digest.

## 1.26.0 — 2026-10-26

- **`get_person`** returns a `coverage_note` saying how to read its counts: they
  describe the records AMIRA holds, not the person's full work, and publications
  are harvested from University of Bayreuth repositories (EPub, ERef), so a
  partner-centre researcher's publications appear only if deposited there and a
  zero is not evidence that none exist. Until now only the `person_profile`
  prompt said this, and hosts rarely invoke prompts: in a traced answer about a
  partner-centre researcher, the zero reached the answer without its reason. The
  note is curatorial guidance, so `AMIRA_GUIDANCE=off` drops it; the tool list
  and its token baseline are unchanged.
- **Development:** happy-dom 21.0.4 replaces 20.x, closing a high-severity
  advisory (GHSA-834v-8h66-3h79) that failed `npm audit` and with it the first
  1.26.0 build. It only renders the MCP Apps in tests.

## 1.25.0 — 2026-10-20

- **`get_entity_graph`** takes `types`, a list of entity types to keep among the
  neighbours, applied before the node and edge bounds: a people-only graph used to
  lose its people to high-count languages, formats and subjects before the bounds
  were reached. Every graph now reports `neighbour_types`, the number of distinct
  neighbours of each type, so a filtered view says what it leaves out.
- **Entity-graph app** redrawn on the co-occurrence hub's encoding: one labelled
  sector per entity type, spoke length growing with the records behind a
  neighbour's strongest link, and labels on a common ring, so they no longer
  collide. Type chips filter through `types`. Selecting a spoke now lists that
  neighbour's links and opens the records behind the strongest one directly under
  the diagram; re-centring the graph is a separate button. The centre shows the
  seed's name rather than its type.
- **App preview** takes `seed`, `types` and `pseudonymise` URL parameters, for
  reproducible and anonymised figures of the graph.

## 1.24.0 — 2026-10-19

- **Person profiles are records, not assessments.** The `person_profile` prompt
  now states that a profile is compiled from the records AMIRA holds and
  reflects what the platform catalogues, not the person's full work, role or
  standing; that it is not an evaluation of the person or their scholarship;
  that gaps come from cataloguing and harvesting (the bibliography is harvested
  from University of Bayreuth repositories, so partner-centre publications may
  be missing) and absence of a record is not proof of absence; and that the
  answer should present records with their AMIRA links, open by saying it is
  not an assessment, and not rank, rate or judge the person. The server
  instructions carry a one-sentence version (1,943 of Claude Code's 2,048
  characters). Both are guidance, so `AMIRA_GUIDANCE=off` drops them; the tool
  list is unchanged.

## 1.23.0 — 2026-10-08

- **`get_person`** reports research-section roles in `as_section_principal_investigator`
  and `as_section_member`, each with its funding phase. It used to read projects
  only, so a section PI who leads no project came back as PI on nothing.
- **`get_person`** lists podcast episodes and videos the person speaks in or
  hosts (`podcasts`, `videos`, with role and totals). People who share them count
  as collaborators (`shared_recordings`), and a name credited only on a podcast
  or video now resolves.

## 1.22.0 — 2026-10-08

- **Guidance switch.** `AMIRA_GUIDANCE=off` serves the same tools without the
  curatorial guidance, for an evaluation's guidance-ablation condition: no
  server instructions, prompts or companion skill; no tool or resource titles
  and descriptions, no parameter descriptions and no
  `anthropic/alwaysLoad` hint; errors keep their `code` and a terse message
  without `suggested_tool`, `available_values` or advice; results drop the
  `*_hint` fields, the export `note` and person suggestions. Names, schemas and
  data are unchanged, and the default (`on`) changes nothing. The tool list
  weighs 12,040 estimated tokens on stdio with guidance and 8,485 without; the
  token baseline now records both.
- **Near-miss person suggestions.** A `search_persons` keyword or a
  `resolve_entity` query with `type=person` that matches nobody returns up to
  five authority names a typo away, in either name order and ignoring accents,
  each with its typed id and `amira_url`, plus a one-line `hint`: "Rudigr Seeman"
  now offers `Seesemann, Rüdiger`. Searches that match are unchanged.
  `resolve_entity`'s output schema gains the optional `suggestions` and `hint`
  (+60 tokens), so the `research` profile's surface gate rises from 10,000 to
  10,100.
- **Empty-result guidance.** `resolve_entity` without a `type` also offers
  person near misses when nothing resolves, and `get_person` lists them in
  `available_values` after the partial matches when a full name is not found.
  A filtered `search_*` call (research items, projects, publications, podcasts,
  videos, persons) that finds nothing carries a one-line `hint` to drop or
  broaden filters one at a time. Searches that match are unchanged, and no
  surface tokens are added. With `AMIRA_GUIDANCE=off` these go, and so do
  `search_research_items`' relaxation `suggestions` and place `did_you_mean`.

## 1.21.0 — 2026-10-08

- **Apps:** filter fields offer their values. In the bibliography, Language is a
  dropdown counted for the current search and Author suggests every catalogued
  name. In the timeline, Project ID becomes a Project dropdown by name and
  Subject suggests headings. In the map, Country is a dropdown. The widgets load
  these lists themselves through allowlisted tools (`search_projects` and
  `list_subjects` are new to the allowlist), so they add no model tokens. A field
  stays a text input until its list arrives or if the host refuses the call.

## 1.20.0 — 2026-10-07

- **Removed:** WissKI. `get_research_item` no longer returns `wisski_url`, and
  the snapshot no longer captures `dre:wisskiUrl`.
- **Capabilities:** `tools`, `prompts` and `resources` declare
  `listChanged: false`, since the lists never change while a process runs.
  2026-07-28 clients no longer hold a listen stream open for them.
- **Conformance:** the MCP conformance job runs against
  `conformance-baseline.yml`. Its 31 entries are checks that need the suite's
  own reference fixtures. Any other failure, or a baselined check that starts
  passing, fails the job.

## 1.19.0 — 2026-10-07

Implements the 6 October review, except WissKI links and licence/access-rights
filters, which were set aside.

- **Matching.** `country` compares the chain root exactly, with aliases
  (Côte d'Ivoire = Ivory Coast, DRC, Eswatini, …): `country=Niger` went from 390
  items to 86. `location` matches exactly, then by word prefix, with
  `did_you_mean` on a miss. Typed ids are accepted in both vocabularies
  (`item:`/`research_item:`, `pub:`/`publication:`) by every tool. `get_person`
  refuses name fragments. Folding covers curly quotes, dashes, œ/æ/ß. String
  arguments are trimmed. Multi-word keywords AND their words (`"quoted phrases"`
  stay literal). BibTeX escapes LaTeX specials.
- **Host fit.** Instructions shrink to 1,781 characters, under Claude Code's
  2,048 cut, with the citation rules first. Pages stop under 40,000 characters.
  Errors are text-only. Entry tools are always loaded. Profiles remove tools
  through the SDK and register only their apps. Limits clamp and echo on every
  tool. Behind a proxy, rate limiting keys on `X-Real-IP` or the right-hand
  `X-Forwarded-For` hop.
- **Snapshot schema v5.** Subject authorities (646 LCSH headings, 2,438 tags),
  media files on 1,419 items, record timestamps, contributor affiliation at the
  time, typed identifiers, provenance as linked institutions, GND identifiers,
  organisation name variants, every abstract with its language, podcast duration
  and transcript model, video thumbnails.
- **New capabilities.** Five prompts with argument completion; resources for
  records, the dataset and exports (`resource_link` from the search tools'
  `export` parameter); IIIF manifest and collection links; `has_media`,
  `added_since`/`modified_since`, podcast `language`, `vocabulary=lcsh|tag` and
  `near`/`bbox` filters; collaborators. The `search` ranker now matches word starts,
  weights by IDF and interleaves corpora on ties.
- **Engineering.** Hermetic tests (278), dated evaluation replay, Node 22/24/26
  plus Windows CI, SHA-pinned actions, least-privilege release with build
  attestations, a non-blocking conformance job, MCP Registry publication, a
  leaner `.mcpb` (6.96 MB), MCP SDK 2.3.1, Node ≥ 22.

Contract changes: error results carry no `structuredContent`; podcast/video `id`
is a string with a numeric `omeka_id`; `get_research_item.identifiers` and
`.provenance` are objects; pages may hold fewer than `limit` rows
(`response_limited`).

## 1.18.1 — 2026-10-05

Replaces the MCPB CLI's unused signing and editor stack with a focused unsigned
ZIP packer and the official manifest schema. This removes the unpatched
node-forge dependency that blocked the 1.18.0 release; both audits are clean.

## 1.18.0 — 2026-10-05

Implements the 5 October review.

- **Six research tools:** `resolve_entity`, `get_entity_graph`,
  `get_text_passages`, `compare_collections`, `get_data_quality`,
  `get_snapshot_changes`, all bounded and exposure-gated (33 core / 35 HTTP tools).
- **Seven MCP Apps** on the official Apps SDK: graph, map and bibliography join
  overview, sections, related and timeline.
- **Durable refresh:** immutable snapshot generations behind an atomic pointer,
  a cross-process writer lock, item-set signatures and a weekly forced crawl.
- **Identity:** typed graph ids, homonyms kept apart, deduplicated related
  counts, pageable snapshot-pinned evidence per edge.
- Shared query layer and snapshot-owned indexes (overview 15.6 → 0.4 ms median,
  snapshot load 437 → 198 ms). Tool profiles. Discovery ceiling raised to 14,000
  tokens.

## 1.17.0 — 2026-09-09

Publication RIS and CSL-JSON alongside BibTeX, bounded bibliography exports
through `search_publications`, and richer publication detail: conference
descriptions, page extent, supplementary links, access and rights statements,
thesis advisers, linked contributor and publisher ids.

## 1.16.0 — 2026-09-09

- `list_publication_facets` (27 core / 29 HTTP tools); language and subject
  filters shared by publication search and facets; ERef/EPub identifier aliases
  and series metadata preserved.
- BibTeX respects exposure settings. `fetch` error signalling and health recovery
  fixed. MCP App messages accepted only from the parent frame. Local HTTP binds
  to `127.0.0.1` by default. Snapshot counts and unique ids validated.

## 1.15.0 — 2026-09-04

Maps the nine new EP3 publication classes (newspaper articles, translations,
habilitations, master's and bachelor's theses, …) before they reach the snapshot,
ahead of the bibliography growing from 277 to 562 publications.

## 1.14.0 — 2026-08-12

Research items generate their own citations: `get_research_item` returns
`generated_citation` plus BibTeX, RIS or CSL-JSON, with tiered creator roles,
brace-protected corporate names and exposure-aware fallbacks.

## 1.13.0 — 2026-08-12

Skills over MCP (then the SEP-2640 draft): the companion skill is served over the
connection (`skills/list`, `skills/get`, skill files as resources) from a
build-time catalog with SHA-256 digests. Zero cost to the tool surface;
`AMIRA_SKILLS=0` withdraws it.

## 1.12.0 — 2026-08-04

Token budgets are measured and gated: `scripts/weigh.mjs` measures the
`tools/list` surface and every tool's response at its maximum limit against a
committed baseline (`test/token-baseline.json`).

## 1.11.0 — 2026-07-31

Pull-request CI across Node versions, manifest validation, dependency audit,
stdio/HTTP smoke tests; Origin and Host validation and graceful shutdown on HTTP;
strict input schemas; `isError` on tool failures.

## 1.10.0 — 2026-07-29

MCP TypeScript SDK v2. The server negotiates the 2026-07-28 revision
(`server/discover`, `resultType`) on both transports, keeps 2025-era clients
working, and emits public cache hints.

## 1.9.0 – 1.9.2 — 2026-07-27

- **1.9.2:** `get_video`/`get_podcast` accept string ids; the companion skill has
  one source of truth (`.claude/skills/amira-mcp/`).
- **1.9.1:** the unit suite no longer crawls the live API or writes to
  `~/.amira-mcp`.
- **1.9.0:** funding-phase Gantt (`list_research_sections`) and co-occurrence hub
  (`find_related`) apps.

## 1.7.0 – 1.8.0 — 2026-07-27

- **1.8.0:** collection-overview dashboard app; shared app chassis; palette
  sourced from DREVisualizations.
- **1.7.1:** an unset MCPB setting no longer leaks `${user_config.…}` into every
  `amira_url`.
- **1.7.0:** accent-insensitive matching everywhere; `fetch` pages text honestly;
  faster search; HTTP rate limiting; lighter tool surface; first MCP App
  (timeline).

## 1.6.0 — 2026-07-05

Publication full text (`bibo:content`) and `list_journals`; `AMIRA_EXPOSURE`
levels for the benchmark; in-process tool-layer test harness. Also ships
`list_cluster_partners` and periodic live refresh (1.5.0 was never tagged).

## 1.4.0 – 1.4.5 — 2026-06-18 to 2026-06-20

- **1.4.3–1.4.5:** Omeka ids and AMIRA links polish; release hygiene.
- **1.4.2:** `fetch` accepts the same transcript paging as `get_video`/`get_podcast`.
- **1.4.1:** `country` restored as a real filter; `fetch` omits video transcripts
  by default.
- **1.4.0:** opt-in transcripts, flat locations, zero-result relaxation hints,
  effective-limit echoes, structured errors.

## 1.2.0 – 1.3.0 — 2026-06-17

- **1.3.0:** remote Streamable HTTP transport with ChatGPT `search`/`fetch`.
- **1.2.0:** `list_years`; companion skill renamed `amira-mcp`.

## 1.0.0 – 1.1.0 — 2026-06-10

- **1.1.0:** `list_collections`, `collection` filter, thumbnails (snapshot
  schema v3).
- **1.0.0:** re-sourced from the public Omeka S API; renamed
  `amira-mcp-server`; `amira_url` citations; podcasts and YouTube videos with
  transcript search; subjects and tags merged.

## 0.1.0 – 0.2.0 — 2026-06-01

The `africa-multiple-mcp-server` era: 18 tools over the AMIRA dashboard's static
JSON. 0.2.0 added research-section funding phases and order-independent
person-name matching.
