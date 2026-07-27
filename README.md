# AMIRA MCP Server

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the
**Africa Multiple Interactive Research Atlas (AMIRA)**, the research-data platform
of the **Africa Multiple Cluster of Excellence** at the University of Bayreuth.
AMIRA is published on the cluster's public **Omeka S** site at
[data.africamultiple.uni-bayreuth.de](https://data.africamultiple.uni-bayreuth.de).

AMIRA is built and maintained by the Cluster's **Digital Research Environment
(DRE)**, its digital infrastructure unit. The DRE designs, builds, and maintains
the data systems that connect researchers across the **Africa Multiple Research
Centres (AMRCs)** and partner institutions worldwide. Curation and description are
joint efforts with partners at the AMRCs in **Université Joseph Ki-Zerbo**,
**Rhodes University**, the **University of Lagos**, and **Moi University**.
Bayreuth hosts the coordinating DRE infrastructure and metadata layer. **Federal
University of Bahia** is a privileged partner, not an AMRC.

Storage stays distributed by default: data remains in its local repository, while
Bayreuth holds the metadata layer that points to it. Research data becomes
findable without being relocated. High-quality metadata makes researchers' data
more discoverable and their work more visible to a wider community of peers.

This server exposes AMIRA's **projects**, thematic **research sections**, ~4,000
digitised **research items**, **people**, **institutions**, **groups**,
**collections**, the cluster **bibliography with searchable full text** (extracted
from the open-access PDFs) and its **journals**, **podcast episodes with
transcripts**, and the cluster's **YouTube videos with searchable transcripts** —
as 26 core tools an LLM can query. From one MCP interface, clients can move across
records and the places, languages, and subjects that connect them.

Every record carries an **`amira_url`** — its public page on the Omeka S site
(`…/s/amira/item/<id>`) — so findings can be **cited as links** back to the source.
AMIRA focuses on the Cluster's research data. For news, events, and general
information about the Africa Multiple Cluster of Excellence, visit
[africamultiple.uni-bayreuth.de](https://www.africamultiple.uni-bayreuth.de/).

## How it gets its data — and why nothing else is needed

The server is **self-contained and offline-first**. It reads from two sources:

1. A complete **data snapshot bundled inside the `.mcpb`** — crawled from the
   public Omeka S REST API at build time and transformed into compact typed
   records, so the server works fully offline with zero setup.
2. *(optional, on by default)* the **Omeka S API** over HTTPS. At startup, and
   then once per day while the server keeps running, a one-request probe compares
   the snapshot's freshness signature (max `o:modified` + item totals) against
   the live API; only when stale does a full re-crawl run — staged on disk and
   **atomically promoted**, so a failed or interrupted refresh can never corrupt
   the cache. If the site is unreachable, the bundled snapshot keeps serving.

End users need **no API key, no credentials, and no VPN** — it's the same openly
published data that powers the public site.

## Tools

Call `get_collection_overview` first to scope the data, then drill in.

| Tool | Purpose |
| --- | --- |
| `get_collection_overview` | Counts and breakdowns across the whole collection + snapshot freshness |
| `search_research_items` | Find items by keyword, **subject**, **location** (hierarchy-aware), contributor, project, section, university, resource type, format/genre, language, year |
| `get_research_item` | Full metadata for one item (by Omeka `id` / `omeka_id`): typed dates, roles, places with their region/country chain, sponsors, collections, related items, media thumbnail |
| `search_projects` / `get_project` | Projects by keyword, university, section, PI, member, funder — detail with item breakdown + top subjects |
| `list_research_sections` / `get_research_section` | Thematic sections with funding phases (AM 1.0 / AM 2.0), PIs, counts, projects |
| `search_persons` / `get_person` | People (either name order works) — profile across projects, items, publications |
| `list_institutions` / `get_institution` / `list_cluster_partners` / `list_groups` | Organisations (institutions, Africa Multiple partner categories, and research groups), their projects, people and items |
| `list_subjects` | Subject headings (former tags merged in) ranked by item frequency |
| `list_locations` | Every place — countries and cities in one flat list (hierarchy rolled up) — ranked by item count, with coordinates |
| `list_collections` | Collections (item sets) ranked by research-item count — pair with the `collection` filter |
| `list_categories` | Facet values: formats/genres, languages, resource types |
| `list_years` | Date histogram of research items by year or decade — coverage over time, most-covered year/decade |
| `search_publications` / `get_publication` | The cluster bibliography (incl. generated BibTeX) — **full-text search over the extracted open-access PDFs** (match snippets; full text opt-in + paged on detail) |
| `list_journals` | The journals the cluster publishes in, ranked by publication count, with ISSN and country — pair with the `venue` filter |
| `find_related` | Cross-entity discovery: pivot from a subject/place/person/project to co-occurring entities (incl. publications) |
| `search_podcasts` / `get_podcast` | Cluster podcast episodes with searchable transcripts; transcript text is opt-in on detail |
| `search_videos` / `get_video` | The cluster's YouTube videos — **full-text search over transcripts** (match snippets; transcript opt-in on detail) |

### Example questions it can answer

| You ask… | The model uses… |
| --- | --- |
| "What does the collection hold on Islam?" | `list_subjects keyword=Islam` → `search_research_items subject=Islam` |
| "Show me all the **French**-language items" | `search_research_items language=French` (codes `fr`/`fra`/legacy `fre` work too) |
| "What has Ulli Beier contributed?" | `get_person name="Ulli Beier"` (resolves to 'Beier, Ulli') |
| "Which items come from **Nigeria**?" | `search_research_items location=Nigeria` (Lagos items count too — `location` walks the place hierarchy, covering both countries and cities) |
| "What audio recordings are in the ILAM collection?" | `search_research_items project_id=37700 resource_type=Audio` |
| "In which talks does anyone discuss **decoloniality**?" | `search_videos keyword=decolonial` (matches inside transcripts, flagged `matched_in`) |
| "Which cluster publications discuss **migration control** — and what do they actually say?" | `search_publications keyword="migration control"` (matches inside the extracted full text, flagged `matched_in`) → `get_publication include_fulltext=true` |
| "Which journals does the cluster publish in?" | `list_journals` (ranked by publication count) |
| "What themes travel with **Architecture** across projects?" | `find_related entity_type=subject value=Architecture` |
| "When was this photograph taken?" | `get_research_item` → typed `dates` (created/collected/issued/…) |
| "Which **decade** does the collection cover most?" | `list_years bucket=decade sort=count` |

## Companion skill

A research-workflow skill ships in [`.claude/skills/amira-mcp/`](.claude/skills/amira-mcp/):
cluster context, a query workflow, a tool-by-task map, the citation discipline, and coverage caveats.
Install it either way:

- **Download** `amira-mcp-skill.zip` from the
  [releases page](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/releases) and
  unzip it into your Claude skills directory (e.g. `~/.claude/skills/`) — it expands to
  `~/.claude/skills/amira-mcp/`.
- **Or copy** the [`.claude/skills/amira-mcp/`](.claude/skills/amira-mcp/) folder from this repo there.

## Install (end users)

Download `amira-mcp-server.mcpb` from the
[releases page](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/releases)
and double-click it. Claude Desktop shows an install dialog; click **Install**.
No further configuration is required. The latest tagged release carries the
current data; the rolling `data-latest` pre-release always tracks the freshest
site snapshot.

## Use it from ChatGPT, the API, or any remote client

The `.mcpb` is the local, offline option for Claude Desktop. The same server can
also run as a **remote Streamable HTTP endpoint** — one HTTPS URL that ChatGPT,
Claude (web + desktop remote connectors), the OpenAI and Anthropic APIs, Cursor,
VS Code and other clients connect to by pasting a URL (no download, always-fresh
data). The remote surface serves the same 26 tools **plus** the
OpenAI-compatible `search` / `fetch` tools that ChatGPT's connectors require (28
total). Access is unauthenticated — the data is public and read-only.

`search` takes plain keywords (matched term-by-term, not as an exact phrase),
with optional `limit` and `types` to keep the result set tight, and returns
ranked hits across research items, the bibliography (reaching into publication
full text), podcasts, videos, projects and research sections. The `url` on
`search` results and `fetch` documents is
always the AMIRA/Omeka public record page; DOI, YouTube/watch, and podcast/listen
URLs are kept as secondary metadata/text links. `fetch` returns one record's full
text by the id `search` hands back — for videos and podcasts the transcript is omitted by default
(metadata + description only, since a full one can run to tens of thousands of
characters), and `include_transcript=true` pulls it in — paged with
`transcript_offset` / `transcript_max_chars` (the same names get_video /
get_podcast use). Publication full text works the same way
(`include_fulltext=true`, paged with `fulltext_offset` / `fulltext_max_chars`,
matching get_publication), and `max_chars` caps the whole text body. The
appended window is sized against what `max_chars` leaves after the metadata
header, so `*_returned_chars` is exactly what landed in `text` and the next page
starts at `offset + returned_chars` with no gap.

```bash
npm run build && npm run start:http     # → http://localhost:8787/mcp
# or, self-contained, via Docker:
docker build -t amira-mcp . && docker run -p 8787:8787 amira-mcp
```

Endpoints: `POST /mcp` (the MCP endpoint) and `GET /healthz`. Bind with `PORT` /
`HOST`.

- **ChatGPT** → Settings → Connectors → Advanced → **Developer Mode** → add
  `https://<your-host>/mcp`. Deep Research calls `search` + `fetch`; Developer
  Mode can call any of the 28 tools.
- **Claude** (web or desktop) → Settings → Connectors → **Add custom connector**
  → `https://<your-host>/mcp`.
- **OpenAI API** (Responses) — point the `mcp` tool at the endpoint:

  ```json
  { "type": "mcp", "server_label": "amira",
    "server_url": "https://<your-host>/mcp",
    "allowed_tools": ["search", "fetch"], "require_approval": "never" }
  ```

### Deploy (self-hosted, e.g. alongside the amira site)

The multi-stage [`Dockerfile`](Dockerfile) crawls a fresh snapshot at build time
and runs the self-contained bundle (no `node_modules` at runtime). On a Linux
host you can equally run it under systemd behind a reverse proxy:

```ini
# /etc/systemd/system/amira-mcp.service
[Service]
ExecStart=/usr/bin/node /opt/amira-mcp/server/http.js
Environment=PORT=8787 HOST=127.0.0.1 AMIRA_LIVE_REFRESH=true
Restart=always
User=www-data
```

```nginx
location /mcp { proxy_pass http://127.0.0.1:8787/mcp; proxy_buffering off; }
```

`proxy_buffering off` keeps the Streamable-HTTP/SSE responses flowing. Running on
the amira host lets the live refresh read the local Omeka API, so the snapshot
stays current with no extra load.

## Develop / rebuild

```bash
npm install
npm run fetch-data    # crawl the public Omeka API -> ./data snapshot (~1 min)
npm run typecheck     # tsc --noEmit
npm run build         # esbuild -> server/{index,http,fetchCli,lib}.js
npm test              # unit tests: transform fixtures, folding, snapshot + store lifecycle,
                      # and the full tool layer against a fixture snapshot via
                      # InMemoryTransport (offline)
npm run test:live     # integration tests against the live API (network)
npm run smoke         # spawn the stdio server, exercise all 26 tools offline
npm run smoke:http    # spawn the HTTP server: search/fetch + parity (28 tools), CORS
                      # preflight for both protocol revisions, and the rate limiter
```

Pack the extension:

```bash
npm run prepack-mcpb                       # clean + typecheck + build + test + smoke
npx @anthropic-ai/mcpb validate manifest.json
npm run pack-mcpb                          # -> amira-mcp-server.mcpb
```

`scripts/census.mjs` re-runs the property census behind the field mapping
(`scripts/census-report.json`) — rerun and diff it if the instance's templates
change. See `ROADMAP.md` for the migration plan and progress log.

## Continuous delivery

Two GitHub Actions automate distribution (both crawl the **public** API — no
credentials):

- **Release** (`.github/workflows/release.yml`) — on a pushed `v*` tag: fresh
  snapshot, unit + live tests, smoke, pack the `.mcpb` and zip the companion
  skill (`amira-mcp-skill.zip`), and attach both to the GitHub Release.
- **Refresh data snapshot** (`.github/workflows/refresh-data.yml`) — weekly and
  on demand; rebuilds **only when the data's freshness signature (max
  `o:modified` + per-corpus counts) changed**, updating the rolling
  `data-latest` pre-release.

