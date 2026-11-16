# Roadmap — amira-mcp-server

What comes next, and the decisions that still govern the code. What each release
changed is in [CHANGELOG.md](CHANGELOG.md).

The dated reviews of 5 and 6 October 2026 and their implementation reports were
retired on 7 October, once 1.18 and 1.19 had shipped them. Their open
recommendations are below. The originals remain in Git at tag `v1.19.0`
(`docs/review-2026-10-0{5,6}.md`, `docs/implementation-2026-10-0{5,6}.md`, with
the raw benchmark JSON). Earlier history (the June 2026 migration plan and the
progress log) remains in Git at the same tag. The refactoring review of 6
November (`docs/review-2026-11-06.md`) shipped in 1.35.0 and was retired after
1.36.0; it remains in Git at tag `v1.36.0`, and its two open options are under
"On request".

## Next priorities

1. **Deploy 1.36.0 from the published image.** On 7 October the public endpoint
   still answered 1.17.0, while the MCP Registry already listed a newer release
   with that endpoint. From 1.31.1 every release pushes the tested image to
   `ghcr.io/am-digital-research-environment/amira-mcp-server:<version>`. In
   `omeka-s-docker`, point `compose.amira.yml` at that image (it also sets
   `AMIRA_TRUST_PROXY=true` and `AMIRA_PROXY_HOPS=1`; consider
   `AMIRA_MCP_BEARER_TOKEN` with nginx adding the header), pull the tag instead
   of rebuilding on the host, and check `serverInfo.version` with a raw
   `initialize` request. Then reconnect the ChatGPT connector, which caches tool
   schemas.
2. **Curator access, step 2** ([#26](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/issues/26)).
   Step 1 (1.36.0: `AMIRA_ACCESS=curator`, personal tokens, the `.mcpb` relay)
   reaches header-capable clients only. Still to do, see
   [docs/curator.md](docs/curator.md) ("Not yet"):
   - OAuth sign-in through Pocket ID, so claude.ai, ChatGPT and Claude
     Desktop custom connectors can reach the curator endpoint without a
     static header (Keycloak as the fallback if Pocket ID falls short);
   - a read-only Omeka role with `view-all`, replacing the `reviewer` service
     account, which could edit;
   - paging private podcast and video transcripts (reported only by length in
     `restricted` today);
   - `get_text_passages` over private full text;
   - app views (map, graph, …) that link private records to their
     `admin_url` instead of showing them without a link.
3. **Retrieval effectiveness.** Build a blind multilingual query set with judged
   answers and citations, and score it with `npm run evaluate-retrieval`
   (precision, recall, nDCG and MRR at k, per query and on average, with the
   snapshot recorded). Use it to measure the 1.19 ranker (word-start matching,
   IDF, corpus interleaving, German/Portuguese stopwords) and the AND semantics of
   multi-word keywords. Do this before BM25 or semantic search. The fixture tests
   and dated evaluation sets cover deterministic contracts, not real-world recall.
4. **Apps in real hosts.** The local preview emulates host RPC; it certifies no
   host. Check the seven views of `ui://amira/app.html` in Claude, ChatGPT and
   VS Code: that each host sends `toolInfo` (or that shape routing holds), runs
   the gzip bootstrap, and handles the shared selection (`ui/update-model-context`,
   "Ask about this selection"). In ChatGPT, measure
   whether apps attached to data tools (`search_publications`, `list_locations`,
   `find_related`) re-render too often before deciding on render-only tools, which
   would add discovery tokens. Follow with a UI audit in a real host (narrow
   panels, keyboard use, accessible alternatives to the graph).
5. **CI follow-ups.**
   - Make the conformance job gate: drop its `continue-on-error` once a CI run
     confirms the `conformance-baseline.yml` result seen locally (exit 0).
   - Adopt GitHub's `uses: $/...` self-repository syntax for the local
     composite actions once actionlint and Dependabot are known to handle it,
     and re-enable zizmor's `self-repository` audit (`.github/zizmor.yml`).
   - Golden files for `tools/list` with an `--update` flag.
   - Inspector `skills/list --verify --require-digests`, the check ChatGPT's
     skill importer applies.
   - **Open decision: an arm64 image.** The release image is `linux/amd64`
     only (a plain `docker build` on `ubuntu-latest`). Adding `linux/arm64`
     means a multi-platform buildx build, a health check and Trivy scan per
     platform, and pushing a manifest list instead of the saved, checksummed
     tarball the publish job verifies today. Worth it only if a deployment
     needs arm64.
   - Dates to track: Node 22, the declared floor (`engines`, `manifest.json`,
     `@types/node`, the 22 and 22.0.0 lanes), reaches end of life on 30 April
     2027; raise the floor to 24 then. Node 24 has been in maintenance since 20
     October 2026 and Node 26 Active LTS since 28 October, so the single-version
     lanes run 26.
6. **Scale when evidence warrants it.** Profile larger corpora and long-running
   export workloads before adding databases, search services or the Tasks
   extension. Authentication stays confined to curator mode (step 2 above); the
   public server keeps serving without a credential.

## On request

- **Licence and access-rights filters** (CC-BY-NC-SA-4.0 on 1,219 items; access
  Public / No Raw Data / Group / Individual). Set aside in 1.19.
- `find_related` with several seeds (AND) and year-windowed co-occurrence.
- Semantic search over descriptions, abstracts and transcripts, only after the
  judged query set exists. Embeddings would be precomputed offline in the fetch
  pipeline, never at request time.
- A live mode on the References API for fresh aggregations. Deferred: it
  conflicts with D2. Revisit only if snapshot staleness becomes a real complaint.
- MCPB `screenshots` for the extension directory.
- **Cheaper output schemas** (6 November review, M7): output schemas are still
  the largest share of `tools/list`. Either type deep arrays loosely
  (`get_entity_graph` edges, per-corpus counts in `get_collection_overview`;
  about −1,500 to −2,500 chars) or advertise output schemas only on app tools
  (keeping `search`/`fetch`, whose ChatGPT contract expects them). Both trade
  contract strictness for tokens, so they wait for a reason.
- **Split the largest test files** per tool family (6 November review, T4):
  readability only, no correctness gain; do it alongside other work in them.
- **ILAM full-text map:** move `FULLTEXT_SOURCE.tag` when DRE Visualizations
  releases a new map (a snapshot from the old pin then counts as stale).
  Passage search over ILAM's full text is a rights decision with ILAM and
  Rhodes University, not a code change; the server serves only derived numbers
  until it is taken.

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
- WissKI, entirely: no querying, no SPARQL, and no links. The crawl ignores
  `dre:wisskiUrl`.
- OAuth on the public server (curator mode gets it in step 2), sampling,
  elicitation and resource subscriptions, beyond
  `notifications/resources/list_changed` after a refresh.
