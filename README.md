# AMIRA MCP Server

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the
**Africa Multiple Cluster of Excellence** research data (the AMIRA collection), as
published on the cluster's public **Omeka S** site at
[data.africamultiple.uni-bayreuth.de](https://data.africamultiple.uni-bayreuth.de).

It exposes the cluster's research **projects** (across the partner universities in
Bayreuth, Lagos, Joseph Ki-Zerbo/Ouagadougou and Bahia, plus external collections
such as the International Library of African Music), their thematic **research
sections**, ~4,000 digitised **research items**, **people**, **institutions**,
**groups**, **collections**, the cluster **bibliography**, **podcast episodes**, and
the cluster's **YouTube videos with searchable transcripts** — as 24 well-described
tools an LLM can query.

Every record carries an **`amira_url`** — its public page on the Omeka S site
(`…/s/amira/item/<id>`) — so findings can be **cited as links** back to the source.

## How it gets its data — and why nothing else is needed

The server is **self-contained and offline-first**. It reads from two sources:

1. A complete **data snapshot bundled inside the `.mcpb`** — crawled from the
   public Omeka S REST API at build time and transformed into compact typed
   records, so the server works fully offline with zero setup.
2. *(optional, on by default)* the **Omeka S API** over HTTPS. At startup a
   one-request probe compares the snapshot's freshness signature (max
   `o:modified` + item totals) against the live API; only when stale does a full
   re-crawl run — staged on disk and **atomically promoted**, so a failed or
   interrupted refresh can never corrupt the cache. If the site is unreachable,
   the bundled snapshot keeps serving.

End users need **no API key, no credentials, and no VPN** — it's the same openly
published data that powers the public site.

## Tools

Call `get_collection_overview` first to scope the data, then drill in.

| Tool | Purpose |
| --- | --- |
| `get_collection_overview` | Counts and breakdowns across the whole collection + snapshot freshness |
| `search_research_items` | Find items by keyword, **subject**, **location** (hierarchy-aware), contributor, project, section, university, resource type, format/genre, language, year |
| `get_research_item` | Full metadata for one item (by `dre_id`): typed dates, roles, places with their region/country chain, sponsors, collections, related items, media thumbnail |
| `search_projects` / `get_project` | Projects by keyword, university, section, PI, member, funder — detail with item breakdown + top subjects |
| `list_research_sections` / `get_research_section` | Thematic sections with funding phases (AM 1.0 / AM 2.0), PIs, counts, projects |
| `search_persons` / `get_person` | People (either name order works) — profile across projects, items, publications |
| `list_institutions` / `get_institution` / `list_groups` | Organisations (institutions and research groups), their projects, people and items |
| `list_subjects` | Subject headings (former tags merged in) ranked by item frequency |
| `list_locations` | Places at country/region/city level via the place hierarchy, with coordinates |
| `list_collections` | Collections (item sets) ranked by research-item count — pair with the `collection` filter |
| `list_categories` | Facet values: formats/genres, languages, resource types |
| `list_years` | Date histogram of research items by year or decade — coverage over time, most-covered year/decade |
| `search_publications` / `get_publication` | The cluster bibliography (incl. generated BibTeX) |
| `find_related` | Cross-entity discovery: pivot from a subject/place/person/project to co-occurring entities |
| `search_podcasts` / `get_podcast` | Cluster podcast episodes (transcript-ready) |
| `search_videos` / `get_video` | The cluster's YouTube videos — **full-text search over transcripts** |

### Example questions it can answer

| You ask… | The model uses… |
| --- | --- |
| "What does the collection hold on Islam?" | `list_subjects keyword=Islam` → `search_research_items subject=Islam` |
| "Show me all the **French**-language items" | `search_research_items language=French` (codes `fr`/`fra`/legacy `fre` work too) |
| "What has Ulli Beier contributed?" | `get_person name="Ulli Beier"` (resolves to 'Beier, Ulli') |
| "Which items come from **Nigeria**?" | `search_research_items country=Nigeria` (Lagos items count — the place hierarchy is walked) |
| "What audio recordings are in the ILAM collection?" | `search_research_items project_id=Ext_ILAM resource_type=Audio` |
| "In which talks does anyone discuss **decoloniality**?" | `search_videos keyword=decolonial` (matches inside transcripts, flagged `matched_in`) |
| "What themes travel with **Architecture** across projects?" | `find_related entity_type=subject value=Architecture` |
| "When was this photograph taken?" | `get_research_item` → typed `dates` (created/collected/issued/…) |
| "Which **decade** does the collection cover most?" | `list_years bucket=decade sort=count` |

## Companion skill

A research-workflow skill ships in [`.claude/skills/amira-mcp/`](.claude/skills/amira-mcp/):
cluster context, a query workflow, a tool-by-task map, the citation discipline, and coverage caveats.
Install it by copying that folder into your Claude skills directory (e.g. `~/.claude/skills/`).

## Install (end users)

Download `amira-mcp-server.mcpb` from the
[releases page](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/releases)
and double-click it. Claude Desktop shows an install dialog; click **Install**.
No further configuration is required. The latest tagged release carries the
current data; the rolling `data-latest` pre-release always tracks the freshest
site snapshot.

## Develop / rebuild

```bash
npm install
npm run fetch-data    # crawl the public Omeka API -> ./data snapshot (~1 min)
npm run typecheck     # tsc --noEmit
npm run build         # esbuild -> server/{index,fetchCli,lib}.js
npm test              # unit tests (transform fixtures — offline)
npm run test:live     # integration tests against the live API (network)
npm run smoke         # spawn the bundled server, exercise all 24 tools offline
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
  snapshot, unit + live tests, smoke, pack, attach to the GitHub Release.
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
| `AMIRA_LIVE_REFRESH` | Refresh data from the live site | `true` | Probe + refresh the snapshot from the public API at startup |
| `AMIRA_CACHE_DIR` | Refreshed-data cache directory | `~/.amira-mcp/cache` | Where refreshed snapshots are stored |
| `AMIRA_SITE_BASE` | Site base URL (advanced) | `https://data.africamultiple.uni-bayreuth.de` | Base for citations + refresh (`AMIRA_DASHBOARD_BASE` is honoured with a deprecation warning) |
| `AMIRA_SITE_SLUG` | — | `amira` | Omeka site slug used in `amira_url` |
| `AMIRA_DATA_DIR` | — | bundled `data/` | Override the bundled snapshot path (dev) |

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

## License

MIT