> **Publishing from Actions requires a writable token.** If the organization
> disables write permissions for the default workflow token, either (a) enable
> *Read and write permissions* under **Organization → Settings → Actions →
> General → Workflow permissions**, or (b) add a repo/org secret `RELEASE_TOKEN`
> (a PAT or GitHub App token with `contents: write`). The workflows use
> `secrets.RELEASE_TOKEN` when present and fall back to the default token.

## Configuration (environment / extension settings)

| Env var | Extension setting | Default | Meaning |
| --- | --- | --- | --- |
| `AMIRA_LIVE_REFRESH` | Refresh data from the live site | `true` | Probe + refresh the snapshot from the public API at startup and on the periodic interval |
| `AMIRA_REFRESH_INTERVAL_HOURS` | — | `24` | When live refresh is on, repeat the freshness probe this often while the server is running; set `0` to disable periodic checks |
| `AMIRA_CACHE_DIR` | Refreshed-data cache directory | `~/.amira-mcp/cache` | Where refreshed snapshots are stored |
| `AMIRA_SITE_BASE` | Site base URL (advanced) | `https://data.africamultiple.uni-bayreuth.de` | Base for citations + refresh (`AMIRA_DASHBOARD_BASE` is honoured with a deprecation warning) |
| `AMIRA_SITE_SLUG` | — | `amira` | Omeka site slug used in `amira_url` |
| `AMIRA_DATA_DIR` | — | bundled `data/` | Override the bundled snapshot path (dev) |
| `AMIRA_EXPOSURE` | — | `full` | **Benchmark experiments only**: restrict which metadata the tools expose (see below) |
| `PORT` | — | `8787` | Port for the remote HTTP transport (`server/http.js`); ignored by the `.mcpb` |
| `HOST` | — | `0.0.0.0` | Bind address for the remote HTTP transport |
| `AMIRA_RATE_LIMIT` | — | `120` | Requests/minute per client on `/mcp` (`0` disables). A courtesy cap — every query scans the whole in-memory snapshot — not a security control; `/healthz` is exempt |
| `AMIRA_TRUST_PROXY` | — | `false` | Read the client IP from `X-Forwarded-For` for rate limiting. Enable **only** behind a proxy that sets it; a direct client can forge the header |

