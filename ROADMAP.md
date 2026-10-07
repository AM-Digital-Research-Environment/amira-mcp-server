# Roadmap — amira-mcp-server

What comes next, and the decisions that still govern the code. What each release
changed is in [CHANGELOG.md](CHANGELOG.md).

The dated reviews of 5 and 6 October 2026 and their implementation reports were
retired on 7 October, once 1.18 and 1.19 had shipped them. Their open
recommendations are below. The originals remain in Git at tag `v1.19.0`
(`docs/review-2026-10-0{5,6}.md`, `docs/implementation-2026-10-0{5,6}.md`, with
the raw benchmark JSON). Earlier history (the June 2026 migration plan and the
progress log) remains in Git at the same tag.

## Next priorities

1. **Deploy 1.19.** On 7 October the public endpoint still answered 1.17.0,
   while the MCP Registry already listed 1.19.0 with that endpoint. In
   `omeka-s-docker`, commit the `compose.amira.yml` change (default pin v1.19.0,
   `AMIRA_TRUST_PROXY=true`, `AMIRA_PROXY_HOPS=1`), run
   `deploy/amira/update-amira-mcp.sh v1.19.0`, and check `serverInfo.version`
   with a raw `initialize` request. Then reconnect the ChatGPT connector, which
   caches tool schemas.
2. **Retrieval effectiveness.** Build a blind multilingual query set with judged
   answers and citations. Use it to measure the 1.19 ranker (word-start matching,
   IDF, corpus interleaving, German/Portuguese stopwords) and the AND semantics of
   multi-word keywords. Do this before BM25 or semantic search. The fixture tests
   and dated evaluation sets cover deterministic contracts, not real-world recall.
3. **Apps in real hosts.** The local preview emulates host RPC; it certifies no
   host. Check the seven apps in Claude, ChatGPT and VS Code. In ChatGPT, measure
   whether apps attached to data tools (`search_publications`, `list_locations`,
   `find_related`) re-render too often before deciding on render-only tools, which
   would add discovery tokens. Follow with a UI audit in a real host (narrow
   panels, keyboard use, accessible alternatives to the graph).
