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
- **2026-06-19…07-04 — v1.4.3–v1.4.5 released; `list_cluster_partners` (25th tool); periodic live
  refresh (v1.5.0, unreleased).** Backfill entry: 1.4.3 shipped Omeka IDs and AMIRA links polish; 1.4.4/1.4.5
  were release-hygiene bumps; `feat: add cluster partner listings` added the partner-category tool
  (with the MongoDB2OmekaS CLUSTER_PARTNER_GROUPS offline fallback); `codex/periodic-refresh` added the
  `AMIRA_REFRESH_INTERVAL_HOURS` periodic freshness probe. v1.5.0 was version-bumped but never tagged —
  superseded by v1.6.0 below.
- **2026-08-04 — v1.12.0: token budgets are measured and gated, not audited by hand.** D10 said token
  discipline belongs *in* the tool layer; until now the evidence for it was a one-off manual count in
  this log (v1.7.0's "40,853 → 35,346 chars"). That number had already drifted to 35,398 unnoticed —
  which is the whole argument for a gate. `scripts/weigh.mjs` now measures both halves of what the
  server spends, estimating tokens as bytes/4 (deterministic, dependency-free, the same scale GitHub
  uses for its own CI schema-budget guardrail — comparable to itself, never to a bill).
  - **Surface** (`tools/list`, re-sent every turn): **7,667 tok** stdio / **8,881 tok** http, budget
    10,000 each. No tool description derives from the snapshot, so this is a pure function of the
    code — `test/unit/budget.test.mjs` gates it offline against *no data at all*, and asserts the
    empty-store measurement still matches the baseline recorded with the full snapshot. If that ever
    breaks, a description went data-dependent and the test stopped being a valid gate.
  - **Responses** (every tool at its *maximum* limit, 30 probes, full 28-tool coverage): heaviest is
    `search_research_items` at `limit=100`, **~14,974 tok**; defaults are ~165. Cap 20,000, under
    Claude Code's 25,000-token truncation. Needs real data, so `npm run weigh -- --check` runs in the
    smoke job and in `prepack-mcpb`.
  - **Drift policy, deliberately asymmetric**: surface drift >3 % is **fatal** (deterministic — any
    change is intentional); response drift >10 % only **warns** (a routine `npm run fetch-data` must
    not red the build). Absolute caps stay fatal on both.
  - **A probe whose call fails is a hard failure.** A structured refusal is ~60 tokens, so a probe
    with stale arguments would sail under every ceiling and report a tool as cheap when it was never
    invoked. Hit exactly that in development: `find_related` scored 60 tokens on a wrong arg shape.
  - Probes are mostly *derived*, not listed: any tool exposing `limit` is called with `limit: 100000`
    and left for `capLimit` to clamp, so a new search/list tool enters the budget the day it is
    registered; detail tools discover their id/name from the loaded snapshot rather than hard-coding
    ids that rot. `test/token-baseline.json` is committed — `npm run weigh -- --update` rewrites it,
    and the diff puts the price of a new tool or a richer summary into code review.
  - Verified: typecheck, 59 unit tests (9 new), `weigh --check` green; both gates confirmed to *fail*
    on a doctored baseline, and all six check branches exercised with synthetic input.
- **2026-07-31 — v1.11.0: MCP hardening and continuous verification.**
  - Added pull-request CI across supported Node.js versions, release manifest validation, production dependency auditing, and stdio/HTTP smoke tests.
  - Hardened HTTP transport with configurable Origin validation, loopback Host validation, and graceful shutdown handling.
  - Made every tool input schema strict and marked structured tool failures with the MCP-native `isError` flag.
  - Expanded deterministic unit coverage for tool contracts, read-only annotations, strict input rejection, and structured errors.

- **2026-07-29 — v1.10.0: MCP TypeScript SDK v2; the server actually speaks 2026-07-28.**
  The spec was ratified 2026-07-28; the v2 SDK landed the night before. v1.7.0 had claimed
  "2026-07-28 posture" and the README called the rest "a dependency bump" — both were optimistic.
  The migration was mechanical; making the revision *work* was not.
  - **The v1 package is not where support lives.** `@modelcontextprotocol/sdk` is frozen at 1.30.0
    with `LATEST_PROTOCOL_VERSION = "2025-11-25"` and zero 2026 code. Support ships in the scoped v2
    packages (`@modelcontextprotocol/{core,server,client,node}@2.0.0`). Checking the old package name
    gives the false reading that no SDK supports the revision yet.
  - **`npx @modelcontextprotocol/codemod v1-to-v2` did the imports** — 11 changes across 7 files, no
    `@mcp-codemod-error` markers. It missed only the type-only `import("…/server/mcp.js").McpServer`
    in `tools/_shared.ts`, and it hoists imports above file header comments.
  - **Two non-obvious gates, both found by probing the wire rather than by reading the diff.** After
    the codemod everything typechecked, all 48 unit tests and both smoke suites passed — and
    `server/discover` still answered `-32601`, `resultType` was absent, and the connection negotiated
    2025-11-25. A green suite proves the migration, not the revision.
    1. **The modern era is opt-in.** `SUPPORTED_PROTOCOL_VERSIONS` is the legacy `initialize` ladder
       and stops at 2025-11-25; the SDK deliberately keeps the 2026 string internal
       (`MODERN_WIRE_REVISION`, "no public modern-version constant"). `createAmiraServer` now names
       the revision in `supportedProtocolVersions` — the gate is literally
       `if (modernProtocolVersions(this._supportedProtocolVersions).length > 0) setRequestHandler("server/discover", …)`.
    2. **The era is owned by the entry, not the transport.** Passing the option registered the
       handler but dispatch still 404'd: a bare `StdioServerTransport` / `NodeStreamableHTTPServerTransport`
       serves the 2025 era only. `serveStdio(factory)` and `createMcpHandler(factory)` own the era
       decision and pin an instance per connection/request. `toNodeHandler` adapts the latter to the
       bare `node:http` server, so the routing, CORS and rate limiting are untouched.
  - **Back-compat is free**: `createMcpHandler`'s `legacy: 'stateless'` default answers 2025-era
    traffic with a fresh instance per request over `sessionIdGenerator: undefined` — exactly the
    wiring `http.ts` used to hand-roll, so the ChatGPT connector needs no change.
  - **Cache hints (SEP-2549), because the defaults were wrong for this server.** The SDK emits
    `{ ttlMs: 0, cacheScope: "private" }`. This server is unauthenticated and read-only, its tool
    surface is fixed at construction, and the `ui://` app HTML is a build-time constant — so
    `tools/list` / `resources/list` / `server/discover` get 1 h `public` and `resources/read` 24 h.
    Checked first that `AMIRA_EXPOSURE` gates *result content*, never which tools are listed, so
    nothing varies per caller and `public` cannot leak.
  - **28 raw `inputSchema` shapes (+2 `outputSchema`) wrapped in `z.object()`.** v2 accepts raw
    shapes only through deprecated overloads, and the overloads are all-or-nothing — wrapping the
    input alone breaks the two OpenAI tools that also declare an output schema.
  - **Verified on the wire, both transports**, with a raw JSON-RPC probe rather than the SDK client:
    `server/discover` → `supportedVersions: ["2026-07-28"]`; `tools/list` → `resultType: "complete"`,
    `ttlMs: 3600000`, `cacheScope: "public"`, `_meta` carrying `io.modelcontextprotocol/serverInfo`;
    `tools/call` → `resultType: "complete"`; legacy `initialize` → still negotiates 2025-11-25. The
    probe also confirmed the server *enforces* SEP-2243: a `tools/call` without the `Mcp-Name` header
    is rejected `-32020` (the renumbered `HeaderMismatch`). Node floor raised to 20 (v2's minimum) in
    `package.json`, `manifest.json` and the esbuild target. 48 unit tests, both smoke suites green.
- **2026-07-27 — v1.9.1 (hotfix): `npm test` was hitting the network and polluting `~/.amira-mcp`.**
  Found by reading the **v1.7.1 release run, which failed** — every fixture-dependent test in it
  asserted against live data. Cause: `config.test.mjs` (added in v1.7.1) left `AMIRA_LIVE_REFRESH` as
  an MCPB placeholder to exercise the fallback. The v1.7.1 fix resolves that placeholder to its
  default — `true` — so the test booted a server with live refresh ON, crawled the whole public
  instance, and wrote a real snapshot into the DEFAULT `~/.amira-mcp/cache`. `loadInitial()` then
  correctly preferred that newer snapshot over every other test file's fixture. v1.8.0's cache
  isolation in `tools.test.mjs` masked the breakage but not the cause: CI has been doing a needless
  full crawl on every run since (v1.7.0 release 1m27s → v1.8.0 2m15s).
  Fix: `config.test.mjs` now uses REAL values for `AMIRA_CACHE_DIR` (a temp dir) and
  `AMIRA_LIVE_REFRESH` (`0`), keeping placeholders only on the vars that caused the reported bug —
  `AMIRA_SITE_BASE` and `AMIRA_SITE_SLUG`, the ones that feed citations — and asserts the fallback
  behaviour from the resolved `config` instead of by booting a refreshing server. All three
  fixture-based suites now isolate both the data and cache dirs. Verified by deleting `~/.amira-mcp`
  and confirming the full unit run recreates nothing: **the unit suite is offline and writes nothing
  outside its temp dirs.**
- **2026-07-27 — v1.9.2: `get_video` / `get_podcast` were the only detail tools that refused a string
  id.** Found by a full verification pass over v1.7.0–v1.9.1 (typecheck, 47 unit, 10 live, both smoke
  suites, plus adversarial harnesses for malformed args, pagination edges, `amira_url` integrity,
  exposure gating and the MCP App templates — everything else came back clean). `get_research_item`,
  `get_project` and `get_publication` have always taken `z.union([z.string(), z.number()])` and
  coerced; these two alone declared `z.number().int().min(1)`, so a client that stringifies ids — the
  ChatGPT connector is the one that matters here — got a validation error on exactly those two tools
  and nowhere else. Fix: same union + `Number(id)` coercion as the rest. A non-numeric id now yields a
  clean `not_found` (`Map.get(NaN)` is `undefined`) instead of a throw. Regression test asserts string
  and number ids return identical records. Also: the companion skill now has ONE source of truth —
  `.agents/skills/amira-mcp` was a stale, gitignored duplicate (it still said "All 24 tools") and is
  now a directory junction onto `.claude/skills/amira-mcp`, which is what CI zips and the `.mcpb`
  ships. Junction, not symlink: no admin rights needed on Windows.
- **2026-07-27 — v1.9.0: funding-phase Gantt + the co-occurrence hub (4 MCP Apps total).**
  - **`list_research_sections` → `ui://amira/sections`**, a Gantt grouped by funding phase with a
    "now" marker. It exists to show one thing the JSON states but cannot show: the sections were
    redefined between AM 1.0 (2019–2025) and AM 2.0 (2026–2032), so a reader who treats the list as
    one flat set mis-reads it. Position on a shared time axis makes the two cohorts — and the fact
    that the AM 2.0 sections are seeded with ~0 items — legible at a glance. Sections with no date
    range (the synthetic "External" grouping) are listed in the caption rather than plotted.
  - **`find_related` → `ui://amira/related`**, the radial co-occurrence hub: seed at the centre, one
    labelled angular sector per relation type, spoke length = shared-item count. This is the chart
    that shows the cluster's core analytic (relationality) instead of describing it.
  - **Colour: the validator overruled the design.** Six relation types nominally want six hues, but
    no six- (or even five-) hue set from the Africa Multiple brand palette survives all-pairs CVD
    separation — the best candidates bottomed out at ΔE 2.4 (deutan) and failed the normal-vision
    floor. Rather than invent hues, identity is carried **spatially**: one labelled sector each, one
    validated accent throughout. The encoding survives greyscale, print and forced-colors, and needs
    no legend.
  - **The hub was rebuilt after looking at it.** First pass placed each label at its own spoke's end;
    rendered against real data that produced 7 genuine label collisions and labels escaping the
    viewBox (an SVG clips, so those were invisible, not merely untidy). Fixed by putting all labels
    on a common ring with leader lines, capping spokes at 4 per sector, and sizing the canvas so
    `W ≥ 2 × (R_LABEL + label width)`. Re-verified with a separating-axis test over the labels' true
    rotated bounds — the naive axis-aligned check reports false positives for rotated text.
    Result: 24 spokes, 30 labels, zero true overlaps, zero clipped.
- **2026-07-27 — v1.8.0: the collection-overview dashboard + a shared app chassis.**
  Second MCP App: `get_collection_overview` carries `_meta.ui.resourceUri` → `ui://amira/overview`,
  rendering stat tiles plus four ranked breakdowns (university, research section, resource type,
  language). Form follows the data's job — the headline counts are single values, so they are TILES,
  not a chart; the breakdowns are magnitude-by-category, so they are ranked horizontal bars as small
  multiples. Every chart is single-series with the category on the axis label, so one accent is
  correct and no legend is needed; values are direct-labelled, which doubles as the text alternative.
  - **`src/ui/shell.ts`** now holds the design tokens, the host bridge and the bar-chart primitive;
    `timeline.ts` was refactored onto it. Two copies of a protocol handshake drift — the same
    reasoning as `textWindowFields` in v1.6.0.
  - **Colour is sourced, not invented.** The palette now comes from the DREVisualizations Omeka
    module (`asset/css/dre-visualizations.css`, `dashboard-core.js`), so a chart in the chat and the
    same chart on the AMIRA site read as one system — the v1.7.0 timeline used an invented terracotta
    that matched nothing. Validated against the module's own surfaces rather than eyeballed: light
    `#007a50` on `#fdfcfa` passes every check; the theme's dark `#3fb488` sits at L 0.693, just
    outside the 0.48–0.67 dark band, so the app uses `#35a87d`, one step down, which passes.
    (Noted in passing for the module itself: its categorical palette has `#00268a` outside the
    lightness band and three hues under 3:1 contrast on the light surface.)
  - **Rendered and inspected, not just typechecked**: both apps were run against the real snapshot in
    a browser with a simulated host, and checked for label collisions, viewBox overflow, tooltip
    coverage and the light/dark token flip. The overview draws 30 bars across 4 panels with zero
    label overflow; the decade timeline draws 53 bars with zero x-label collisions.
  - **Test isolation defect found and fixed** (pre-existing, not from this change): the fixture-based
    unit tests only set `AMIRA_DATA_DIR`, but `loadInitial()` prefers whichever of {bundled, cache}
    carries the newer manifest — so once `npm run test:live` had written a real snapshot to
    `~/.amira-mcp/cache`, it outranked the fixture and 18 assertions silently ran against live data.
    `tools.test.mjs` now isolates `AMIRA_CACHE_DIR` too, and `config.test.mjs` asserts on the resolved
    config rather than on record counts. The suite is hermetic with a populated user cache present.
- **2026-07-27 — v1.7.1 (hotfix): unsubstituted MCPB placeholders leaked into every citation.**
  Reported from a live v1.7.0 install: `get_collection_overview` returned
  `"site_url": "${user_config.site_base}"`. Reproduced, and worse than reported — **every
  `amira_url` was broken** (`${user_config.site_base}/s/amira/item/7392`), i.e. the one thing the
  server exists to produce. Cause: `manifest.json` wires optional settings through
  `"AMIRA_SITE_BASE": "${user_config.site_base}"`, and when the setting has no value the MCPB runtime
  passes the placeholder through **verbatim** rather than dropping the variable; `resolveSiteBase()`
  accepted any non-empty string. Fix: a central `envValue()` in `config.ts` treats a whole-string
  `${…}` as unset (a URL that merely contains braces is still honoured), applied to *every* env read —
  `AMIRA_CACHE_DIR` had the same defect and would have created a literal `${user_config.cache_dir}`
  directory. Belt-and-braces: `site_base` gains a `default` in the manifest so substitution has a real
  value to insert. Regression test `test/unit/config.test.mjs` boots the server with the exact
  placeholder environment an all-blank MCPB install produces and asserts no response anywhere contains
  `${`. 47 unit tests.
- **2026-07-27 — v1.7.0: accent folding, honest text paging, MCP 2026-07-28 posture, MCP Apps.**
  A review pass over the v1.6.0 refactor, each item grounded by a measurement against the bundled
  snapshot rather than by inspection.
  - **Accent-insensitive matching everywhere (`src/text.ts`, the biggest recall win).** Measured
    before: `keyword="Côte d'Ivoire"` → 0 items / 1 subject, `"Cote d'Ivoire"` → 1 item / 0 subjects.
    The right spelling depended on which tool you asked, because the subject authority is accented
    while item titles are not — and a model cannot know which. `fold()` (NFD → drop combining marks →
    lowercase) now backs `containsCI`/`anyContainsCI`/`equalsCI`/`matchSnippet`, every by-name index in
    `DataStore`, `LanguageIndex`, and `nameTokens` (one definition instead of the name-only copy).
    `foldedIndexOf` guards the snippet offsets, falling back when folding changes length. Large folds
    are memoised (`foldCached`, >2,000 chars) and cleared when a refresh swaps the snapshot.
  - **`fetch` no longer lies about how much text it returned.** `capText` ran AFTER the window was
    sliced, so the metadata header pushed the body over `max_chars` and the tail was trimmed while
    `*_returned_chars` still reported the full quota — a client paging on `offset + returned_chars`
    skipped exactly the header's worth of characters. The window is now sized against the REMAINING
    budget (`WindowOpts.budget`, `docBody()`); when the header alone fills `max_chars` the tool says
    so (`*_included: false` + hint) instead of appending a slice it will trim. Verified round-trip:
    page 1 + page 2 reconstruct the text exactly.
  - **Store/HTTP lifecycle.** `ensureStore()` cached its rejection, so one transient boot failure was
    latched forever and pinned `/healthz` at 503 with no way back; it now clears and retries.
    `/healthz` reads `currentStore()` instead of a boot-time reference, so it stops reporting a stale
    snapshot after a background refresh.
  - **Search: ~2.5× faster, and length no longer beats relevance.** Fields are folded once per QUERY
    instead of once per term (`foldAll`); body hits are damped by how much text was searched
    (`bodyWeight`) so a 95k-char full text matching five common terms no longer outranks a title hit;
    the `types` filter now skips excluded corpora instead of scoring them and discarding. Measured:
    6-term query 113 ms → 42 ms; `types=["project"]` 113 ms → 2 ms.
  - **MCP 2026-07-28 readiness.** Already stateless, deterministic in tool order, stderr-only logging,
    no Roots/Sampling/Elicitation. CORS now accepts the revision's required `Mcp-Method`/`Mcp-Name`
    (+ `X-Mcp-Header`) alongside the pre-2026 headers, so browser clients on either revision pass
    preflight. `ttlMs`/`cacheScope` and `server/discover` wait on an SDK past 1.29.0.
  - **Rate limiting** on `/mcp` (`AMIRA_RATE_LIMIT`, default 120/min/client, `/healthz` exempt;
    `AMIRA_TRUST_PROXY` for `X-Forwarded-For`) — the endpoint is public and every query scans the
    whole snapshot.
  - **Tool-surface weight: 40,853 → 35,346 chars (~10.2k → ~8.8k tokens per turn).** Filter
    catalogues moved from prose into per-parameter `.describe()`; output-field enumerations dropped
    (the response already shows them); integer params given honest bounds instead of
    `minimum: -9007199254740991`. `limit` and the `*_max_chars` params keep their **lenient clamp**
    (no schema `maximum`) — a hard bound would turn `limitEcho`'s graceful degradation into a
    validation error.
  - **MCP Apps (`io.modelcontextprotocol/ui`, SEP-1865).** `list_years` carries
    `_meta.ui.resourceUri` → `ui://amira/timeline`, a `text/html;profile=mcp-app` resource
    (`src/ui/timeline.ts`) that renders the histogram inline in Claude/Claude Desktop. Self-contained
    (no external scripts, styles or origins → no CSP grants) and read-only (renders the tool result,
    never calls back), so the trust surface is zero. Non-supporting hosts ignore the `_meta`.
  - **Tests: 34 → 45 unit tests.** New `test/unit/text.test.mjs` (folding, memoisation, offset
    guarantee) and `test/unit/store.test.mjs` (failed load is retried, not latched). Tool-layer tests
    added for accent folding in both directions, the `fetch` paging round-trip, ranking, the `types`
    filter and the MCP App resource; fixture item 503 now reproduces the real accent asymmetry. HTTP
    smoke covers the CORS preflight for both revisions and the rate limiter.
- **2026-07-05 — v1.6.0: publication FULL TEXT + journals + exposure levels + tool-layer test harness.**
  Grounded by a live-API probe (53/277 publications now carry `bibo:content` extracted from the EPub
  open-access PDFs, 72k–121k chars each; 87 Journal authority items on template 23 / set 41268; journal
  articles' `dcterms:isPartOf` is now a resource link). Snapshot **schema v4**; snapshot grows ~5 MB.
  - **Publications**: transform captures `fulltext`, `venue_ref`, `status` (peer review), `funders`,
    `places_of_publication`, `relations`, `has_media`/`thumbnail`. `search_publications` keyword reaches
    into the full text (`matched_in: "fulltext"` + `fulltext_snippet`; new `venue` + `has_fulltext`
    filters); `get_publication` returns the new fields, the venue's `amira_url`/ISSN, and the full text
    opt-in + windowed (`include_fulltext`, `fulltext_offset`/`fulltext_max_chars` — same discipline as
    transcripts). ChatGPT `fetch` mirrors the same params for `pub:` ids; `search` scores fulltext.
  - **`list_journals` (26th tool)**: the venue authority ranked by publication count (ISSN, country,
    website, `amira_url`); feeds the `venue` filter.
  - **`find_related`**: publications join subject/person pivots (`matched_publications` +
    `related_publications`; pub subjects/authors feed the co-occurrence tallies).
  - **Refactors**: one shared `textWindowFields`/`textWindowAppend` behind transcripts AND fulltext
    across get_*/fetch (the v1.4.2 drift now impossible by construction); `publicationByOId`/`sectionByOId`
    maps (last linear scans gone); `store.countryOf()` centralises chain-root semantics; `filtersEcho`
    strips limit/offset; `get_person.publications` capped at 50 like items; stale "podcasts have no
    transcripts" description fixed (43/43 since 2026-06).
  - **`AMIRA_EXPOSURE` (benchmark RQ5)**: `minimal|descriptive|structured|full` gates keyword haystacks,
    structured filters, entity/facet tools (structured `exposure_restricted` errors), response fields,
    and transcript/fulltext access (`text_access_disabled`; existence flags stay visible). Experiment
    flag, default `full`, read per call. Documented in README.
  - **MCP spec 2025-11-25 alignment**: `search`/`fetch` declare `outputSchema` (SDK-validated);
    Implementation carries `title`/`description`/`websiteUrl`. Deps were already at latest (SDK 1.29).
  - **Tests**: new fixture-snapshot harness drives the REAL server in-process via InMemoryTransport
    (`test/unit/tools.test.mjs`, 15 tests: filters, suggestions, country⊆location, list_years bucketing,
    fulltext/transcript windowing edges, journals, exposure levels) + snapshot-lifecycle invariants
    (`test/unit/snapshot.test.mjs`, 6 tests: schema/count rejection, manifest-last, atomic promote,
    isStale pair) — 34 unit tests total. Live tests add fulltext + journals contracts. Smoke: 26-tool
    stdio + 28-tool HTTP with fulltext round-trips. Census gains the journal target.
- **2026-06-18 (later) — v1.4.2: align `fetch` transcript paging with `get_video`/`get_podcast`.** A
  *third* ChatGPT v1.4.1 audit re-reported the same cache-shaped symptoms; a live `tools/list` + tool-call
  probe of the shipped server confirmed `get_video` transcript paging, `search_videos` `matched_in`/snippet
  and `search_podcasts` `date_status` **all work** — the `"additional properties"` errors are client-side
  Ajv against the connector's cached pre-v1.4.0 schemas (`additionalProperties:false` on every tool). The
  one genuine, reproducible inconsistency: `fetch` accepted `include_transcript` + `max_chars` but **not**
  `transcript_offset`/`transcript_max_chars`, so a model that read `get_video`'s paging hint and tried the
  same params on `fetch` got them rejected (and `fetch` ignored offset anyway). Fixed: a shared
  `transcriptWindow()` helper now backs both video/podcast branches of `fetchDoc`; `fetch` gains
  `transcript_offset`/`transcript_max_chars` (capped 25k, same semantics as the get_* tools), keeps
  `max_chars` as the whole-body cap, and its metadata/hint advertise the paging. HTTP smoke now asserts the
  window (`transcript_returned_chars`, `transcript_offset`, `transcript_truncated`). Deferred to GitHub
  issues (not blockers): **#3** `list_locations` `level` output field, **#4** research-item citation/BibTeX.
  Verified: typecheck + 13 unit + stdio smoke (24) + HTTP smoke (26) green.

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
