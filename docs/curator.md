# Curator mode

Curator mode is an internal, read-only variant of the server for AMIRA's
developers and data curators ([#26](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/issues/26)).
It reads the Omeka S API with a service key, so it also sees **private records
and private values**, and it serves them only to people holding a personal
token. It is the same code and the same image as the public server, started with
`AMIRA_ACCESS=curator`; nothing changes for the public server or the `.mcpb`.

This first step uses personal bearer tokens, which command-line clients (Claude
Code, Gemini CLI, Codex) send as a header. OAuth sign-in for the chat
applications (claude.ai, ChatGPT) is the next step and is not built yet.

## What "private" covers

Only what Omeka holds. The curator server sees what the service account can see
through the Omeka API; MongoDB, the source archive behind the VPN, stays out of
it.

- **Private resources** (`o:is_public: false`): items in any crawled corpus
  (research items, people, organisations, places, projects, sections,
  publications, journals, podcasts, videos, playlists, languages, subjects),
  item sets and media. Examples: the research items of the item set *Of Art
  Worlds*, and authority duplicates made private when they were merged.
- **Private values on public resources** (`is_public: false`): `dre:mongoId`,
  `dre:security` (DSL1–DSL5), `dre:bitstream`, a private description, and the
  private `bibo:content` that holds the ILAM OCR full text (with its private
  `dre:generatedBy` annotation). Private annotation values on a public value
  count too.

Fields the transformation never reads are not exposed by authentication alone.
Media files are listed (with `visibility`), never downloaded or served.

## How private data is shown

Every result passes through one decoration step (`src/tools/curator.ts`),
applied to every tool and resource, so no tool can forget it:

- **`visibility`**: every object that cites a record carries
  `visibility: "public"` or `"private"`. (The public server omits the field:
  everything it serves is public.)
- **Private records** lose `amira_url`, since anonymous visitors cannot open
  that page, and get `admin_url` (the Omeka admin page) and a `citation_note`
  saying not to cite them as public. Any other public URL of a private record
  inside a string (a generated citation, a `fetch` document, an export) is
  rewritten to its admin URL.
- **`restricted`**: a detail result (`get_research_item`, `get_publication`,
  `get_person`, …, and `amira://record/…`) carries the record's private values,
  grouped: `mongo_id`, `security_level`, `bitstream`, `values` (every other
  private value, by property term) and the private full text. Private values
  never appear in the public fields: a private description stays out of
  `description`, a private `bibo:content` out of `fulltext` and `transcript`.
- **Private full text** (the ILAM OCR text, later private publication texts):
  `search_research_items` and `search_publications` match the keyword against it
  (rows matched only there say `matched_in: "restricted_fulltext"` with a
  snippet), and `get_research_item` / `get_publication` return it with
  `include_fulltext`, `fulltext_offset` and `fulltext_max_chars`, paged like
  every other long text. `get_research_item` gains those three parameters in
  curator mode only.
- **Citations and exports mark private records** rather than refusing them: the
  generated citation, BibTeX, RIS and CSL-JSON of a private record carry the
  private-record note and no AMIRA URL (a DOI or repository link, which is the
  publication's own public page, is kept). CSV and JSONL exports carry
  `visibility`, and `admin_url` for private rows.
- **Counts**: `get_collection_overview` adds `visibility`, with public and
  private counts per corpus and how many records carry private values or a
  private full text; `amira://dataset` carries the same split. Facet counts
  (subjects, places, years, …) include private records.
- **Instructions** put the private-record rules first.

## Configuration

Curator mode fails closed: the server refuses to start unless everything below
is in place, and prints every reason (never a secret).

| Env var | Required | Meaning |
| --- | --- | --- |
| `AMIRA_ACCESS` | yes | `curator` (default `public`). Any other value refuses to start |
| `AMIRA_OMEKA_KEY_FILE` | yes | File with the Omeka service key: `key_identity=…` and `key_credential=…` lines (`#` comments allowed), or a JSON object with those two keys. Re-read at most once a minute, so a rotated key is picked up without a restart |
| `AMIRA_MCP_TOKENS_FILE` | yes | Personal tokens, one `name sha256hex` line per curator (`#` comments allowed). Re-read every 2 s at most |
| `AMIRA_CACHE_DIR` | yes | The curator cache, set explicitly. Put it on **tmpfs**: it holds private data |
| `AMIRA_SITE_BASE` | no | The **public** site (default `https://data.africamultiple.uni-bayreuth.de`). Every returned link is built from it: `amira_url`, `admin_url`, citations, media and thumbnail URLs |
| `AMIRA_API_BASE` | in the AMIRA stack | Where the crawl and refresh **fetch** the API: the full API URL including `/api`, e.g. `http://web/api`, so keyed requests stay on the Docker network and never pass the host's nginx, which logs query strings. Default: `AMIRA_SITE_BASE/api`. Must be an absolute http(s) URL, or the server refuses to start (in either mode) |
| `AMIRA_CURATOR_MAX_STALE_HOURS` | no | Default `24`. Data not confirmed by Omeka for longer than this is refused |
| `AMIRA_REFRESH_INTERVAL_HOURS` | no | Default `1` in curator mode (`24` in public mode). Must be greater than 0 and less than the staleness limit |
| `AMIRA_CURATOR_AUTH_PROBE` | no | Default `items?is_public=0&per_page=1`. The keyed request (relative to the API base) that must return a non-empty array before any crawl or refresh; see below |

Curator mode also refuses:

- the stdio server and the `.mcpb` (`server/index.js`): curator mode is HTTP
  only. A local bundle would cache the private snapshot on laptops, and each
  install would need a key that travels in query strings;
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

Omeka reads keys from the query string only, Omeka reads keys from the query string only,
so the server adds `key_identity` and `key_credential` to a request at the last
moment, inside the fetch, and only for requests under the fetch base
(`AMIRA_API_BASE`, else `AMIRA_SITE_BASE/api`): with an internal fetch base the
key is never sent to the public URL. The
key is never stored in the API base, the snapshot manifest, an error, a log
line, `/healthz` or a returned URL; any URL or message that could carry it is
redacted. Keyed requests never follow redirects.

nginx logs query strings by default, so the AMIRA nginx needs a log format that
strips both parameters (an omeka-s-docker change, outside this repository).

### Personal tokens

Generate one per curator:

```bash
node server/tokenCli.js alice          # or: npm run curator-token -- alice
```

It prints a new 256-bit token **once**, for the curator, and the line to append
to the tokens file:

```text
alice 3f1c…(64 hex characters)
```

Only the SHA-256 hash is stored. The server compares the hash of a presented
token against every line in constant time. A lost token cannot be recovered:
generate a new one and replace the line.

- **Revoke** a curator by deleting their line. The file is re-read every 2 s at
  most, so the token stops working within seconds, without a restart. An empty,
  missing or unreadable file grants nothing; a malformed or repeated line is
  ignored (and reported by line number).
- **Rotate** by generating a new token and replacing the line.

Curators send `Authorization: Bearer <token>`, for example:

```bash
claude mcp add --transport http amira-curator https://<host>/curator/mcp \
  --header "Authorization: Bearer amira_cur_…"
```

## Snapshots and the cache

- The curator server never loads the bundled public snapshot. At startup it
  serves the curator cache when it is within the staleness limit, and
  otherwise crawls the API with the key before serving.
- **Fetch base and identity are separate.** The snapshot manifest, the cache
  partition and the snapshot id name the instance by its public API
  (`AMIRA_SITE_BASE/api`), never by `AMIRA_API_BASE`, so switching the fetch
  path (internal network, public URL) neither orphans nor splits a cache, and
  the overview and `amira://dataset` cite the public API. Omeka builds the URLs
  it returns (`@id`, `o:original_url`, thumbnails) from the request host; every
  URL under the fetch base's site is rewritten to `AMIRA_SITE_BASE` as the
  response is read, so no internal address reaches a snapshot, a tool result, a
  resource or a link. `/healthz` reports only the public site.
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
  refused until a refresh succeeds.
- **Key not accepted**: the authentication probe finds nothing private (the key
  is unknown, revoked, mistyped or lacks `view-all`), or Omeka answers 401 or
  403. The server drops the in-memory store, wipes the curator cache, writes no
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

`/healthz` stays open for the container check but shows only liveness and
freshness (`status`, `access`, the refresh state, the snapshot date): counts
would tell anyone how many private records exist. `/mcp` and `/metrics` require
a personal token.

## Public mode is unchanged, and defended in depth

With `AMIRA_ACCESS` unset, the server behaves exactly as before. Its output on a
public snapshot is byte-identical: the new keys (`visibility`, `restricted`,
`admin_url`) only appear in curator mode. Should private content ever reach a
public server, it is dropped twice: the crawl drops private resources, private
values and links to the private resources it has seen before transforming them,
and loading a snapshot drops any private record or `restricted` block again.

## Not yet

- OAuth sign-in (Pocket ID) for claude.ai and ChatGPT; see the issue.
- A read-only Omeka role with `view-all`; the service account is a `reviewer`.
- Private podcast and video transcripts are reported by length in `restricted`
  but not paged; `get_text_passages` does not search private full text.
- The app views (map, graph, …) link records by `amira_url` and show private
  records without a link.