### Metadata-exposure levels (benchmark experiments)

`AMIRA_EXPOSURE` lets an evaluation run the same tasks under graded metadata
visibility — the "metadata mediation" condition of LLM-access studies. It is an
experiment flag, not an end-user setting; the default (`full`) is the normal
server. Existence flags (`has_transcript` / `has_fulltext`) stay visible at
every level; only content and relations are gated, and refusals are structured
errors (`exposure_restricted` / `text_access_disabled`) so a model can say *why*
it cannot answer rather than hallucinating.

| Level | The model sees |
| --- | --- |
| `minimal` | Titles, types, dates, URLs, media flags. Keyword search matches titles only; entity/facet/relation tools and structured filters are refused |
| `descriptive` | + descriptions, abstracts, tables of contents (searchable too) |
| `structured` | + subjects, places, people, projects, sections, collections, venues — all filters and entity tools |
| `full` | + transcripts and publication full text (default) |

## Architecture

- **Pure in-memory typed records.** The Omeka JSON-LD is transformed once at
  build time (`src/transform.ts`, evidence in `scripts/census-report.json`);
  the runtime loads compact records and indexes them at startup. No native
  bindings; the esbuild bundles are self-contained.
- **Offline-first with atomic refresh.** Bundled snapshot + staged cache
  promotion; the freshest manifest wins at startup (an old cache can never
  shadow a newer bundled snapshot).
