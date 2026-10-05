# Implementation report — 5 October 2026

Version **1.18.0** implements the approved [technical review](review-2026-10-05.md).
The existing read-only tool names, citation exports, exposure levels and older
MCP clients remain supported. Work is local; no release or deployment was made.

## Delivered changes

- **Shared query layer and indexes.** Research-item search, comparisons, maps and
  timelines share predicates. Relaxation hints evaluate each predicate at most
  once per record. Snapshot-owned indexes cache normalized fields, facets,
  overview counts, location ancestry and graph memberships. OpenAI search ranking
  is separate from fetch rendering. Response, pagination, matching, text-window
  and summary helpers now have focused modules behind the existing barrel.
- **Identity and evidence.** `get_person` accepts exact IDs and refuses ambiguous
  names. Related counts deduplicate contributor roles and repeated city/country
  references per source record. Places retain IDs through their ancestor chains;
  map evidence uses `location_id`. Graph nodes use typed IDs, keep homonyms apart,
  label unresolved/literal nodes, and separate explicit links from co-occurrence.
  Each edge has a source citation and a pageable, snapshot-pinned evidence list.
- **Six research tools.** `resolve_entity`, `get_entity_graph`, `get_text_passages`,
  `compare_collections`, `get_data_quality`, and `get_snapshot_changes`. Graphs cap
  at 100 nodes, 200 edges and 60,000 JSON bytes; passages cap at ten documents and
  twenty results per page. Comparisons disclose denominators, missingness and
  overlap. Diffs require retained same-source history. Input length/range limits
  and exposure gates apply to the new paths, including warmed caches.
- **Seven MCP Apps.** The official Apps SDK replaces the custom bridge. New graph,
  map and bibliography apps join overview, sections, related and timeline. Controls
  resolve entities, retrieve evidence, filter shared research selections and
  request bounded citation downloads through the host. Tables, keyboard controls,
  light/dark themes, status/error feedback and offline assets support these views.
  See [app behavior, preview instructions and Natural Earth attribution](apps.md).
- **Durable refresh.** API origin and installation path identify the cache;
  mismatched bundle/cache manifests are refused. Immutable generations and an
  atomic pointer replace destructive promotion, with a cross-process writer lock,
  two prior generations and cleanup grace. An older concurrent crawl cannot roll
  back a newer generation. Item-set signatures and weekly forced crawls broaden
  freshness detection. Selective transient retries, bounded Retry-After,
  cancellation, a refresh deadline and sanitized status improve operations.
- **Protocol and deployment.** Modern 2026-07-28 entry points, legacy compatibility,
  finalized Skills result/digest/byte-size contracts, selective output schemas,
  64 KiB HTTP request limits, bounded rate-limit state and graceful shutdown.
  Profiles reduce discovery payloads. Windows packaging and offline container
  health join the Node 20/24/26 CI matrix. Docker can consume a reviewed snapshot
  with `SNAPSHOT_STAGE=bundled`; refresh releases compare transformed content hashes.

## Measured performance

Same September 9 snapshot, Node 24.19.0, full exposure, sequential in-memory MCP
calls, one first call plus thirty warm samples per query. Times are milliseconds.
These local measurements are not an HTTP load test or retrieval-quality benchmark.

| Query | Before median | After median | Before p95 | After p95 |
| --- | ---: | ---: | ---: | ---: |
| overview | 15.57 | 0.42 | 31.24 | 3.49 |
| subjects | 30.77 | 0.12 | 80.46 | 0.47 |
| locations | 10.01 | 0.56 | 18.01 | 1.06 |
| timeline | 2.94 | 2.13 | 5.63 | 4.77 |
| item_keyword | 29.97 | 6.60 | 116.30 | 8.22 |
| empty_combination | 55.36 | 12.34 | 93.11 | 19.11 |
| related | 11.26 | 9.89 | 16.88 | 24.80 |
| publications | 12.37 | 8.13 | 22.59 | 13.92 |
| search_all | 55.05 | 37.87 | 73.90 | 52.63 |
| search_projects | 1.41 | 0.86 | 1.89 | 1.38 |

Snapshot load: **436.96 → 197.81 ms**.
Observed end-of-run heap: **188.12 → 195.96 MiB**;
this is a GC-sensitive sample, not peak-memory measurement. Server factory mean:
**3.20 → 4.88 ms**, reflecting the
larger tool/schema surface. Related-query p95 increases despite its lower median;
results now include identity and corpus-specific evidence counts. Do not infer a
uniform speedup from the aggregate changes.

A snippet-offset regression found during development was corrected with sparse
Unicode offset indexes. Regression tests cover decomposed accents, surrogate
pairs, balanced normalization expansions/contractions and cache invalidation.
The final numbers above include that fix. Raw [before](benchmark-2026-10-05.json)
and [after](benchmark-implemented-2026-10-05.json) measurements are committed.

