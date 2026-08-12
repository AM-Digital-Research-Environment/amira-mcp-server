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
| `get_research_item` | Full metadata for one item (by Omeka `id` / `omeka_id`): typed dates, roles, places with their region/country chain, sponsors, collections, related items, media thumbnail — plus a **generated citation** and a BibTeX/RIS/CSL-JSON export (`citation_format`) |
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
| "Give me a citation for this item — and the BibTeX" | `get_research_item` → `generated_citation` + `bibtex` (`citation_format=ris`/`csl-json` for a reference manager) |
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

### …or let the server hand it over (Skills over MCP) — prototype

> **Prototype.** `skill://` resources and the `skills/*` methods implement an extension that is still
> a **draft** (SEP-2640 is unmerged), against **thin host support**. Treat this surface as
> experimental: it may change shape or be withdrawn, and the zip above remains the supported way to
> install the skill. The tools, resources and citation contract are unaffected either way.

The server also **serves that same skill over the connection**, following the draft
[SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) extension
(`io.modelcontextprotocol/skills`). Nothing to download and nothing to keep in sync: a host that
implements the extension discovers the skill on connect, and the copy it gets is the one built into
the running server rather than a zip that may predate the tool surface it describes. It is the only
route that reaches the **remote HTTP surface** — ChatGPT, Claude.ai connectors and the APIs have no
local skills directory.

| Method | What it returns |
| --- | --- |
| `skills/list` | The catalog: `skill://amira-mcp/SKILL.md`, its frontmatter, and a SHA-256 digest for every file |
| `skills/get` | One skill by URI, to refresh digests without re-listing |
| `resources/read` | Any single file — `SKILL.md` or a reference — read on demand |
| `resources/directory/read` | One directory level at a time (`skill://amira-mcp`, `skill://amira-mcp/references`) |

**Cost when unused: zero.** Skill text is never injected into the server `instructions` or into any
tool description, so the `tools/list` payload — the part re-sent every turn — is byte-identical
whether or not a host supports the extension. Disclosure timing stays a host decision; the four
reference files load only when something actually reads them.