- **Citations** are uniform: every entity is an Omeka item, so every record
  carries `amira_url = <site>/s/amira/item/<o:id>`.
- **Accent-insensitive matching everywhere** (`src/text.ts`). The collection is
  francophone-Africa-heavy and its authority records are not consistently
  accented against the free text — "Côte d'Ivoire" is the subject heading while
  item titles carry "Cote d'Ivoire". Every keyword comparison folds both sides
  (NFD, drop combining marks, lowercase), so the answer no longer depends on
  which spelling the caller guessed. Folds of large texts are memoised and
  dropped when a refresh replaces the snapshot.
- **Interactive results (MCP Apps).** `list_years` carries
  `_meta.ui.resourceUri` pointing at `ui://amira/timeline`, a self-contained
  HTML histogram served as a `text/html;profile=mcp-app` resource
  (`src/ui/timeline.ts`). Hosts that implement the
  [`io.modelcontextprotocol/ui`](https://modelcontextprotocol.io/docs/extensions/apps)
  extension (Claude, Claude Desktop) render the chart inline; every other client
  ignores the `_meta` and gets the same JSON as before. The template loads
  nothing from the network, so it needs no CSP grants.

### Protocol posture

The server is already shaped for MCP **2026-07-28**: the HTTP transport is
stateless (`sessionIdGenerator: undefined`, a fresh server per request), tool
order is deterministic, logging goes to stderr, and Roots/Sampling/Elicitation
— all deprecated in that revision — are unused. CORS accepts both generations
of headers (`Mcp-Session-Id`/`MCP-Protocol-Version` and the new
`Mcp-Method`/`Mcp-Name`/`X-Mcp-Header`). The remaining work is a dependency
bump: `@modelcontextprotocol/sdk@1.29.0` predates the revision, so `ttlMs` /
`cacheScope` on `tools/list` and `server/discover` arrive with the SDK.

## License

MIT
