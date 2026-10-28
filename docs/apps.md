# MCP Apps development and source data

One self-contained `text/html;profile=mcp-app` resource, `ui://amira/app.html`,
renders the views of seven tools. The official `@modelcontextprotocol/ext-apps` 2.0.3
SDK is bundled into it once; there are no external scripts, styles, fonts, tiles or
network data dependencies. The SDK uses the published 2026-01-26 Apps wire protocol.
Server transport protocol versions are negotiated separately.

| View | Tool | Interaction |
| --- | --- | --- |
| `overview` | `get_collection_overview` | Counts, ranked bars and table alternative |
| `sections` | `list_research_sections` | Funding-phase timeline and table alternative |
| `related` | `find_related` | Co-occurrence diagram with distinct corpus counts and publication-only results |
| `graph` | `get_entity_graph` | Resolve a seed, filter neighbours by type, select a spoke to read its cited evidence, re-centre; shares its selection |
| `map` | `list_locations` | Country dropdown, place table, keyboard markers, exact-ID item evidence; shares its selection |
| `timeline` | `list_years` | Year-range controls, project dropdown, subject suggestions, shared filters, bucket evidence and paging |
| `bibliography` | `search_publications` | Search with a language dropdown and author suggestions, persistent selections across pages, export up to 25 records; shares its selection |

## One page, seven views

Until 1.30 each view was its own resource, and each embedded its own copy of the
SDK and zod: 660–722 KB a page, 4.7 MB in all, for renderers of 3–20 KB. A
`ui://` resource shares nothing with its siblings, but tools may all point at the
same one, so every app-rendering tool now carries the same
`_meta.ui.resourceUri`. The page picks the view from the host's
`hostContext.toolInfo`, which names the tool that opened it; a host that sends no
`toolInfo` is answered from the result's shape, which differs across the seven
tools. A view's own follow-up calls (filters, paging, re-centring) re-render that
view directly. Each view's CSS is scoped to `[data-view="<name>"]` on `#root`, so
one view's table widths cannot reach another's. The resource is registered when at
least one of the seven tools survives `AMIRA_TOOL_PROFILE`; with `AMIRA_GUIDANCE=off`
it has no title or description.

`npm run build` assembles the page (`src/ui/page.ts`, run by `scripts/build.mjs`):

- zod's 50 non-English error catalogues are stubbed out of the bridge bundle,
  258 KB of strings that can never fire (the technique comes from the IWAC server);
- the views script is minified (whitespace and syntax only; identifiers stay);
- the map outline is written as integer relative SVG moves, a third of its
  previous size, at about one unit per pixel;
- the decoded script (bridge, then views and router) is gzip-compressed into an
  inert `<script type="application/gzip">` element. A 1 KB bootstrap expands it
  with the browser's own `DecompressionStream` into an ordinary inline script. No
  network, `eval`, blob URL or CSP grant is involved, and base64 cannot contain a
  closing script tag. A host without `DecompressionStream` shows a one-line notice;
  the tool result in the conversation is unaffected.

The result is 181 KB on the wire, 471 KB decoded. `test/unit/apps.test.mjs`
fails the build above 300 KB for the resource or 500 KB for the decoded script:
tripwires for a second SDK copy (about 400 KB) or a regressed locale stub, not
for an ordinary new view. The build prints both sizes.

## The selection, shared with the model

The bibliography, map and graph report what the reader is working with: the
bibliography its filters and the selected publications (or, with none selected,
the page in view); the map its filters and the opened place with the page of its
research items; the graph its centre, type chips, selected neighbour and the link
whose records are listed. Every record keeps its `amira_url`, so the model can
cite what the reader picked.

- **Automatic context.** On hosts that advertise `ui/update-model-context`, the
  bridge sends the selection after each change. Updates go one at a time and the
  newest wins (`src/ui/contextSync.ts`): a burst of clicks ends on what the page
  shows, never on a stale intermediate state. An update never starts a turn; the
  host attaches it to the next message. A status line under the controls says
  whether it was shared. Only the negotiated modalities are sent: a text-only
  host gets the data as JSON inside the text block.
- **"Ask about this selection".** On hosts that accept `ui/message`, a button
  sends a question that carries its own snapshot of the selection, so the answer
  does not depend on whether, or when, the automatic update arrived.
- **Bounds and trust.** `src/ui/selectionContext.ts` keeps whitelisted primitive
  fields only (no abstracts, full text or export files), clips each string,
  keeps at most 25 records and only http(s) links, and caps the update at
  10,000 bytes in either form. Anything cut is named in `truncated_fields`, so a
  shortened list is not mistaken for the whole selection. Titles, names and
  filter values sit in JSON, never in the prose, and both channels say they are
  research data, not instructions.

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

The graph uses the co-occurrence hub's encoding: each entity type owns a labelled
sector, spoke length grows with the records behind a neighbour's strongest link
(square-root scale, with the count printed), and labels share one ring, rotated
along their spoke. Solid spokes include a catalogue link; dashed spokes are
co-occurrence only. The diagram draws up to 16 neighbours, sharing the ring across
types; the table includes all returned edges with their corpora and counts. Type
chips call the tool again with `types`, which the server applies before its bounds.
Selecting a spoke lists that neighbour's links and opens the records behind the
strongest one under the diagram; re-centring is a separate button. It does not infer
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
keyboard checks. Like Claude, it names the calling tool in `hostContext.toolInfo`,
and it accepts context updates and app messages, printing the latest of each under
the frame, so the selection controls can be checked. It simulates link/download
success and shows the requested action; it does not save files or certify every
production host. `AMIRA_PREVIEW_PORT` selects
a different loopback port. It disables live refresh and uses the full tool profile.

For figures, `?app=graph&seed=<typed id or name>&types=person` opens the graph on a
chosen seed and filter (a name resolves to a person first). `&pseudonymise`
replaces every person's name with R1, R2, … in order of first appearance, in
labels and record titles. It changes the display only: `amira_url` links still
identify the records.
Do not deploy the preview host.

Automated checks cover initialization source validation, rejected handshakes,
partial themes, error status, resource metadata, no external asset loads, the two
size budgets, the gzip bootstrap and its fallback, routing by `toolInfo` and by
shape, scoped view CSS, and the selection updates (capability gating,
serialisation, bounds, the Ask message). Browser checks cover graph evidence, map
filters, timeline evidence, bibliography selection/export requests, filter pickers
and their text-field fallback, and readable light/dark/mobile layouts. Production-host
compatibility still depends on the host's supported Apps capabilities.

## Offline map provenance

`src/ui/land.json` is the Natural Earth 1:110m land GeoJSON, retrieved on
5 October 2026 from the [official Natural Earth repository](https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson).
Its SHA-256 is `9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`.
Natural Earth data is [public domain](https://www.naturalearthdata.com/about/terms-of-use/).
The build converts outlines to an inline SVG path of integer relative moves on the
720×360 viewBox (rings that round to fewer than three points are dropped); no
basemap service receives research queries. Country boundaries are not used to infer missing record locations.

Upstream references: [Apps overview](https://modelcontextprotocol.io/docs/extensions/apps),
[Apps SDK](https://github.com/modelcontextprotocol/ext-apps), and
[client support matrix](https://modelcontextprotocol.io/extensions/client-matrix).
