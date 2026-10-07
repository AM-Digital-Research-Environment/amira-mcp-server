# Implementation report — 6 October 2026

Version **1.19.0** implements the [6 October review](review-2026-10-06.md), except
**WissKI links** and **licence/access-rights filters**, which were set aside at the
maintainer's request. Tool names, citation URLs, exposure levels and older MCP
clients remain supported. The changes that alter a response shape are listed under
"Contract changes" so connector owners can check them.

## Correctness

| Finding | 1.19 behaviour | Evidence (bundled snapshot) |
| --- | --- | --- |
| `country` / `location` were substring matches | `country` compares the chain root exactly, with an alias table (Côte d'Ivoire = Ivory Coast, DRC/Congo-Kinshasa/Zaire, Eswatini/Swaziland, USA, UK, …). `location` matches exactly at any level when the name is known and falls back to word prefixes otherwise. A miss returns `did_you_mean` with stored names. `list_locations` and `find_related` use the same matcher | `country=Niger` 390 → **86**; `country=Côte d'Ivoire` 0 → **91** |
| Two typed-id vocabularies | `src/typedIds.ts` parses both everywhere; every `get_*` accepts a typed id; `get_entity_graph` canonicalises `item:`/`pub:` seeds | `fetch("publication:29919")`, `get_text_passages(["pub:29919"])`, `get_entity_graph("item:7392")` all succeed |
| `get_person` credited fragments | A name must be a complete credit (authority record or full contributor/author name); fragments return `not_found` with `resolve_entity` candidates. The prefix fallback in publication roles is gone | `get_person("Ba")` → `not_found`, 10 candidates |
| Typographic punctuation | `fold` maps curly quotes, dashes, non-breaking spaces and œ/æ/ß before NFD; offset helpers use the same mapping | "Sankara's Agenda" 0 → 17 (AND semantics, below) |
| Untrimmed arguments | `src/tools/policy.ts` trims every string argument after validation; empty optional strings are dropped, an empty required one returns `invalid_argument` | `subject="Architecture "` 0 → 4 |
| BibTeX specials | `& % $ # _ ~ ^ \` are escaped in field text; `url`/`doi` stay raw; unusual types get readable labels ("Bachelor's thesis") | |
| Relaxation hint named `year` | Now `year_from/year_to` | |
| Exposure gating differed | One `researchFilterError` gate for search, years, locations, comparisons and exports | `list_years(filters:{keyword})` allowed at `descriptive` |
| Multi-word keywords | Every word must match (any field); `"quoted phrases"` stay literal; English/French/German/Portuguese stopwords drop. Applies to research items, publications, podcasts, videos | |

## Protocol and host fit

- **Instructions** shrink from 3,327 to **1,781 characters** and lead with the
  citation rules, under Claude Code's 2,048-character cut. A unit test enforces both.
- **Result size.** Paged results stop under 40,000 characters (`response_limited`,
  exact `next_offset`); the graph is bounded at 42,000 bytes and publication export
  pages at 44,000. Every measured response at maximum limit is now ≤ 40,723
  characters (largest before: 59,808); `weigh --check` fails at 45,000.
- **Errors** are text-only (`isError`, JSON error in `content`), so no client
  validates an error against a tool's output schema.
- **Discovery.** `annotations.title` dropped (hosts use `title`); entry tools carry
  `_meta["anthropic/alwaysLoad"]`; `maxToolInputElements` = 200.
- **Profiles** remove tools through the SDK's public `RegisteredTool.remove()` and
  register only the apps whose tools remain; the monkey-patched `registerTool` is
  gone.
- **Limits** clamp and echo `requested_limit` / `effective_limit` on every tool,
  including the six research tools that previously rejected over-limit values.
- **Apps.** The bibliography downloads only when the host advertises the draft
  `downloadFile` capability; otherwise it shows the citations to copy. UI stays on
  the existing seven tools: OpenAI recommends render-only tools, but moving the
  apps would add tools, and the effect should first be measured in ChatGPT.
- **HTTP** logic moved to `src/httpApp.ts`. With `AMIRA_TRUST_PROXY` the rate-limit
  key is `X-Real-IP` or the `X-Forwarded-For` hop `AMIRA_PROXY_HOPS` from the right
  (never the leftmost), and IPv6 clients share a /64 bucket. `omeka-s-docker`'s
  compose file now sets both (uncommitted there; commit after tagging v1.19.0).

## New data (snapshot schema v5)

The crawl adds the subject authorities (item set 1852) and one paginated pass over
`/api/media` (17 requests). A full crawl took 55 seconds. v4 snapshots still load;
a v4 cache counts as stale, so live refresh replaces it.

| Field | Coverage on 6 October |
| --- | --- |
| Media files on research items (MIME, file URL, source, size) | 1,419 items; JPEG 998, PNG 315, WebP 110 |
| Record timestamps `created` / `modified` | every record |
| Contributor affiliation at the time (value annotation) | 5,421 credits |
| Typed identifiers | 5,184 identifiers with a type |
| Provenance as linked institutions | 2,043 items |
| Person authority identifiers | 82 people (GND) |
| Organisation name variants | 31 organisations (e.g. UJKZ, CODESRIA, MIASA) |
| Subject vocabulary | 646 LCSH headings with id.loc.gov URIs, 2,438 tags |
| Place type, Wikidata (now output) | 42 countries, 120 places |
| Podcast duration, audio file, transcript model | 43/43; all transcripts by Qwen3-Omni-30B-A3B-Instruct |
| Video thumbnails | 140/140 |
| Every abstract with its language; every language | 51 publications with several abstracts |
| `extent`, `rdspace_handle` | 1,662 and 75 items |

## New capabilities

- **Filters:** `has_media`, `added_since`, `modified_since` (research items),
  `added_since` (publications), podcast `language`, `vocabulary=lcsh|tag`
  (subjects), `near` / `bbox` (places).
- **Fields:** IIIF manifest and media list on items, IIIF collection links,
  `media_types` in item summaries, collaborators, identifiers and name variants
  on people and organisations, Wikidata on places, sample items and media count
  on projects, ids on every list row.
- **Prompts** (`literature_review`, `project_dossier`, `person_profile`,
  `place_report`, `transcript_evidence`) with argument completion from the
  snapshot's names. They cost nothing in the per-turn tool payload.
- **Resources:** `amira://record/{kind}/{id}` (reuses the `get_*` projections),
  `amira://export/{corpus}/{format}/{query}` (CSV/JSONL; BibTeX/RIS/CSL-JSON for
  publications; returned as `resource_link` by the search tools' `export`
  parameter), and `amira://dataset` (schema.org Dataset).
- **Ranking** (`search`): word-start matching, IDF weighting, corpus interleaving
  on ties, German and Portuguese stopwords. `search("music", 50)` now returns
  items, videos, projects, a podcast and a publication instead of 50 items.

## Contract changes for connector owners

- Error results no longer carry `structuredContent`.
- Podcast and video `id` is a string (as elsewhere); `omeka_id` is the number.
- Multi-word `keyword` filters AND their words instead of matching one phrase.
- `country` is exact (with aliases); a `location` that names no stored place
  matches word prefixes only.
- `get_person` refuses incomplete names; `get_institution` and
  `get_research_section` also take `id`.
- `get_research_item.identifiers` and `.provenance` are objects
  (`{value, type}`, `{name, amira_url}`).
- Over-limit values are clamped on every tool instead of rejected by four of them.
- Pages may hold fewer than `limit` results (`response_limited`).

## Performance

Same machine and benchmark as the 1.18 report: Node 24.19.0, sequential in-memory
calls, one first call plus 30 warm samples per case, full exposure, no live
refresh. 1.19 runs on the new v5 snapshot (it adds subjects and media). Two
consecutive runs agreed within a few percent; the second is committed as
[benchmark-2026-10-06.json](benchmark-2026-10-06.json). Times in milliseconds.

| Case | 1.18 median | 1.19 median | 1.18 p95 | 1.19 p95 |
| --- | ---: | ---: | ---: | ---: |
| overview | 0.42 | 0.17 | 3.49 | 0.35 |
| subjects | 0.12 | 0.14 | 0.47 | 0.20 |
| locations | 0.56 | 0.25 | 1.06 | 0.74 |
| timeline | 2.13 | 1.44 | 4.77 | 4.67 |
| item_keyword | 6.60 | 4.06 | 8.22 | 8.00 |
| empty_combination | 12.34 | 12.02 | 19.11 | 15.58 |
| related (subject) | 9.89 | 12.52 | 24.80 | 19.85 |
| publications | 8.13 | 3.91 | 13.92 | 6.64 |
| search_all | 37.87 | 29.59 | 52.63 | 37.32 |
| search_projects | 0.86 | 0.68 | 1.38 | 1.18 |

Snapshot load 197.8 → 180.5 ms; end-of-run heap 196 → 243 MiB (a larger snapshot
plus the new caches; a GC-sensitive sample, not a peak measurement). The subject
pivot's median rose while its p95 fell; it was not optimised further. Outside the
benchmark set, measured directly:

| Path | 1.18 | 1.19 |
| --- | ---: | ---: |
| `get_snapshot_changes` (no history) | 0.9–1.5 s per call | 47 ms first call, cached after |
| `list_groups` (default) | 240–285 ms | 14 ms |
| `get_text_passages`, one 842k-char text, no match | 190–250 ms | early exit on the memoised fold |
| Graph evidence page on a busy node | ~120 ms | cached per seed (64 most recent) |

## Testing, CI and packaging

- **Hermetic tests.** `test/helpers/env.mjs` clears every `AMIRA_*`, isolates the
  cache and cleans temporary directories; smoke tests moved to `test/smoke/`, bind
  a free port and check the child exits cleanly; the token baseline records the
  snapshot it was measured on; `weigh`, `benchmark` and `preview-apps` measure the
  shipped snapshot, never `~/.amira-mcp/cache`.
- **New suites:** matching, features, evaluation replay (15 dated questions across
  all corpora, `test/evaluations/amira-2026-10-06.xml`), tool coverage for the
  previously untested tools and every `fetch` kind, explicit output-schema
  validation at all exposure levels, background refresh, the HTTP application
  (Origin/Host, CORS, body limit, rate-limit keys), app renderers in happy-dom, and
  fast-check properties (offsets, pagination, citation well-formedness).
- **CI:** Node 22/24/26 plus Windows; typecheck once; SHA-pinned actions; timeouts
  on every job; least-privilege release and refresh workflows with step-scoped
  tokens; tag/version check; build-provenance attestations; a non-blocking MCP
  conformance job; a non-blocking MCP Registry publish (`server.json`). The rolling
  `data-latest` release drops its June assets on the next refresh and its tag moves.
- **Packaging:** the `.mcpb` excludes `server/http.js`, `server/lib.js`,
  `server/fetchCli.js`, `docs/` and Docker files; a test packs the real repository
  against an allowlist and checks author/version metadata. The Docker base image is
  pinned by digest and Dependabot tracks it. `package.json` author fixed; working
  tree normalised to LF with an `.editorconfig`.
- **Dependencies:** MCP server/client 2.3.1; fast-check and happy-dom added for
  tests; full `npm audit` reports 0 vulnerabilities. Engines `>=22`.

## Validation

Run on 6 October 2026, Node 24.19.0, Windows, against the v5 snapshot crawled the
same day (fetchedAt `2026-10-06T15:37:16.611Z`):

- `npm run pack-mcpb` — clean, typecheck, strict skill check, build, **278 unit
  tests (272 pass, 6 skipped: the 9 September evaluation set, dated to its own
  snapshot), 0 fail, 0 todo**, stdio and HTTP smoke, `weigh --check` and manifest
  validation — all passed, and packed a 28-file, 6.96 MB `.mcpb` (1.18.1: 7.78 MB).
- `npm run test:live` — 11/11 against the public Omeka API.
- The 15-question evaluation set `test/evaluations/amira-2026-10-06.xml` replays
  exactly through the tools.
- Tool surface 11,980 (stdio) / 12,921 (HTTP) estimated tokens, within the 14,000
  budget; the largest measured response is 40,723 characters.
- `npm audit`: 0 vulnerabilities.
- Five src bugs found by the new test suites were fixed before the final run:
  `search_projects` matched sections by label only; `search` did not echo a clamped
  limit; the map app had no empty state; `fold` treated precomposed and decomposed
  Ǽ/ǽ/Ǣ/ǣ differently; `foldedRanges` stranded a combining mark after œ/ß/æ.
- Not run here: the GitHub Actions matrix, the container build, the conformance
  job and the registry publish, which only run in CI or on a tag.

Known quirk: a keyword that matches inside an expanding letter (`s` in `ß`) can
yield two passages with the same original range, one per folded occurrence.

## Remaining

- **Deploy**: tag v1.19.0, run `deploy/amira/update-amira-mcp.sh v1.19.0`, commit
  the `omeka-s-docker` compose change, reconnect the ChatGPT connector.
- Measure the ranking and AND-keyword changes against a judged multilingual query
  set before further retrieval work.
- `fetch` keeps its own text rendering; the record resource reuses the `get_*`
  projections instead of a third copy.
- Upstream (other repositories): DRE SEO keys BibTeX on the legacy `dre:id`; item
  10185's IIIF manifest and its `dcterms:license` disagree; DRE Linked Data is not
  deployed.
