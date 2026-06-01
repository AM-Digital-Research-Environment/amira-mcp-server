# Africa Multiple MCP Server

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server for the
**Africa Multiple Cluster of Excellence** research data, as published by the
[amira dashboard](https://amira.africamultiple.uni-bayreuth.de).

It exposes the cluster's research **projects** (across the partner universities in
Bayreuth, Lagos, Joseph Ki-Zerbo/Ouagadougou and Bahia, plus external
collections), their thematic **research sections**, ~4,000 digitised **research
items**, **people**, **institutions**, **groups**, and the cluster
**bibliography** — as 18 well-described tools an LLM can query.

Every result carries a `dashboard_url` so findings can be **cited as links** back
to the exact page on the amira dashboard.

## How it gets its data — and why no database is needed

The server **never connects to MongoDB**. There are two separate data planes:

| Plane | Who | What |
| --- | --- | --- |
| **Upstream** (private) | the maintainer, on the university VPN | MongoDB → Python pipeline → static JSON → published to the public amira dashboard |
| **Downstream** (public) | everyone who installs this extension | reads the **bundled JSON snapshot** and, optionally, the **public dashboard JSON** over HTTPS |

So end users need **no database, no API key, and no VPN**:

1. A complete **~15 MB JSON snapshot is bundled inside the `.mcpb`**. The server
   is fully usable from this alone — **offline**.
2. When **live refresh** is on (default), a background task compares the bundled/
   cached snapshot's `generatedAt` against the public dashboard's
   `manifest.json` and, if newer, downloads it into a local cache and hot-swaps
   the in-memory data. If the site is unreachable, it silently keeps using the
   bundled snapshot.

When the maintainer regenerates the dashboard data from MongoDB, every installed
copy picks up the newer JSON on its next refresh. Turn live refresh off (in the
extension settings) to pin to the bundled snapshot and run fully offline.

## Tools

Call `get_collection_overview` first to scope the data, then drill in.

| Tool | Purpose |
| --- | --- |
| `get_collection_overview` | Counts and breakdowns across the whole collection + snapshot freshness |
| `search_research_items` | Find items by keyword, **subject**, **location**, contributor, project, section, university, resource type, genre, language, tag, year |
| `get_research_item` | Full metadata for one item (by `dre_id`) |
| `search_projects` | Find projects by keyword, university, section, PI, member, institution |
| `get_project` | Full project detail + item breakdown + top subjects |
| `list_research_sections` | The cluster's thematic sections with PIs and counts |
| `get_research_section` | One section's description, objectives, and projects |
| `search_persons` | Search the people authority list |
| `get_person` | A person's projects led/joined, items contributed, publications |
| `list_institutions` / `get_institution` | Institutions and their affiliated projects/items |
| `list_groups` | Research groups |
| `list_subjects` | LCSH subjects ranked by item frequency |
| `list_locations` | Origin places (country/region/city) ranked, with coordinates |
| `list_categories` | Facet values: tags, genres, languages, resource types |
| `search_publications` / `get_publication` | The cluster bibliography (incl. BibTeX) |
| `find_related` | Cross-entity discovery: pivot from a subject/place/person/project/tag to co-occurring entities |

### Example questions it can answer

| You ask… | The model uses… |
| --- | --- |
| "What does the collection hold on Islam?" | `list_subjects keyword=Islam` → `search_research_items subject=Islam` |
| "Show me all the **French**-language items" | `search_research_items language=French` (matches both `fre` and `fra`) |
| "What has Ulli Beier contributed?" | `get_person name="Beier, Ulli"` (items + projects + publications) |
| "Which items come from **Nigeria**?" | `search_research_items country=Nigeria` (or `location=Lagos`) |
| "What audio recordings are in the ILAM collection?" | `search_research_items project_id=Ext_ILAM resource_type=Audio` |
| "What themes travel with **Architecture** across projects?" | `find_related entity_type=subject value=Architecture` |
| "List the Arts & Aesthetics projects" | `search_projects research_section="Arts & Aesthetics"` |
| "Which places have the most items, with coordinates?" | `list_locations level=country` |

Every answer comes back with `dashboard_url`s so the model can cite each result as a link.

## Companion skill

A research-workflow skill ships in [`.claude/skills/africa-multiple/`](.claude/skills/africa-multiple/):
it gives the model cluster context, a query workflow, a tool-by-task map, the citation discipline, and
the collection's coverage caveats. Install it by copying that folder into your Claude skills directory
(e.g. `~/.claude/skills/`) or your project's `.claude/skills/`. It is also packed inside the `.mcpb` for
reference. For the upstream data architecture, see the separate `wisski-mongodb` skill.

## Install (end users)

Download `africa-multiple-mcp-server.mcpb` from the
[releases page](https://github.com/AM-Digital-Research-Environment/africa-multiple-mcp-server/releases)
and double-click it. Claude Desktop shows an install dialog; click **Install**.
No further configuration is required.

## Develop / rebuild

```bash
npm install
npm run fetch-data    # build the ./data snapshot (from ../WissKI-dashboard or the live site)
npm run typecheck     # tsc --noEmit
npm run build         # esbuild -> server/index.js (single self-contained file)
npm run smoke         # spawn the server and exercise every tool family
```

`fetch-data` prefers a local dashboard checkout at `../WissKI-dashboard/static/data`;
pass `--from <dir>` or set `AMIRA_DASHBOARD_DATA_DIR` to point elsewhere, or omit
it entirely to download from the live public dashboard.

Pack the extension:

```bash
npm run prepack-mcpb                       # clean + typecheck + build
npx @anthropic-ai/mcpb validate manifest.json
npm run pack-mcpb                          # -> africa-multiple-mcp-server.mcpb
```

## Configuration (environment / extension settings)

| Env var | Extension setting | Default | Meaning |
| --- | --- | --- | --- |
| `AMIRA_LIVE_REFRESH` | Refresh data from the live dashboard | `true` | Refresh the snapshot from public JSON at startup |
| `AMIRA_CACHE_DIR` | Refreshed-data cache directory | `~/.africa-multiple-mcp/cache` | Where refreshed data is stored |
| `AMIRA_DASHBOARD_BASE` | Dashboard base URL (advanced) | `https://amira.africamultiple.uni-bayreuth.de` | Base for citations + refresh |
| `AMIRA_DATA_DIR` | — | bundled `data/` | Override the bundled snapshot path (dev) |

## Architecture

- **Pure in-memory JSON.** The queryable core is ~15 MB, so — unlike the
  DuckDB/parquet approach of the sibling
  [IWAC MCP server](https://github.com/fmadore/iwac-mcp-server) — the snapshot is
  loaded into memory and indexed at startup. No native bindings; the esbuild
  bundle is a single self-contained `server/index.js`.
- **MongoDB Extended JSON** (`{$oid}`, `{$date}`, `{$numberDouble:"NaN"}`) and the
  `location.l1/l2/l3` array quirk are normalised exactly as the dashboard does.
- **Citations** mirror the dashboard's own URL scheme
  (`/people?name=…`, `/projects?id=…`, `/research-items?id=…`, …).

## License

MIT
