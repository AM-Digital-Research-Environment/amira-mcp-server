# Changelog — amira-mcp-server

What each release changed, newest first. Dates are tag dates. The
[GitHub releases](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/releases)
carry the full notes and assets; [ROADMAP.md](ROADMAP.md) holds the decisions in
force and what comes next.

## Unreleased

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