## Discovery and response budgets

Full mode has **33 core / 35 HTTP tools**, with **11 output schemas** on HTTP.
The full-profile discovery ceiling deliberately rises from 10,000 to 14,000
estimated tokens to accommodate the additions and useful schemas. Smaller profiles
retain tighter gates; full mode remains the compatibility default.

| Profile | HTTP tools | Estimated discovery tokens | Ceiling |
| --- | ---: | ---: | ---: |
| full | 35 | 12,319 | 14,000 |
| research | 24 | 9,480 | 10,000 |
| discovery | 14 | 5,621 | 6,500 |
| visualization | 16 | 7,927 | 9,500 |

The stdio full surface is 11,380 estimated tokens. Measurement uses UTF-8 bytes/4,
not a billing tokenizer. The [response baseline](../test/token-baseline.json) also
records text bytes and complete serialized wire bytes because text plus structured
content duplicates data in transit. The 20,000-token text ceiling remains enforced;
the largest measured result is research-item search at about 15,000 tokens, followed
by the maximum graph at about 14,800. Example queries cannot prove an arbitrary future
snapshot will fit; count/byte caps and the real-snapshot CI gate remain necessary.

## Dependencies and upstream documentation

Registry checks on 5 October report no outdated direct dependencies and no
compatible transitive updates. `npm outdated --all` still lists newer major versions
outside upstream constraints (for example Hono's node adapter and MCPB's Zod 3),
plus uninstalled optional/platform packages; these were not forced across API boundaries.
Versions:
MCP server/client **2.3.0**, node adapter **2.1.1**, Apps **2.0.3**, Zod **4.6.5**;
MCPB **2.1.2**, TypeScript **7.0.2**, esbuild **0.28.2**, Node types **26.6.4**,
rimraf **6.1.3**, YAML **2.9.1**. The scoped MCPB tmp override remains **0.2.7**.
The lockfile is updated; Dependabot groups weekly MCP npm updates and checks Actions
monthly. Node 26-slim is pinned by digest in the Dockerfile.

Production audit reports **zero vulnerabilities**. The complete audit still fails
on [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv): MCPB's
node-forge 1.4.0 dependency has no patched registry release. npm reports two high
entries (the vulnerable package and its dependent) for that single advisory.
The development packaging dependency is excluded from the self-contained runtime;
the audit gate remains enabled and no unsupported override conceals the finding.

Implementation follows the [MCP 2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28),
[SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/),
[Apps extension](https://modelcontextprotocol.io/docs/extensions/apps), and
[finalized Skills extension](https://modelcontextprotocol.io/extensions/skills/overview).
Apps negotiates its own 2026-01-26 wire revision. These are separate version domains.

## Validation and remaining limits

- **129 unit tests passed**, including source provenance, promotion fault injection,
  concurrent writers, item-set refresh, retry/cancellation, ambiguous names,
  exact place IDs, graph counts/evidence/bounds, text offsets, exposure after cache
  warmup, shared selectors, retained diffs and profile budgets.
- **11 live API tests passed** against public Omeka, including the expanded probe.
- Complete **prepack-mcpb passed**: typecheck, strict skill validation, build/unit
  tests, stdio and HTTP smoke, response budget checks and manifest validation.
  The actual stdio smoke now invokes all six new tools against the bundled corpus.
- Browser preview checked desktop and 375 px views, light/dark surfaces, graph
  keyboard evidence, map filtering, publication-only relationships, bibliography
  selection/download requests, timeline evidence and empty-state recovery. This
  local host emulates link/download responses; production-host certification is
  still separate work.
- The **Docker bundled-snapshot build passed** locally. Its Linux arm64 runtime
  used Node **26.10.0**; health, 35-tool discovery, entity resolution and graph calls
  passed. The temporary container was stopped and removed. CI adds Linux Node
  20/24/26 and Windows Node 24 coverage; that full remote matrix was not run here.
- A self-contained **1.18.0 MCPB archive** was generated successfully (about 7.4 MiB).
  Extraction into an isolated temporary directory verified 33 tools, bundled data
  and seven apps without `node_modules`. No fresh full Omeka crawl was substituted
  for the reviewed bundled snapshot.

Recovery requires an operator to remove a crashed writer's lock only after stopping
all processes sharing that cache. Probe signatures cannot establish a transactional
Omeka snapshot. Snapshot history is local and bounded, not a historical archive.
Substring/term ranking remains the retrieval model; a blind multilingual judged
benchmark should precede a BM25/semantic-search replacement. Public deployments
still need proxy-level quotas; the process limiter is a courtesy bound.
