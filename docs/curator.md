# Curator mode

Curator mode is an internal, read-only variant of the server for AMIRA's
developers and data curators ([#26](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/issues/26)).
It reads the Omeka S API with a service key, so it also sees **private records
and private values**, and it serves them only to people holding a personal
token. It is the same code and the same image as the public server, started with
`AMIRA_ACCESS=curator`; nothing changes for the public server, and the `.mcpb`
only gains an optional relay to it.

This first step uses personal bearer tokens, which command-line clients (Claude
Code, Gemini CLI, Codex) send as a header, and which the `.mcpb` relays for
Claude Desktop. OAuth sign-in for the chat applications (claude.ai, ChatGPT) is
the next step and is not built yet. See [Client setup](#client-setup).

## What "private" covers

Only what Omeka holds. The curator server sees what the service account can see
through the Omeka API; MongoDB, the source archive behind the VPN, stays out of
it.

- **Private resources** (`o:is_public: false`): items in any crawled corpus
  (research items, people, organisations, places, projects, sections,
  publications, journals, podcasts, videos, playlists, languages, subjects,
  Cluster Chronicles works),
  item sets and media. Examples: the research items of the item set *Of Art
  Worlds*, and authority duplicates made private when they were merged.
- **Private values on public resources** (`is_public: false`): `dre:mongoId`,
  `dre:security` (DSL1–DSL5), `dre:bitstream`, a private description, and the
  private `bibo:content` that holds the ILAM OCR full text (with its private
  `dre:generatedBy` annotation). Private annotation values on a public value
  count too.

Fields the transformation never reads are not exposed by authentication alone.
Media are listed (each row with `visibility`), never downloaded or served: Omeka
serves `/files/…` statically, so a private media row has no file `url`, only
its `admin_url` (the Omeka admin page of the media), and an item `thumbnail`
drawn from a private media is null. A media of a private record counts as
private whatever its own flag, and a private record's `thumbnail` (a video's
included) is null.

Besides the crawled corpora, the curator crawl lists the id of every private
item on the instance (`items?is_public=0`, kept in the snapshot manifest and
never served), so records that are only link targets (format and genre
authorities, AI-model items, podcast series, venues outside the journals) are
classified too.

## How private data is shown

Every result passes through one decoration step (`src/tools/curator.ts`),
applied to every tool and resource, so no tool can forget it:

- **`visibility`**: every object that cites a record carries
  `visibility: "public"` or `"private"`: by its `amira_url`, or by a `url` that
  is exactly a record page (`search` rows, `fetch` documents). An object that
  cites another record's page (a collection cites its project) takes the most
  restrictive of the two, and gets the `admin_url` of the private one. (The
  public server omits the field: everything it serves is public.) A snapshot
  written before the private-item list existed cannot classify ids outside the
  crawled corpora: they carry no `visibility` and are not rewritten, until the
  next crawl.
- **Private records** lose `amira_url`, since anonymous visitors cannot open
  that page, and get `admin_url` (the Omeka admin page) and a `citation_note`
  saying that readers without curator access cannot open them, so they are
  named as private rather than linked as if public. Any other URL of a private record inside a
  string (a generated citation, a `fetch` document, an export), whether its
  public page (`https://` or `http://`), its API URL (`/api/items/<id>`) or its
  IIIF manifest or collection (any IIIF path under its id, such as a canvas),
  is rewritten to its admin URL, and a private media file's URL to the media's
  admin page (a private record's thumbnail file without a listed media: the
  record's admin page). Punctuation right after a URL (`.`, `,`, `;`, `)`) is
  kept after the rewritten URL. Percent-encoded URLs are not
  recognised. The `iiif_manifest` / `iiif_collection` field of a private record
  is null: Omeka answers an anonymous request for it with 404.
- **`restricted`**: a detail result (`get_research_item`, `get_publication`,
  `get_person`, …, and `amira://record/…`) carries the record's private values,
  grouped: `mongo_id`, `security_level`, `bitstream`, `values` (every other
  private value, by property term) and the private full text. Private values
  never appear in the public fields: a private description stays out of
  `description`, a private `bibo:content` out of `fulltext` and `transcript`.
  A private value longer than 25,000 characters is cut there and ends with
  `[…truncated: N characters in all]`.
- **Private full text** (the ILAM OCR text, later private publication texts):
  `search_research_items` and `search_publications` match the keyword against it
  (rows matched only there say `matched_in: "restricted_fulltext"` with a
  snippet, and the result carries `restricted_match_note`: the snippet is
  private, not on the public site), and `get_research_item` / `get_publication` return it with
  `include_fulltext`, `fulltext_offset` and `fulltext_max_chars`, paged like
  every other long text. `get_research_item` gains those three parameters in
  curator mode only. Asked for with `include_fulltext` on a record that has
  none, `restricted` says `has_fulltext: false`. On a record with both texts
  the public and the private text are one stream on `fulltext_offset`: the
  private text starts once the public one is exhausted, at
  `restricted.fulltext_starts_at` (the public text's length), and the two
  windows share one 25,000-character page. `restricted.fulltext_offset` and
  `restricted.fulltext_next_offset` are stream offsets; while the public text
  still has pages, `restricted` names where the private text starts instead of
  returning a sliver of it. A record with private text only pages it from 0,
  as before. The restricted `values` and `bitstream` come with the first page
  (`fulltext_offset` 0) only.
  A Cluster Chronicles work's private text follows the same rules under its own
  field name: `search_chronicles` marks rows matched only there with
  `matched_in: "restricted_text"` (a private `text_snippet`, the same note) and
  `has_restricted_text`, and `get_chronicle` pages it under `restricted` with
  `include_text`, `text_offset` and `text_max_chars` (`restricted.text`,
  `has_text`, `text_length`, …).
- **Passages of private text**: `get_text_passages` accepts `research_item:ID`
  (and `item:ID`) in curator mode only, and searches the private full text of
  research items and publications and the private text of Cluster Chronicles
  works, with the same literal, accent-insensitive phrase matching, `radius`,
  `limit`, `offset` / `next_offset` and match cap as for public texts. A
  passage drawn from a private text carries the search tools' marker
  (`matched_in: "restricted_fulltext"`, or `"restricted_text"` for a
  chronicle), so the result gets `restricted_match_note`: the passage `text` is
  private and not on the public site, even when the record itself is public (its row then
  says `visibility: "public"` and keeps its `amira_url`; a private record's
  row has `admin_url` instead). Its offsets are UTF-16 offsets into that
  private text: on a record without public text they are the
  `get_research_item` / `get_publication` `fulltext_offset` (`get_chronicle`
  `text_offset`) to page from, and on one with both texts add
  `restricted.fulltext_starts_at`, so a curator can read around a passage
  without paging the whole text. A publication with both texts
  gives its public passages first, then its private ones. A research item with
  no private full text is listed in `unavailable` as `no_fulltext`. In public
  mode the tool, its schema and its description are unchanged, and a research
  item id is still refused as `unsupported_kind`.
- **Keyword filters over research items match private full text everywhere**
  they apply, since every tool shares one selection: `list_years`,
  `list_locations` and `compare_collections` (their `filters.keyword`) and
  research-item exports count items matched only in a private full text, with
  no row marker. The three tools add a result-level `curator_note` saying so;
  an export cannot carry one. The publication paths whose rows carry no
  `matched_in` (`list_publication_facets`, and `search_publications` with
  `citation_format` or `export`) add one too when the keyword can match a
  publication's private full text. Below `AMIRA_EXPOSURE=full` no private text
  is searched and no note is added.
- **Pages keep their budget after decoration**: a private row grows by
  `visibility`, `citation_note` and `admin_url`, so a page is re-sized after
  decoration; the rows that no longer fit move to `next_offset`, with
  `response_limited: true`.
- **Citations and exports mark private records** rather than refusing them: the
  generated citation, BibTeX, RIS and CSL-JSON of a private record carry the
  private-record note and no AMIRA URL (a DOI or repository link, which is the
  publication's own public page, is kept). CSV and JSONL exports carry
  `visibility`, and `admin_url` for private rows; an export gets no
  `restricted` block, whatever its row count.
- **Counts**: `get_collection_overview` adds `visibility`, with public and
  private counts per corpus (languages included) and how many records carry
  private values or a private full text; `amira://dataset` carries the same
  split. Facet counts (subjects, places, years, …) include private records.
- **Semantic neighbours**: the corpus vectors are built from the public API, so
  a private record has none, and the semantic tools say so;
  `get_data_quality` counts private records apart (`private_not_embedded`).
- **Instructions and prompts** put the private-record rules first, cite
  public records by `amira_url`, and name private ones as private with their
  `admin_url`.
- **The server informs, it does not forbid.** Every note on private material
  states facts: what is private, that a private record has no public page,
  that a private text or value is not on the public site. Curators hold the
  data already, so the notes put no limit on reading, quoting or using private
  text: whether a passage leaves their hands is the curator's decision.
- **App views** (map, graph, bibliography, …) show a private record's title
  as plain text marked "(private)", never as a link.

## Configuration

Curator mode fails closed: the server refuses to start unless everything below
is in place, and prints every reason (never a secret).

| Env var | Required | Meaning |
| --- | --- | --- |
| `AMIRA_ACCESS` | yes | `curator` (default `public`). Any other value refuses to start |
| `AMIRA_OMEKA_KEY_FILE` | yes | File with the Omeka service key: `key_identity=…` and `key_credential=…` lines (`#` comment lines, and a `# comment` after a value), or a JSON object with those two keys. Re-read at most once a minute, so a rotated key is picked up without a restart; see [The Omeka service key](#the-omeka-service-key) for a file that goes missing |
| `AMIRA_MCP_TOKENS_FILE` | yes | Personal tokens, one `name sha256hex` line per curator (`#` comments allowed). Re-read every 2 s at most |
| `AMIRA_CACHE_DIR` | yes | The curator cache, set explicitly. Put it on **tmpfs**: it holds private data. See below for the Docker image |
| `AMIRA_SITE_BASE` | no | The **public** site (default `https://data.africamultiple.uni-bayreuth.de`). Every returned link is built from it: `amira_url`, `admin_url`, citations, media and thumbnail URLs |
| `AMIRA_API_BASE` | in the AMIRA stack | Where the crawl and refresh **fetch** the API: the full API URL including `/api`, e.g. `http://web/api`, so keyed requests stay on the Docker network and never pass the host's nginx, which logs query strings. Default: `AMIRA_SITE_BASE/api`. Must be an absolute http(s) URL, or the server refuses to start (in either mode) |
| `AMIRA_CURATOR_MAX_STALE_HOURS` | no | Default `24`. Data not confirmed by Omeka for longer than this is refused |
| `AMIRA_REFRESH_INTERVAL_HOURS` | no | Default `1` in curator mode (`24` in public mode). Must be greater than 0 and less than the staleness limit |
| `AMIRA_CURATOR_RETRY_SECONDS` | no | Default `60`. First retry after a transient failure leaves no data; it doubles up to five minutes |
| `AMIRA_CURATOR_AUTH_PROBE` | no | Default `items?is_public=0&per_page=1`. The keyed list request (relative to the API base, no resource id such as `items/123`) that must return a non-empty array before any crawl or refresh; see below |

**The cache directory and the Docker image.** The image caches the public
snapshot under `/tmp/amira-cache` through `AMIRA_DEFAULT_CACHE_DIR`, which is a
default, not an explicit `AMIRA_CACHE_DIR`: a curator container started without
one refuses to start. On Linux, `/tmp/amira-cache` (the image's path) is
accepted only when the mount table shows it is really tmpfs, so a forgotten
`--tmpfs` refuses to start rather than writing the private snapshot to the
container's disk layer. Run the image with:

```bash
docker run --tmpfs /tmp/amira-cache -e AMIRA_CACHE_DIR=/tmp/amira-cache -e AMIRA_ACCESS=curator …
```

(Compose: `tmpfs: [/tmp/amira-cache]`.) Any other directory that is not on
tmpfs is accepted on Linux with a startup warning; on other systems only the
explicit setting is checked. Likewise, on Linux the server warns (and still
starts) when the key file or the tokens file is readable by its group or by
others.

Curator mode also refuses:

- the stdio server and the `.mcpb` (`server/index.js`): curator mode is HTTP
  only. A local bundle would cache the private snapshot on laptops, and each
  install would need a key that travels in query strings. The `.mcpb` relays
  to a curator server instead (`AMIRA_CURATOR_TOKEN`, see
  [Client setup](#client-setup)), which holds neither data nor key locally;
- `npm run fetch-data`: the bundled snapshot is public by definition;
- `AMIRA_MCP_BEARER_TOKEN` / `AMIRA_MCP_TOKEN_FILE`: one shared token would
  defeat per-person revocation and the audit log.

Public mode, in turn, refuses `AMIRA_OMEKA_KEY_FILE` and
`AMIRA_MCP_TOKENS_FILE`, so a public server can never hold a key.

### The Omeka service key

Create a dedicated Omeka user and an API key for it. **The user needs
`view-all` on resources**, or Omeka hides private records and private values
from it: for now that means a `reviewer` account, the lowest role with
`view-all` (it can also edit; only this server's code keeps it read-only). A
read-only role is a follow-up.

**Omeka does not reject a bad key.** An unknown, revoked or mistyped key is
answered with the anonymous public data (HTTP 200), exactly like no key at all;
`/api/users` answers 403 either way. A crawl alone would therefore build a
public-only snapshot and label it curator. So before every crawl and every
refresh (and after each crawl, in case the key was revoked during it), and
before trusting a cached snapshot older than the refresh interval, the server
sends one keyed **authentication probe**, `AMIRA_CURATOR_AUTH_PROBE` (default
`items?is_public=0&per_page=1`). It must return a non-empty array with no
public record in it, which only a key with `view-all` gets as long as private
items exist (the *Of Art Worlds* items, the retired authority duplicates).
Anything else fails closed, exactly like a 401/403: see "Key not accepted"
below. A deployment without private items yet can point the probe at another
keyed request that returns a non-empty array only when authenticated.

Omeka reads keys from the query string only, so the server adds `key_identity`
and `key_credential` to a request at the last moment, inside the fetch, and only
for requests under the fetch base (`AMIRA_API_BASE`, else `AMIRA_SITE_BASE/api`):
with an internal fetch base the key is never sent to the public URL. The fetch
base is normalised once at startup (lower-case host, no default port, no
trailing slash), so `http://WEB:80/api/` and `http://web/api` behave the same.
The key is never stored in the API base, the snapshot manifest, an error, a log
line, `/healthz` or a returned URL; any URL or message that could carry it is
redacted. Keyed requests never follow redirects.

**A key file that cannot be read.** A missing, unreadable or malformed key file
at a refresh is first treated as transient (an atomic rotation, which renames a
new file over the old one, can leave a reader a moment without one): the refresh
is skipped and retried within about a minute. If the file is still unreadable
after more than one re-read interval (60 s), it is handled like a key Omeka
refuses: see "Key not accepted" below. Removing the key file is therefore a way
to cut the server off from private data.

nginx logs query strings by default, so the AMIRA nginx needs a log format that
strips both parameters (an omeka-s-docker change, outside this repository).

### Personal tokens

Generate one per curator:

```bash
node server/tokenCli.js alice          # or: npm run curator-token -- alice
```

It prints a new 256-bit token **once**, for the curator, and the line to add to
the tokens file:

```text
alice 3f1c…(64 hex characters)
```

Only the SHA-256 hash is stored. The server compares the hash of a presented
token against every line in constant time. A lost token cannot be recovered:
generate a new one and replace the line.

- **Revoke** a curator by deleting their line. The file is re-read every 2 s at
  most, so the token stops working within seconds, without a restart. An empty,
  missing or unreadable file grants nothing; a malformed line is ignored (and
  reported by line number).
- **Rotate** by generating a new token and **replacing** the line, never by
  appending one. A name on more than one line grants nothing on any of them
  (and the log names it with the line numbers), so an appended line cannot
  leave a leaked token valid; it locks the curator out until one line remains.
  One hash on several lines is refused the same way.

Curators send `Authorization: Bearer <token>`; see [Client setup](#client-setup).

## Client setup

The hosted endpoint is `https://data.africamultiple.uni-bayreuth.de/curator/mcp`
(Streamable HTTP, stateless). Every request needs `Authorization: Bearer
<token>`: without one, or with an unknown or revoked one, it answers 401 (429
after 20 failures a minute from one address). A token belongs to one curator;
do not share it, and ask for a new one if it leaks, since revocation is central.

**Claude Code**:

```bash
claude mcp add --transport http amira-curator https://data.africamultiple.uni-bayreuth.de/curator/mcp \
  --header "Authorization: Bearer <token>"
```

**Claude Desktop**, through the `.mcpb` relay. Desktop's custom connectors can
send no static header (only OAuth, which comes later), so the extension
forwards instead. Install `amira-mcp-server.mcpb`, open **Settings →
Extensions → AMIRA → Configure**, paste the token into **Curator token**, save,
and restart the extension. The field is masked and the token is kept in the OS
keychain. With a token, the extension's local process becomes a relay: a stdio
server for Claude Desktop that forwards every message unchanged to the curator
endpoint, with the token in the header, so Claude sees the curator server's
own tools, instructions and private records. It loads no snapshot, writes no
cache, never crawls Omeka and holds no Omeka key, so nothing private is stored
on the computer. Every failure is reported as a JSON-RPC error that starts
"AMIRA curator relay:" and ends "No public data is served in its place."; it
never falls back to public data. A rejected or revoked token reads "curator
token rejected or revoked (HTTP 401). Check the token in the extension
settings, or clear it for the public dataset."; an unreachable server, "cannot
reach the curator server at …"; an answer that is not MCP at all (a captive
portal or proxy page), "something at … answered, but not with an MCP
response"; and a request still unanswered after five minutes, "the curator
server at … did not answer within 300 s" (`AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS`
sets the deadline). Each failure is logged once, with the token redacted and
the server's response body left out. Clearing the field returns the extension
to the bundled public dataset. The advanced **Curator server URL** setting
(`AMIRA_CURATOR_URL`) must be `https://` (`http://` is accepted only for
`localhost`, `127.0.0.1` and `[::1]`, for tests). The same relay works from any
stdio client: run `server/index.js` with `AMIRA_CURATOR_TOKEN` (and optionally
`AMIRA_CURATOR_URL`) in its environment. It is refused together with
`AMIRA_ACCESS=curator` and by the HTTP server. Server-initiated requests
(sampling, elicitation) cannot cross the relay, since the stateless endpoint
cannot match an answer to the stream that asked; the curator server sends none.

**Other header-capable clients** (Gemini CLI, Codex, VS Code, the MCP
Inspector, …): add a Streamable HTTP server with the URL above and an
`Authorization: Bearer <token>` header, in whatever form the client's MCP
configuration takes for custom headers. Clients that cannot set a header but
run local stdio servers can use the relay as above.

**Chat applications** (claude.ai on the web, ChatGPT): their connectors accept
OAuth or no authentication, not a personal token. They need the OAuth step
(Pocket ID), which is not built yet.

## Snapshots and the cache

- The curator server never loads the bundled public snapshot. At startup it
  serves the curator cache when Omeka confirmed it within the staleness limit,
  and otherwise crawls the API with the key before serving. The last
  confirmation is persisted beside the snapshot (`verified.json`), so a
  restart keeps a snapshot crawled a day ago but confirmed a minute ago.
- One crawl at a time: a request arriving while the retry timer crawls waits
  for that crawl, and shutdown aborts it.
- A refresh that cannot reach GitHub keeps the full-text map and semantic
  neighbours already served, as in public mode.
- **Fetch base and identity are separate.** The snapshot manifest, the cache
  partition and the snapshot id name the instance by its public API
  (`AMIRA_SITE_BASE/api`), never by `AMIRA_API_BASE`, so switching the fetch
  path (internal network, public URL) neither orphans nor splits a cache, and
  the overview and `amira://dataset` cite the public API. Omeka builds the URLs
  it returns (`@id`, `o:original_url`, thumbnails) from the request host; every
  URL under the fetch base's site is rewritten to `AMIRA_SITE_BASE` as the
  response is read, so no internal address reaches a snapshot, a tool result, a
  resource or a link. The curator `/healthz` reports no site at all.
- The manifest records the access mode (`access: "curator"`), and so does the
  cache partition: curator snapshots live under their own hash of the API base
  *and* the mode, so a public and a curator server can never share a directory,
  even under one `AMIRA_CACHE_DIR`. Each mode refuses the other's snapshot,
  bundled or cached. Snapshots written before this change carry no `access` and
  count as public.
- In curator mode the process runs with umask `077`: cache files are readable by
  its own user only.
- **Transient Omeka failures**: the server keeps serving the data it has until it
  has gone `AMIRA_CURATOR_MAX_STALE_HOURS` without Omeka confirming it (a probe
  that finds nothing newer counts as a confirmation). Past that, requests are
  refused until a refresh succeeds, and refreshes are retried on the fast
  schedule below instead of hourly. When there is no data yet (the first crawl
  failed, e.g. Omeka answered 502 while php was restarting), the server retries
  on a timer, without waiting for a request: after 60 s, then doubling up to
  every five minutes, until a crawl succeeds and `/healthz` turns healthy.
  `AMIRA_CURATOR_RETRY_SECONDS` sets the first delay.
- **Key not accepted**: the authentication probe finds nothing private (the key
  is unknown, revoked, mistyped or lacks `view-all`), Omeka answers 401 or
  403, or the key file has been unreadable for more than a minute. The server drops the in-memory store, wipes the curator cache, writes no
  snapshot, logs `Omeka key not accepted or lacks view-all` (or the HTTP status)
  and refuses requests. With live refresh on it retries within five minutes, and
  serves again once the probe and a crawl succeed. A key revoked while the
  server runs is caught at the next refresh, an hour later at most by default.

## Audit and health

Each MCP request logs one line to stderr with the curator's name and what was
called, never a token, a key or an argument:

```text
[amira] audit curator=alice method=tools/call tool=search_research_items
[amira] audit curator=alice method=resources/read resource=export/publications/bibtex
```

A refused request (no token, a malformed header, an unknown or revoked token,
on `/mcp` or `/metrics`) logs one line with the client address and the reason,
never what was presented; at most 30 such lines a minute are written, then one
line counting the rest. After 20 failures in a minute from one address, the
server answers 429 to further failures from it for the rest of the minute; a
valid token is still served. Authenticated requests are rate-limited
(`AMIRA_RATE_LIMIT`) per curator rather than per address:

```text
[amira] audit rejected=unauthorized client=203.0.113.7 path=/mcp reason=unknown_token
```

`/healthz` stays open for the container check but shows only liveness and
freshness (`status`, `access`, the refresh state, the snapshot date), with no
counts (they would tell anyone how many private records exist) and no site.
`/mcp` and `/metrics` require a personal token.

## Public mode is unchanged, and defended in depth

With `AMIRA_ACCESS` unset, the server behaves exactly as before. Its output on a
public snapshot is byte-identical: the new keys (`visibility`, `restricted`,
`admin_url`) only appear in curator mode. Should private content ever reach a
public server, it is dropped twice: the crawl drops private resources, private
values and links to the private resources it has seen before transforming them,
and loading a snapshot drops any private record or `restricted` block again.

## Not yet

- OAuth sign-in (Pocket ID) for claude.ai and ChatGPT (and Claude Desktop
  custom connectors without the relay); see the issue.
- A read-only Omeka role with `view-all`; the service account is a `reviewer`.
- Private podcast and video transcripts are reported by length in `restricted`
  but not paged, and `get_text_passages` does not search them.
- Item-set rows inside a collection (`item_sets: [{ id, code }]`) carry no
  `visibility`; the collection itself does.
- The `search` output schema still describes `url` as the public record page;
  for a private row it is the admin page.
