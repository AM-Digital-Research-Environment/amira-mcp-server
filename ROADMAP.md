# Roadmap — amira-mcp-server

**Status:** drafted 2026-06-10 · spine = [issue #1](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/issues/1)
(migration epic, all design decisions resolved) + the 2026-06-10 code/data examination of v0.2.0.

**Progress log**

- **2026-06-10 — Phase 1 implemented end-to-end on `omeka-migration`** (v1.0.0; repo rename +
  tag pending at merge). Census: `scripts/census.mjs` + committed `census-report.json`.
  Snapshot crawl ~56 s / ~110 requests → 11 corpora, **3,975 research items (v0.2.0
  parity)**, ~10 MB of transformed records. Tests all green: **12 unit** (fixture JSON-LD,
  every value type), **8 live-API**, **22-tool smoke** with citation-contract asserts
  (`amira_url` everywhere, `dashboard_url` extinct, transcript search verified, legacy
  `fre` alias verified). Deviations discovered against the plan:
  1. **Podcast transcripts are 0/43 in Omeka** (issue #1 assumed they exist) — tools are
     transcript-ready; search falls back to title/abstract; skill caveat 8 documents it.
  2. **Sections carry only `dcterms:abstract`** — Mongo's objectives/workProgramme did not
     migrate; `get_research_section` returns a single description field.
  3. **Projects have no institutions[]/emails in Omeka** — `frapo:isFundedBy` → `funded_by`
     serves as the institution link (the `institution` filter targets it); emails are gone.
  4. **No raw BibTeX in Omeka** — `get_publication` now *generates* BibTeX from the
     structured fields; publication `venue` is a literal (`dcterms:isPartOf`).
  5. **Groups survive cleanly**: Organisation items are typed Institution (508) / Group (84);
     `list_groups` works; no `get_group` needed (`get_institution` resolves both kinds).
  6. **Related items upgraded**: `dcterms:replaces`/`isReplacedBy`/`hasVersion` are
     resolvable links exposed with their own `amira_url` (better than planned).
  7. `dcterms:modified` exists on items — kept in `dates{}`, excluded from year filtering
     (the v0.2.0 examination concern, resolved by design).
- **2026-06-10 (later) — v1.0.0 RELEASED · Phase 2 (v1.1.0) implemented.** Repo renamed via
  `gh repo rename` (redirects live); `v1.0.0` tagged — first Release run failed on CI Node 20
  (`node --test` globs need ≥21), fixed by bumping workflows to Node 22 and re-pointing the
  tag; the rerun published `amira-mcp-server.mcpb` with all gates green in CI. Phase 2 then
  landed on main: snapshot **schema v3** (item_sets corpus, 60 sets; per-item set ids +
  thumbnails), **`list_collections`** (23rd tool), `collection` filter, `collections[]` +
  `thumbnail` in item detail; 13 unit tests, smoke asserts the collection-count round-trip.
  **v1.1.0 released** the same day (workflow green end-to-end; `amira-mcp-server.mcpb`
  attached) and the user-level `africa-multiple-data` skill cross-link is in place. The
  only remaining §5 item is the local extension reinstall (grab the v1.1.0 `.mcpb`).
- **2026-06-17 — Skill renamed `africa-multiple` → `amira-mcp` (D14 reversed); `list_years`
  added (24th tool); repo-name sweep.** *Rename:* the repo rename to `amira-mcp-server` made the
  old name ambiguous against the user-level `africa-multiple-data` skill (the revisit condition
  the original D14 set). Folder + `name:` + README path updated, and the user-level skill's
  cross-reference updated to match. *`list_years`:* in-memory date histogram by year/decade, with
  a `from`/`to` window and `chronological|count` sort; an item's date range counts toward every
  year it spans (mirrors the `year_from`/`year_to` filter), and the envelope carries
  `dated_items`/`undated_items`/`year_range`. Counts bumped to 24 across manifest, README, both
  skill docs, smoke (now asserts the year + decade shapes); typecheck + 13 unit + smoke all green.
  *Repo-name sweep:* stale `africa-multiple-mcp-server` → `amira-mcp-server` in the snapshot
  User-Agent, the ROADMAP spine link, and `package-lock.json` name/version (synced to 1.1.0).
  Deliberately left: the `africa-multiple` manifest *keyword* (a valid discovery term) and the
  `~/.africa-multiple-mcp` note in `config.ts` (an accurate pre-1.0 migration reference, not a
  stale name). Follow-up: reinstall any copy already under `~/.claude/skills/africa-multiple/`.
- **2026-06-17 (later) — v1.2.0 tagged.** Version bumped (manifest + package + lock → 1.2.0);
  the `list_years` Phase-3 item moved to done in §4. The renamed `amira-mcp` companion skill ships
  inside the `.mcpb` (kept by `.mcpbignore`). The Release workflow crawls a fresh public-API
  snapshot, runs unit + live tests + smoke, packs, and publishes the `v1.2.0` GitHub Release.
- **2026-06-17 (later) — v1.3.0: remote Streamable HTTP transport + ChatGPT `search`/`fetch` (D15).**
  Added a second entry point `src/http.ts` → `server/http.js` (stateless Streamable HTTP, `POST /mcp`
  + `GET /healthz`, CORS-open) so the server is reachable by ChatGPT (Developer Mode / Deep Research),
  the OpenAI + Anthropic APIs, and Claude.ai remote connectors — one URL, no download. Server identity,
  instructions and tool registration moved into a shared `src/mcpServer.ts` factory used by both
  transports: stdio keeps the 24-tool surface; HTTP adds the OpenAI-contract `search`/`fetch` adapters
  (`src/tools/openai.ts`, typed `<kind>:<key>` ids over items/pubs/videos/podcasts, transcripts
  included) for 26. Public, no-auth (data is public, read-only). Ships a multi-stage `Dockerfile` +
  systemd/nginx recipe; intended to run on the amira Linux host so live refresh reads the local Omeka
  API. New `smoke:http` (round-trips a real MCP client over HTTP) added to `prepack-mcpb`. Verified:
  typecheck + 13 unit + stdio smoke (24) + HTTP smoke (26) green. Deploy (hosting the endpoint) is the
  remaining ops step, on the cluster's side.
- **2026-06-17 (later) — endpoint deployed; `search` fix; v1.3.0 released.** The HTTP endpoint went
  live on the amira host. Probing it as a ChatGPT connector exposed a recall bug: the OpenAI `search`
  tool matched the whole query as one substring, so multi-word / natural-language queries (what ChatGPT
  sends) returned ~0 — "Yoruba architecture" → 1, a full question → 0. Fixed to tokenize, drop EN/FR
  stopwords, and score per term (1 → 20, 0 → 20), and extended `search`/`fetch` to cover projects and
  research sections; README documents the surface. **v1.3.0 tagged + released** (CI green, `.mcpb`
  attached). The live endpoint must be redeployed from this tag to serve the fix.
- **2026-06-18 — v1.4.0: ChatGPT test-report fixes (usability + clarity).** A 26-tool audit (via the
  live ChatGPT connector) flagged response-size, matching-semantics, geodata and date issues — none
  were crashes. Addressed across tools + skill + README + manifest:
  - **Geodata simplified (owner decision).** Dropped the city/region/country *level* taxonomy
    (`level=city&country=Nigeria` returned nothing because cities sit directly under countries here).
    `list_locations` is now one flat, item-count-ranked list (hierarchy rolled up); `search_research_items`
    keeps a single hierarchy-aware `location` filter — the separate `country` filter is removed (a stray
    legacy `country` arg is routed to `location`, so nothing silently breaks).
  - **Transcripts opt-in.** `get_video` / `get_podcast` omit the transcript by default (expose
    `has_transcript` + `transcript_length`); `include_transcript=true` + `transcript_offset` /
    `transcript_max_chars` page it (cap 25k/call). `search_videos` / `search_podcasts` return a
    `transcript_snippet` around transcript matches. ChatGPT `fetch` keeps the transcript by default (the
    connector can't pass flags) but gains `include_transcript` / `max_chars`; `search` gains `limit` + `types`.
  - **Zero-result relaxation hints.** `search_research_items` returns `suggestions` (which single filter to
    drop, and how many items that surfaces) when a strict AND set matches nothing.
  - **Effective-limit reporting.** Capped `limit` now echoes `requested_limit` / `effective_limit`.
  - **find_related matching documented.** Description + a response `matching` field explain substring vs
    name vs hierarchy vs id matching, and why `matched_items` (items) can differ from `list_subjects`
    (headings) — the count discrepancy the report queried.
  - **Date quality.** Podcasts/videos carry `date_status` (published/scheduled/unknown), flagging
    future-dated records without hiding them.
  - **Uniform errors.** Misses return `{ error: { code, message, suggested_tool?, available_values? } }`.
  - Verified: typecheck + 13 unit + stdio smoke (24) + HTTP smoke (26) green. Deferred to §4 (need
    use-case/data work): multi-format citation export (RIS/CSL) and authority-alias/matched-form metadata.
- **2026-06-18 (later) — v1.4.1: two genuine regressions from a v1.4.0 retest.** A second 26-tool
  ChatGPT audit reported ~6 issues; triage against `src` showed **only two were real in the shipped
  code** — the rest (get_video transcript params "rejected", `list_locations` still showing `level=…`,
  `search` missing `limit`/`types`) were the **connector caching pre-v1.4.0 tool schemas**: the
  `"Additional properties are not allowed"` error is client-side Ajv against the stale schema, and the
  report even quoted v1.4.0's own `transcript_hint` text in the live response — proving the server was
  current. Fixed the two real ones:
  1. **`country` filter restored as a real, advertised param.** v1.4.0 removed it from the schema and
     tried to route a stray `country` arg into `location`, but MCP/zod strips unknown keys before the
     handler runs, so `country=Nigeria` was silently ignored and returned the whole 3,975-item
     collection. `country` is now its own predicate matching the **country level (chain root)**, so it
     narrows (304 for Nigeria, == the any-level `location` count), is echoed in `filters`, and is a
     drop-candidate in zero-result `suggestions`. Re-adding (vs documenting-away) also un-breaks
     still-cached connectors, which keep sending `country`.
  2. **ChatGPT `fetch` is metadata-only by default for video/podcast.** v1.4.0 appended the transcript
     by default (rationale: Deep Research can't pass flags) — but a ~46k-char transcript tripped
     OpenAI's safety layer and **blocked `fetch(video:…)` entirely**. Default flipped to
     `include_transcript=false`; the omitted case adds a `transcript_hint` + `transcript_length` and a
     text marker, and `include_transcript=true` still appends it. A failed-open metadata fetch beats a
     blocked one.
  - Smoke tests strengthened: the old `country` check asserted only `total_matches > 0` (passed *because*
    the bug returned everything); now asserts it narrows below the full count, echoes the filter, and
    stays ⊆ the `location` match. HTTP smoke now asserts fetch omits-by-default + opt-in grows the body.
  - Verified: typecheck + 13 unit + stdio smoke (24) + HTTP smoke (26) green. **Action for the user:**
    redeploy the HTTP endpoint and **refresh/reconnect the ChatGPT connector** so it re-pulls the tool
    schemas — that alone clears the cache-only "regressions".

**Sequencing rule (the one that governs everything):** the server re-platforms onto the
**Omeka S API first**. None of the examination findings are fixed on the dashboard-era data
layer — each one either *dies* with that layer, *transforms* into an Omeka mapping
requirement, or *carries* into the rewritten tool layer. The triage is explicit in §1.3 so
nothing is silently lost.

---

## 0 · Where we are

- **v0.2.0** (current `main`): 18 read-only tools over an in-memory snapshot of the amira
  SvelteKit dashboard's static JSON (MongoDB-shaped), bundled in the `.mcpb`, with optional
  live refresh and dashboard-URL citations.
- **Issue #1** (2026-06-08): re-source from the public **Omeka S** instance
  (`data.africamultiple.uni-bayreuth.de`, site `amira`), rename to **`amira-mcp-server`**,
  cite via **`amira_url`** item permalinks, add **podcasts + YouTube videos** with
  transcript search, **merge subjects + tags**. Offline-first is a hard requirement.
- **Examination** (2026-06-10): the snapshot audit (3,975 items) found three heavily-filled
  fields no tool exposes (dates 99 %, physical description 100 %, sponsor 99 %), a
  BayGlo2025 reconciliation bug, a torn-refresh cache bug, a ~24 % response-size overhead
  from pretty-printing, and several smaller consistency/token issues.
- **Live-API probes** (2026-06-10, grounding §2.4): research item template 10 carries
  `frapo:isFundedBy` (sponsor), `marcrel:*` per-role contributors, `dcterms:spatial`
  linked locations, `dcterms:description` descriptive text, `dre:id` ↔ `o:id`; a YouTube
  item carries a 41,570-char `bibo:content` transcript; a sampled podcast has **no**
  `bibo:content` (transcript fill is partial — handle absence gracefully).

---

## 1 · Decisions

### 1.1 Locked (issue #1 — do not relitigate)

| # | Decision |
|---|---|
| D1 | Rename package, manifest, artifact (`amira-mcp-server.mcpb`) **and the GitHub repo** |
| D2 | **Offline-first stays**: build-time snapshot from the Omeka API; no per-call API hits; live refresh optional and off-able |
| D3 | Citation field is **`amira_url`** = `https://data.africamultiple.uni-bayreuth.de/s/amira/item/<o:id>` |
| D4 | **Dedicated `search_podcasts` / `search_videos`** tools (not overloaded into research items) |
| D5 | **Dashboard URLs dropped entirely** — no secondary link |
| D6 | **Subjects + tags merged** into one subject facet (Omeka stores both as `dcterms:subject`) |

### 1.2 Proposed in this roadmap (confirm or veto before Phase 1 starts)

| # | Proposal | Rationale |
|---|---|---|
| D7 | **Keep the 18 existing tool names** unchanged; only *add* tools | Prompt/skill continuity; the breaking change stays confined to citations + the tag facet |
| D8 | **`dre_id` remains the research-item key**; every record also carries `o_id`; `get_research_item` accepts either | `dre:id` is the stable, human-meaningful identifier; `o:id` is needed for `amira_url` anyway |
| D9 | **Snapshot integrity by construction**: fetch into a staging dir, write a snapshot manifest (per-template counts + max `o:modified` + fetchedAt), promote atomically, refuse to promote on any required-template shortfall | Direct lesson from the v0.2.0 torn-refresh bug — design it out instead of patching it |
| D10 | **Token discipline is part of the Phase-1 tool layer**, not a later pass: compact JSON (no pretty-print), slim item refs in profile/sample lists, no null-filter echo, transcripts never in summaries | The tool layer is being rewritten anyway; retrofitting costs double |
| D11 | Freshness probe = the **(max `o:modified`, per-template totals) pair** from the snapshot manifest vs the live API | `o:modified` alone misses deletions; totals alone miss edits |
| D12 | `AMIRA_DASHBOARD_BASE` → **`AMIRA_SITE_BASE`**, accepting the old var with a deprecation warning for one minor version | Painless for existing installs |
| D13 | Add **`get_podcast` / `get_video`** detail tools alongside the search tools | Transcripts are too big for search results; detail is where the capped transcript lives |
| D14 | Companion skill renamed `africa-multiple` → **`amira-mcp`** (folder + `name:`) | Original D14 kept the name to avoid breaking installed copies; the repo rename to `amira-mcp-server` then made `africa-multiple` ambiguous against the user-level `africa-multiple-data` skill (the documented revisit condition), so the rename is now taken. Installed copies must be reinstalled under the new folder name |
| D15 | **Dual transport**: keep the stdio `.mcpb` (offline, local Claude) AND add a remote Streamable HTTP endpoint (`server/http.js`) serving the 24 tools + OpenAI `search`/`fetch`; **public, no-auth** | One hosted URL reaches ChatGPT, the OpenAI/Anthropic APIs and Claude's remote connectors; the data is already public + read-only, so auth would add ops for no security gain. stdio stays the zero-setup local path; `search`/`fetch` are HTTP-only so the `.mcpb` surface is unchanged |

### 1.3 Examination-findings triage (nothing lost, nothing wasted)

**Dies with the dashboard layer** (do *not* fix on v0.2.x):

| Finding | Why it dies |
|---|---|
| BayGlo2025 half-reconciliation (empty section, name mismatch) | The `EXTERNAL_PROJECTS` shim is deleted; in Omeka, external collections are real items/item sets with `dcterms:isPartOf` (§2.2 verifies this during the build) |
| Torn-refresh cache corruption | Refresh pipeline is rewritten; the lesson becomes **D9** |
| `mongoJSON.ts` Extended-JSON + `l1/l2/l3` quirk | Mongo/dashboard artifacts; replaced by the Omeka transform |
| `LANG_GROUPS` `fre`/`fra` unification + missing `mas` | Languages become linked authority items (set 19) with labels; a slim query-side alias map may survive (§2.2 verifies) |
| `dev.geo.json` + `coordsFor` | Location items carry `geo:lat`/`geo:long` natively |

**Transforms into an Omeka mapping requirement** (Phase 1 §2.4, Phase 2):

dates exposure (the #1 gap) · physical description (+ keyword recall) · sponsor
(`frapo:isFundedBy`) · related items · collections (item sets) · research-section URL ·
publication date precision.

**Carries into the rewritten tool layer** (Phase 1 §2.5, tagged ⟨exam⟩ below):

order-independent name matching for project PI/member filters · `find_related`
seed-exclusion uses the same predicate as its match · paginate-then-map ·
compact `textResult` · slim `contributed_items` / `sample_items` · drop null-filter echo ·
version single-sourcing via esbuild define · smoke-test coverage of all `get_*` tools.

(One v0.2.0 nuisance disappears for free: every publication becomes an Omeka item, so the
constant per-row `/publications` `dashboard_url` is replaced by a real per-item `amira_url`.)

---

## 2 · Phase 1 — the migration epic → **v1.0.0, `amira-mcp-server.mcpb`**

One epic, sequential workstreams, each gated by `typecheck && build && smoke`.
Work on an `omeka-migration` branch; rename the repo at merge time.

### 2.1 Fetcher & snapshot (`scripts/fetch_data.mjs` rewrite)

- [x] Crawl per resource template / item set: Persons (4), Organisation (2), Location (3),
      Projects (5), Research Sections (7), Research Items (10), Publications (11–20 / set
      29918), Podcasts (21 / set 39095), YouTube videos (22 / set 39192), playlists (set
      39193), plus authority sets needed for labels (Languages 19, Genres 21, …).
- [x] `per_page=100`, loop sized by `Omeka-S-Total-Results` (read from **GET** headers —
      the instance returns 405 on HEAD). ~100 requests total; concurrency 2–4, retry with
      backoff, polite delays.
- [x] Fetch `/api/properties` once and bake a `marcrel:*` (and friends) code→label map into
      the snapshot, so the runtime never needs the vocabulary API.
- [x] **D9**: staging dir → snapshot manifest (per-template counts, max `o:modified`,
      fetchedAt, schema version) → atomic promote; abort on shortfall vs live totals.
- [x] Store the snapshot as **transformed records** (see 2.3), not raw JSON-LD — JSON-LD is
      ~5–10× the useful payload; transform at build time keeps the bundle and startup lean.
      Transcripts stored full-length but in a separate per-corpus file if size warrants.

### 2.2 Verification pass (one-off scripts, before code hardens)

- [x] **Property census** across all ~9,400 items: fill rate per property per template —
      the Omeka analogue of the 2026-06-10 snapshot audit. Confirms where dates live
      (`dcterms:created`/`issued`/`date`/…), what holds physical description beyond
      `dcterms:format` (extent/medium?), related-items properties, and section page URLs.
      Output checked into `scripts/` for rerunning after instance-side changes.
- [x] Verify external collections (ILAM, BayGlo2025): items ↔ project/item-set links and
      display names — the source-side fix for the v0.2.0 BayGlo bug. If linkage is wrong
      **in Omeka**, file it against `MongoDB2OmekaS` (authoritative), don't shim it here.
- [x] Verify language values (linked items vs literals) → decide the fate of `languages.ts`.
- [x] Verify `dre:id` coverage on template-10 items (key for D8).
- [x] Spot-check 20 random `amira_url`s → 200.

### 2.3 Transform, types, store

- [x] New `src/omekaJSON.ts` (replaces `mongoJSON.ts`): JSON-LD value arrays → plain
      records; linked values keep `{label: display_title, o_id: value_resource_id}`;
      `marcrel:*` properties fold into `contributors[{name, role, o_id}]`.
- [x] `src/types.ts` rewritten around the Omeka shapes; `src/data.ts` DataStore indexes:
      by `o:id`, by `dre_id`, items-by-project, **section-by-project precomputed once**
      ⟨exam⟩; no `EXTERNAL_PROJECTS` shim; no dead accessors (v0.2.0's unused
      `getGroup`/`peekStore` — don't recreate).
- [x] Runtime live refresh = probe (D11, 1 request) → full re-crawl into staging → atomic
      swap, reusing the build-time fetcher module. Off-able via `AMIRA_LIVE_REFRESH`.

### 2.4 Field mapping (research items — grounded by the 2026-06-10 probes)

| v0.2.0 / Mongo field | Omeka property | Note |
|---|---|---|
| titles (main + translated) | `dcterms:title`, `fabio:hasTranslatedTitle` | |
| typeOfResource | `dcterms:type` | |
| subjects **and tags** | `dcterms:subject` | merged (D6); linked authority items |
| abstract / `pd.desc` | `dcterms:description` (+ `dcterms:abstract` where used) | closes the v0.2.0 keyword-recall gap **if indexed** — see 2.5 |
| **dates** (99 % filled, never exposed in v0.2.0) | `dcterms:created` / `issued` / `date` / … per census | **must end up in both summary (`year`/`date`) and detail (`dates{}`)** |
| sponsor (99 %) | `frapo:isFundedBy` | linked authority; expose in detail |
| locations l1/l2/l3 | `dcterms:spatial` → Location items (`geo:lat`/`geo:long`) | coordinates native |
| contributors + roles | `marcrel:*` (54 role properties) | fold via property-label map |
| audience | `dcterms:audience` | |
| identifiers | `dcterms:identifier` + `dre:id` | |
| physical description | `dcterms:format` (+ extent/medium per census) | expose in detail |
| access condition | `dcterms:accessRights` | |
| related items | per census (`dcterms:relation`/`succeeds`/…) | expose in detail |
| collection membership | `o:item_set` | per-project sets 6259–6295 etc. |
| project | `dcterms:isPartOf` | |
| WissKI link | `dre:wisskiUrl` | optional secondary link in detail |

### 2.5 Tool layer port (all of `src/tools/*`)

- [x] `src/urls.ts` → single `itemUrl(oId)`; every record emits `amira_url`; publications
      keep external `url` (DOI/permalink) as primary + `amira_url`.
- [x] Keep the 18 tool names (D7); inputs unchanged except: `tag` filter/facet/entity-type
      folds into `subject` (D6) — `list_categories` enum becomes
      `genres | languages | resource_types`.
- [x] **Keyword haystack (research items): title + translated title + description +
      abstract + identifiers + dre_id** — fixes the v0.2.0 recall gap on the ~2,500
      abstract-less items ⟨exam⟩.
- [x] ⟨exam⟩ carry-ins, baked in as written: `nameMatchesQuery` on `search_projects`
      `principal_investigator`/`member`; `find_related` exclusion reuses its match
      predicate; slice page *then* map summaries; `get_person`/`get_institution`
      `contributed_items` and `find_related.sample_items` use a slim ref
      `{dre_id, o_id, title, role?, type_of_resource, year, amira_url}`; `filters` echo
      includes only filters actually passed; `textResult` emits **compact** JSON
      (structuredContent unchanged).
- [x] `get_collection_overview`: counts gain `podcasts`, `youtube_videos`; breakdowns
      unchanged otherwise; `data_snapshot` reports the snapshot-manifest freshness pair.

### 2.6 Podcasts & YouTube videos (D4, D13)

- [x] `search_podcasts`: keyword (title + abstract + **transcript**), series
      (`dcterms:isPartOf`), person (`marcrel:spk`/`hst`), year; summary = title, series,
      episode no., date, speakers, `fabio:hasURL`, `amira_url` — **never the transcript**.
- [x] `search_videos`: keyword (title + abstract + **transcript**), playlist, speaker,
      language, year; same summary discipline.
- [x] `get_podcast` / `get_video`: full metadata + transcript capped at `CHARACTER_LIMIT`
      (25 k chars) with `transcript_truncated` flag (probe: one transcript is already
      41.5 k chars) and `transcript_length`. Absent transcripts (sampled podcast had none)
      → `transcript: null`, never an error.
- [x] When a transcript match triggers a search hit, say so: `matched_in: "transcript"`.

### 2.7 Rename & packaging (D1)

- [x] `package.json` name, `manifest.json` (name, display_name, descriptions, homepage →
      Omeka site, repo/support links, tool list incl. the 4 new tools), artifact name in
      `pack-mcpb`/workflows/`.mcpbignore`, README.
- [x] **Done at merge (2026-06-10):** GitHub repo renamed `africa-multiple-mcp-server` →
      `amira-mcp-server` via `gh repo rename` (old URLs redirect; issues/releases intact).
- [x] ⟨exam⟩ single-source the version: esbuild `define` injects `package.json` version
      into `src/index.ts`.
- [x] Server `instructions` rewritten: `amira_url` citation rules (keep the
      no-bare-ids / no-id-ranges discipline verbatim), name-order note, snapshot note.

### 2.8 CI (refresh + release workflows)

- [x] `refresh-data.yml`: replace the `generatedAt` comparison with the D11 probe pair;
      artifact `amira-mcp-server.mcpb`; rolling `data-latest` unchanged otherwise.
- [x] `release.yml`: artifact rename only.

### 2.9 Tests & acceptance

- [x] `smoke-test.mjs` ⟨exam⟩: add `get_research_item`, `get_project`, `get_publication`,
      plus podcast/video search-by-transcript-keyword and one `get_video`; assert every
      result carries a well-formed `amira_url` and **no** `dashboard_url`.
- [x] Parity check vs v0.2.0: research-item count ≥ 3,975; persons/projects/sections in the
      same ballpark; publications ≥ 259.
- [x] Issue #1 acceptance criteria, verbatim, as the release gate; plus D9 integrity
      criteria (no promote on shortfall).

### 2.10 Docs & companion skill (ships **with** v1.0.0, not after)

- [x] Skill `africa-multiple` (folder name kept, D14): SKILL.md + `data-model.md` rewritten
      to Omeka shapes (`amira_url`, merged subjects, dates, new tools); `tools-by-task.md`
      → 22 tools; drop the `fre`/`fra` caveat if 2.2 confirms it obsolete; deduplicate the
      funding-phase section lists to **one** place (SKILL.md) ⟨exam⟩; keep citation
      discipline and coverage caveats (they survive unchanged).
- [x] README: data-source section, tool table (22), example questions (add a transcript
      one), architecture note (Omeka, not dashboard).

---

## 3 · Phase 2 — **v1.1**: finish "use all the data"

Whatever the 2.2 census shows but Phase 1 didn't ship (Phase 1 must ship dates, merged
description search, sponsor/physical-description/related-items in detail — this phase
covers the long tail):

- [x] `list_collections` (snapshot schema v3 adds the `item_sets` corpus + per-item set ids):
      ranked by research-item count, each with its browsable `…/s/amira/item-set/<id>` page;
      `collection` filter on search_research_items; `collections[]` in item detail.
- [x] Media: `thumbnail` (large) + `has_media` in `get_research_item` — free from the item
      payload. Per-media ORIGINAL file URLs stay deferred (~1,300 extra requests per crawl;
      the `amira_url` page is the viewer).
- [x] Research-section website URL, `dcterms:provenance`, `dre:wisskiUrl` — shipped in
      Phase 1 already.
- [x] Groups parity — settled by the census in Phase 1: Organisation items typed
      Institution/Group; `list_groups` + `get_institution` cover both; no `get_group`.
- [x] Publication date precision — full `dcterms:date` stored and returned; newest-first
      sort uses year + title (dates are year-granular in the source).
- [x] Token audit — compact JSON adopted in Phase 1 (−24 % chars on a 20-item page vs
      pretty-printed v0.2.0); transcripts never in summaries; smoke output spot-checked.

## 4 · Phase 3 — **v1.2+**: demand-driven extras (each needs a use-case before build)

- **Done (v1.2.0):** `list_years` / date-histogram facet — year/decade buckets, `from`/`to` window,
  `chronological|count` sort; ranged items count toward every year they span (mirrors the year filter).
- `find_related` upgrades: multi-seed AND, year-windowed co-occurrence.
- **Citation export for research items** (report §8, deferred from v1.4.0): a generated citation string
  and multi-format export (BibTeX/RIS/CSL-JSON) on `get_research_item`, mirroring `get_publication`'s
  BibTeX. Needs a format decision + a `citation_style` param design; items already expose the raw
  `citation` (dcterms:bibliographicCitation).
- **Authority reconciliation metadata** (report §9, deferred from v1.4.0): return aliases + the matched
  form for people/institutions/places so name-order/accent matching is auditable. Blocked on data —
  aliases aren't in the current snapshot; needs a transform-pipeline change to carry them.
- **Semantic search** over descriptions/abstracts/transcripts — IWAC-parity, env-gated,
  embeddings **precomputed offline in the fetch pipeline** (never at request time),
  `gemini-embedding-2`. Exploratory: needs a corpus-fit check first.
- References-API live mode for fresh aggregations — explicitly deferred (conflicts with
  D2's offline-first simplicity; revisit only if snapshot staleness becomes a real
  complaint).

## 5 · Ecosystem docs (parallel, not blocking)

- [ ] Global `africa-multiple-data` skill (user-level): add the amira/Omeka MCP server to
      the ecosystem diagram + a "Which reference do I need?" row pointing at the companion
      skill; correct the `Ext_*` projectsData claim (the 2026-06-10 snapshot contradicts
      it — verify against Mongo; the discrepancy is what caused the v0.2.0 BayGlo bug).
- [ ] After v1.0.0: refresh the local installed extension (the currently-installed copy
      already lags v0.2.0).

## 6 · Contingency

If Phase 1 slips by more than ~a month **and** the v0.2.0 server is in active use,
cherry-pick exactly two fixes onto a v0.2.1: the BayGlo reconciliation and the
torn-refresh staging — nothing else from the examination is worth dashboard-era effort.

## 7 · Risks

| Risk | Mitigation |
|---|---|
| Omeka API down/slow at build or refresh | Retry + backoff; CI keeps last good snapshot; runtime keeps serving bundled data (unchanged guarantee) |
| Property/template drift on the instance | 2.2 census script kept in `scripts/`, re-runnable; census diff before each `data-latest` rebuild |
| Torn snapshot | D9 staging + counts manifest + atomic promote |
| Transcript bloat (snapshot + tokens) | Separate corpus file; never in summaries; capped in detail (2.6) |
| Freshness probe false-negative | D11 pair (max `o:modified` **and** totals) |
| Repo rename breaks pinned URLs | GitHub redirects; manifest/README/release links updated in 2.7 |
| Doc/skill drift (three places describe tools) | One checklist rule: any tool change touches tool description + README table + skill in the same PR |
| `dre:id` gaps on some items | 2.2 census; fall back to `o:id` as key where absent (D8 accepts both) |

## 8 · Explicitly out of scope

- Per-call live API querying (D2), writing to Omeka (read-only forever), WissKI/SPARQL
  querying (separate system; `dre:wisskiUrl` link only), dashboard URL compatibility
  (D5: dropped, not redirected).
