# MCP Apps development and source data

Version 1.18.0 serves seven self-contained `text/html;profile=mcp-app` resources.
The official `@modelcontextprotocol/ext-apps` 2.0.3 SDK is bundled into each page;
there are no external scripts, styles, fonts, tiles or network data dependencies.
The SDK uses the published 2026-01-26 Apps wire protocol. Server transport protocol
versions are negotiated separately.

| Resource | Tool | Interaction |
| --- | --- | --- |
| `ui://amira/overview` | `get_collection_overview` | Counts, ranked bars and table alternative |
| `ui://amira/sections` | `list_research_sections` | Funding-phase timeline and table alternative |
| `ui://amira/related` | `find_related` | Co-occurrence diagram with distinct corpus counts and publication-only results |
| `ui://amira/graph` | `get_entity_graph` | Resolve a seed, follow typed nodes, page cited edge evidence |
| `ui://amira/map` | `list_locations` | Country dropdown, place table, keyboard markers, exact-ID item evidence |
| `ui://amira/timeline` | `list_years` | Year-range controls, project dropdown, subject suggestions, shared filters, bucket evidence and paging |
| `ui://amira/bibliography` | `search_publications` | Search with a language dropdown and author suggestions, persistent selections across pages, export up to 25 records |

The bridge in `src/ui/bridge.ts` uses the official handshake, initializes within
10 seconds, times out tool calls after 15 seconds, handles partial host context
updates, resizes to the host, and cancels pending work on teardown. Only explicitly
allowlisted read-only server tools can be invoked. Tool errors use an `aria-live`
status region. Links use `openLink`; citation files use `downloadFile` when the host
advertises that capability (it is still a draft in the Apps specification), and are
otherwise shown in a text box to copy. A host may decline either action. All evidence required for research remains in ordinary
model-visible JSON; clients without Apps support retain the tools and citations.

Filter dropdowns and suggestion lists come from the same allowlisted tools, called
by the app itself: bibliography languages and authors from `list_publication_facets`,
timeline projects from `search_projects` and subjects from `list_subjects`, map
countries from `list_locations`. Their results go to the page, not the model, so
they add no model tokens. These background calls leave the status line alone.
Each list loads once per widget. The exception is the language list, which is
recounted for the current search without its own filter, so the other languages
stay selectable. Map countries follow the map's research filters. Until a list
arrives, or if the host refuses the call, the field stays a text input. Countries
are the place hierarchy's roots, the same ones the filter matches. A place catalogued
without a parent therefore appears as its own country.

Graph lines distinguish explicit catalogue relationships from co-occurrence;
corpora and distinct record counts remain visible in the table. The diagram draws
up to 12 neighbours; the table includes all returned edges. It does not infer
collaboration, causation or social ties. Map marker positions are source coordinates;
hollow roots may denote entire countries. Missing coordinates remain in the table.
Timeline ranges overlap, and a capped page is not the complete histogram.

## Preview and validation

```bash
npm run preview:apps
# Open http://127.0.0.1:8790
```

The development host uses real in-memory MCP calls against the available local
snapshot. Use its app, 375 px/desktop width and light/dark controls for visual and
keyboard checks. It simulates link/download success and shows the requested action;
it does not save files or certify every production host. `AMIRA_PREVIEW_PORT` selects
a different loopback port. It disables live refresh and uses the full tool profile.
Do not deploy the preview host.

Automated checks cover initialization source validation, rejected handshakes,
partial themes, error status, resource metadata and no external asset loads.
Browser checks cover graph evidence, map filters, timeline evidence, bibliography
selection/export requests, filter pickers and their text-field fallback, and readable
light/dark/mobile layouts. Production-host
compatibility still depends on the host's supported Apps capabilities.

## Offline map provenance

`src/ui/land.json` is the Natural Earth 1:110m land GeoJSON, retrieved on
5 October 2026 from the [official Natural Earth repository](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson).
Its SHA-256 is `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`.
Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).
The build converts outlines to an inline SVG path; no basemap service receives
research queries. Country boundaries are not used to infer missing record locations.

Upstream references: [Apps overview](https://modelcontextprotocol.io/docs/extensions/apps),
[Apps SDK](https://github.com/modelcontextprotocol/ext-apps), and
[client support matrix](https://modelcontextprotocol.io/extensions/client-matrix).