Set `AMIRA_SKILLS=0` to drop the capability and the three methods entirely. The extension is a draft:
the wire contract may change before it is finalised.

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
npm run weigh         # token budget report (needs ./data — run fetch-data first)
```

### Token budgets

Context is the scarcest resource a client has, so both halves of what this server
spends are measured and gated (`scripts/weigh.mjs`, estimating tokens as
bytes/4 — comparable to itself, not to a billing statement):

| | what | budget | drift |
|---|---|---|---|
| **Surface** | the `tools/list` payload, re-sent every turn | 10,000 tok per transport | **fails** over 3 % |
| **Responses** | each tool called at its *maximum* limit | 20,000 tok per call | warns over 10 % |

No tool description is derived from the snapshot, so the surface is a pure
function of the code: `test/unit/budget.test.mjs` gates it offline against no
data at all, and asserts that the empty-store measurement still matches the
baseline recorded against the full snapshot. Response weight needs real data, so
`npm run weigh -- --check` runs in the smoke job instead. Drift there is only a
warning — a routine `npm run fetch-data` must not red the build — while the
absolute cap (Claude Code truncates tool results at 25,000 tokens) is fatal, as
is any probe whose call *failed*, since a structured refusal is ~60 tokens and
would otherwise sail under every ceiling.

Current: **7,667 tok** stdio / **8,881 tok** http surface; heaviest response is
`search_research_items` at `limit=100`, ~15,000 tok. Defaults are far cheaper —
a keyword search is ~165 tok.

When a change legitimately grows either number:

```bash
npm run weigh -- --update    # rewrites test/token-baseline.json
```

Commit the diff. That is the point of the file: the cost of a new tool or a
richer result summary lands in code review as a number instead of arriving
unnoticed.

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

Three GitHub Actions cover pull requests and distribution (the two distribution
workflows crawl the **public** API — no credentials):

- **CI** (`.github/workflows/ci.yml`) — on pull requests and pushes to `main`:
  type-checks and runs the offline unit suite (including the tool-surface token
  budget) on the oldest supported Node.js release and the current release, then
  exercises both MCP transports, weighs every tool's response at its maximum
  limit, and validates the MCPB manifest. The production audit gate fails on high
  or critical advisories.

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
| `AMIRA_SKILLS` | — | on | **Prototype**: serve the companion skill over the draft SEP-2640 extension. `0`/`false`/`off` withdraws the capability and the `skills/*` methods |
| `PORT` | — | `8787` | Port for the remote HTTP transport (`server/http.js`); ignored by the `.mcpb` |
| `HOST` | — | `0.0.0.0` | Bind address for the remote HTTP transport |
| `AMIRA_ALLOWED_ORIGINS` | — | `localhost, 127.0.0.1, [::1]` | Comma-separated browser Origin hostnames or URLs allowed to call the HTTP endpoint. Server-to-server clients, which omit `Origin`, are unaffected. Add trusted web-client origins explicitly; wildcards are rejected. |
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
- **Interactive results (MCP Apps).** Two tools carry `_meta.ui.resourceUri`
  pointing at a `text/html;profile=mcp-app` resource, so hosts implementing the
  [`io.modelcontextprotocol/ui`](https://modelcontextprotocol.io/docs/extensions/apps)
  extension (Claude, Claude Desktop) render the result inline. Every other
  client ignores the `_meta` and gets exactly the same JSON.

  | Tool | Resource | Renders |
  | --- | --- | --- |
  | `get_collection_overview` | `ui://amira/overview` | Stat tiles + ranked breakdowns by university, section, resource type and language |
  | `list_years` | `ui://amira/timeline` | Histogram of items per year or decade |
  | `list_research_sections` | `ui://amira/sections` | Gantt of the sections across the AM 1.0 / AM 2.0 funding phases, with a "now" marker |
  | `find_related` | `ui://amira/related` | Radial co-occurrence hub: the seed at the centre, one labelled sector per relation type |

  The modules live in `src/ui/`: `shell.ts` holds the design tokens, the host
  bridge and the shared bar-chart primitive; each app supplies only its own CSS
  and render function. The templates load **nothing** from the network — no
  scripts, styles, fonts or tiles — so they need no `_meta.ui.csp` grants and
  run in the strictest sandbox. They are also read-only: an app renders the tool
  result it is handed and never calls back into the server.

  Colours come from the [DREVisualizations](https://github.com/AM-Digital-Research-Environment)
  Omeka module's theme (`--primary` / the Africa Multiple brand palette), so a
  chart in the chat and the same chart on the AMIRA site read as one system, and
  were validated against those surfaces rather than eyeballed — light `#007a50`
  on `#fdfcfa`, dark `#35a87d` on `#1b211e` (the theme's own `#3fb488` sits just
  outside the dark lightness band, so the app steps one down). Every chart is
  single-series, with the category on the axis label, so one accent is correct
  and no legend is needed. The co-occurrence hub would nominally want six hues
  for its six relation types, but no six-hue set from the brand palette survives
  all-pairs CVD separation (the best candidates bottomed out at ΔE 2.4 under
  deutan), so identity there is carried **spatially** — one labelled sector per
  relation type — which also survives greyscale, print and forced-colors.

### Protocol posture

The server speaks MCP **2026-07-28** on both transports, and still answers
2025-era clients unchanged.

It runs on the v2 TypeScript SDK — the scoped packages
(`@modelcontextprotocol/server`, `/node`, `/client`), not the frozen
`@modelcontextprotocol/sdk` v1 monolith. Two things are worth knowing if you
work on the entry points:

- **The modern era is opt-in.** `SUPPORTED_PROTOCOL_VERSIONS` is the *legacy*
  `initialize` ladder and stops at 2025-11-25; the SDK keeps the 2026 string
  internal on purpose. `createAmiraServer` names the revision itself in
  `supportedProtocolVersions`, which is what registers `server/discover` —
  without it that method answers `-32601`.
- **The era is owned by the entry, not the transport.** `serveStdio(factory)`
  and `createMcpHandler(factory)` decide the era per connection/request and pin
  an instance from the factory. Connecting a bare `StdioServerTransport` or
  `NodeStreamableHTTPServerTransport` by hand serves the 2025 era only.

Concretely on the wire: `server/discover` advertises `["2026-07-28"]`, results
carry `resultType`, and the cacheable results carry real `ttlMs` / `cacheScope`
(1 h `public` on `tools/list`, `resources/list` and `server/discover`; 24 h on
`resources/read`, whose `ui://` app HTML is immutable per build) rather than the
SDK's conservative `{ ttlMs: 0, cacheScope: "private" }` default. Back-compat is
the handler's `legacy: 'stateless'` default, which answers 2025-era traffic with
a fresh instance per request — the same shape this server always had.

The deprecations of that revision cost nothing here: Roots, Sampling, Logging
and Elicitation are all unused, logging goes to stderr, and tool order is
deterministic (registration order). CORS accepts both generations of headers
(`Mcp-Session-Id`/`MCP-Protocol-Version` and `Mcp-Method`/`Mcp-Name`/`X-Mcp-Header`).

## Citing this software

If this server is part of how you found or analysed AMIRA material, please cite
it. The repository carries a [`CITATION.cff`](CITATION.cff), so GitHub's **Cite
this repository** button will render BibTeX and APA for you.

```bibtex
@software{madore_amira_mcp_server,
  author    = {Madore, Frédérick},
  title     = {{AMIRA MCP Server}},
  year      = {2026},
  publisher = {Africa Multiple Cluster of Excellence, University of Bayreuth},
  url       = {https://github.com/AM-Digital-Research-Environment/amira-mcp-server},
  version   = {1.12.0},
  license   = {MIT}
}
```

Cite the **data** separately from the software: individual records are citable
by their `amira_url` (`https://data.africamultiple.uni-bayreuth.de/s/amira/item/<id>`),
which is what every tool result returns for exactly this reason.

## Credits and funding

Built and maintained by the **Digital Research Environment (DRE)** of the
[Africa Multiple Cluster of Excellence](https://www.africamultiple.uni-bayreuth.de/),
University of Bayreuth — the Cluster's digital infrastructure unit, which
designs and runs the data systems behind AMIRA. Curation and description of the
underlying records are joint efforts with partners at the Africa Multiple
Research Centres (Université Joseph Ki-Zerbo, Rhodes University, University of
Lagos, Moi University) and Federal University of Bahia.

Funded by the Deutsche Forschungsgemeinschaft (DFG, German Research Foundation)
under Germany's Excellence Strategy — **EXC 2052/1 — 390713894**
([Africa Multiple: Reconfiguring African Studies](https://gepris.dfg.de/gepris/projekt/390713894?language=en)).

## License

MIT — see [LICENSE](LICENSE). See also [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).