4. **CI follow-ups.**
   - Triage the conformance suite's failures. The 1.19.0 run passed tools-list,
     resources-list, prompts-list, caching and DNS-rebinding, but failed at least
     one check in 25 scenarios. Separate the expected ones (scenarios that call
     the suite's own test tools and prompts) from real defects. Record the
     expected ones in `conformance-baseline.yml` and pass `--expected-failures`,
     so the job can gate.
   - Golden files for `tools/list` with an `--update` flag.
   - Inspector `skills/list --verify --require-digests`, the check ChatGPT's
     skill importer applies.
   - Dates to track: `ubuntu-latest` moves to Ubuntu 26 on 19 October; Node 24
     enters maintenance on 20 October; Node 26 becomes Active LTS on 28 October.
5. **Scale when evidence warrants it.** Profile larger corpora and long-running
   export workloads before adding databases, search services, the Tasks extension
   or authenticated features to this public read-only server.

## On request

- **WissKI links** (`dre:wisskiUrl`: 795 persons, 89 of 93 projects). Set aside
  in 1.19.
- **Licence and access-rights filters** (CC-BY-NC-SA-4.0 on 1,219 items; access
  Public / No Raw Data / Group / Individual). Set aside in 1.19.
- `find_related` with several seeds (AND) and year-windowed co-occurrence.
- Semantic search over descriptions, abstracts and transcripts, only after the
  judged query set exists. Embeddings would be precomputed offline in the fetch
  pipeline, never at request time.
- A live mode on the References API for fresh aggregations. Deferred: it
  conflicts with D2. Revisit only if snapshot staleness becomes a real complaint.
- MCPB `screenshots` for the extension directory.

## Known limitations

- A keyword that matches inside an expanding letter (`s` in `ß`) can yield two
  passages with the same original range.
- Snapshot history is local and bounded, not an archive. Probe signatures cannot
  prove a transactional Omeka snapshot. A crashed writer's lock is removed by an
  operator, only after stopping every process sharing that cache.
- `fetch` keeps its own text rendering. The record resource reuses the `get_*`
  projections.

## Upstream issues (other repositories)

- **DRE SEO:** `/cite/{id}/bibtex` keys entries on the legacy `dre:id`, against
  this server's citation rule. Don't link to it until that is fixed.
- **Rights:** item 10185's IIIF manifest declares
  `rightsstatements.org/vocab/CNE`, while its `dcterms:license` is
  CC-BY-NC-SA-4.0.
- **DRE Linked Data:** endpoints return 404/403; it is not deployed.

## Protocol watch

- MCP roadmap: a redesign of the `tools/call` result shape (keep `textResult`
  centralised so it lands in one file), progressive tool discovery, ETags on top
  of `ttlMs`/`cacheScope`.
- Skills: Claude is not in the extension's client matrix, so keep shipping
  `amira-mcp-skill.zip`.
- MCPB: stay on manifest 0.3; 0.4 only adds the `uv` Python server type.
- Don't adopt MCP logging, sampling or roots (deprecated by SEP-2577); stderr is
  correct. Don't reintroduce `mcpb sign` while node-forge GHSA-86w9-cpqp-85rv is
  unpatched.

## Decisions in force

Settled in [issue #1](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/issues/1)
and the June 2026 migration. Source comments cite them by number.

| # | Decision |
|---|---|
| D1 | Package, extension, artifact and repository are named `amira-mcp-server` (renamed from `africa-multiple-mcp-server` in June 2026). |
| D2 | **Offline-first.** A build-time snapshot from the public Omeka API; no per-call API requests; live refresh is optional (`AMIRA_LIVE_REFRESH`). |
| D3 | The citation field is **`amira_url`** = `https://data.africamultiple.uni-bayreuth.de/s/amira/item/<o:id>`. |
| D4 | Dedicated `search_podcasts` / `search_videos` tools, not overloaded into research items. |
| D5 | Dashboard URLs are dropped entirely, not redirected. |
| D6 | Subjects and tags form one subject facet (Omeka stores both as `dcterms:subject`). Since 1.19, `vocabulary=lcsh\|tag` tells them apart without splitting the facet. |
| D7 | Tool names are stable: tools are added, not renamed. |
| D8 | Research items and projects keep `dre_id` as a key; every record also carries its Omeka id; lookups accept either. |
| D9 | **Snapshot integrity by construction:** crawl into staging, write a manifest (per-template counts, max `o:modified`, fetchedAt, schema version), promote atomically, refuse a shortfall. Since 1.18: immutable generations behind an atomic pointer, with a writer lock. |
| D10 | Token discipline lives in the tool layer: compact JSON, slim references, no transcripts or full text in summaries. `weigh --check` gates surface and response budgets. |
| D11 | Freshness probe: the pair (max `o:modified`, per-template totals), since 1.18 with item-set signatures and a weekly forced crawl. |
| D12 | The site setting is `AMIRA_SITE_BASE`; the pre-1.0 `AMIRA_DASHBOARD_BASE` is still honoured. |
| D13 | `get_podcast` / `get_video` carry the windowed transcript; search results never do. |
| D14 | The companion skill is `amira-mcp`, with one source in `.claude/skills/amira-mcp/`. |
| D15 | **Dual transport:** the stdio `.mcpb` and a public, unauthenticated Streamable HTTP endpoint, which adds the OpenAI `search`/`fetch` tools. |

## Out of scope

- Per-call live API querying (D2).
- Writing to Omeka: the server is read-only for good.
- Querying WissKI or SPARQL: that is a separate system (links may return on
  request, above).
- OAuth, sampling, elicitation and resource subscriptions, beyond
  `notifications/resources/list_changed` after a refresh.
