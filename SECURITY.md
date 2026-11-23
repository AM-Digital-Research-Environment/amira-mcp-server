# Security policy

## Scope and threat model

The server runs in one of two modes, chosen by `AMIRA_ACCESS`. Both are
**read-only**: no tool writes to the Omeka S instance, so a compromised client
cannot alter AMIRA through this server.

### Public mode (the default)

What the `.mcpb`, the Docker image and the public endpoint run when
`AMIRA_ACCESS` is unset. It serves openly published metadata from the public
[AMIRA](https://data.africamultiple.uni-bayreuth.de) Omeka S site — the same
data any visitor can read in a browser — and holds **no secrets**: no Omeka
key, no account, no database credential. It refuses to start when an Omeka key
file (`AMIRA_OMEKA_KEY_FILE`) or a curator tokens file
(`AMIRA_MCP_TOKENS_FILE`) is configured. Should private content ever reach it
(a crafted API response, a curator snapshot copied into its cache), the crawl
drops private resources and values before transforming them, and loading a
snapshot drops any private record or `restricted` block again; each mode
refuses the other's snapshot. The optional `AMIRA_MCP_BEARER_TOKEN` only keeps
a proxied container from being reached unauthenticated; it guards no data.

### Curator mode (`AMIRA_ACCESS=curator`, since 1.36.0)

An internal, HTTP-only variant for AMIRA's developers and data curators
([docs/curator.md](docs/curator.md)). It **does** hold secrets and private data:

- **An Omeka service key** (`AMIRA_OMEKA_KEY_FILE`), for an account with
  `view-all`. Omeka reads keys from the query string only, so the key is added
  to a request inside the fetch, only for URLs under the fetch base
  (`AMIRA_API_BASE`), with redirects refused, and redacted from the API base,
  the snapshot manifest, every error, log line, `/healthz` and returned URL.
- **Personal token hashes** (`AMIRA_MCP_TOKENS_FILE`): one `name sha256hex`
  line per curator, never the tokens themselves. A presented token is hashed
  and compared in constant time; the file is re-read every 2 s, so deleting a
  line revokes that curator within seconds. An empty, missing or unreadable
  file grants nothing.
- **Private records and values** in memory and in the curator cache
  (`AMIRA_CACHE_DIR`, required explicitly and meant for tmpfs; the process runs
  with umask `077`). They are served only to requests carrying a valid
  personal token, marked `visibility: "private"` with an `admin_url` instead of
  an `amira_url`, with private values kept in a separate `restricted` block.

It fails closed: it refuses to start without the key, the tokens file and an
explicit cache directory, refuses stdio, the `.mcpb`, `fetch-data` and a shared
bearer token, requires a keyed authentication probe to return private data
before every crawl and refresh (Omeka answers a bad key with public data, not
an error), wipes its cache and refuses requests when the key is not accepted,
and refuses data Omeka has not confirmed within `AMIRA_CURATOR_MAX_STALE_HOURS`.
`/healthz` shows no counts; `/mcp` and `/metrics` require a token. Each request
is audited with the curator's name and the tool, never a token, key or argument.

### The curator relay in the `.mcpb`

With a **Curator token** set in the extension settings (`AMIRA_CURATOR_TOKEN`,
kept in the OS keychain by Claude Desktop), the local stdio process becomes a
relay that forwards every message unchanged to the curator endpoint
(`AMIRA_CURATOR_URL`, `https://` only; `http://` only for `localhost`,
`127.0.0.1` and `[::1]`), with the token in the `Authorization` header. It loads no
snapshot, writes no cache and holds no Omeka key. The token is removed from the
process environment once read and redacted from every log line and error. A
rejected token or an unreachable server is an error; it never falls back to
public data.

## What is worth reporting

In either mode:

- A way to make the server read or write files outside its cache directory,
  or execute code, via tool arguments or a crafted API response.
- A way to make the HTTP transport (`server/http.js`) serve one caller's data
  to another, bypass its CORS/origin handling, or be used as an open proxy.
- A dependency vulnerability that reaches production code (the `.mcpb` bundle
  or the Docker image), not just the dev toolchain.
- Anything in the published `.mcpb` or image that ships more than the public
  snapshot and the bundled server — credentials, private records, absolute
  local paths, unrelated files.

Specific to curator mode and the relay:

- **The token store:** a way to authenticate without a listed token, to keep
  access after a line is removed, to recover a token from its hash or from
  timing, or to make a malformed tokens file grant access.
- **Private data reaching public mode:** any private record, private value or
  `restricted` block served by a public server, the `.mcpb`, a public snapshot
  or a public cache; or a private record served with an `amira_url`, or a
  private value in a public field.
- **Key leakage:** the Omeka key in a log line, an error, `/healthz`, a
  returned URL, a snapshot or cache file, or a request sent outside the fetch
  base.
- **The relay:** the personal token sent anywhere but the configured curator
  endpoint's `Authorization` header, written to a log or to disk, accepted over
  plain `http://` to a non-local host, or a relay failure that silently serves
  the public dataset as if it were the curator one.
- Curator data served to a request without a valid token, or curator mode
  starting when one of its fail-closed checks should have refused it.

Out of scope: rate-limiting the public Omeka S API, the content of AMIRA
records themselves, the visibility settings curators choose in Omeka, and
findings that require an already-compromised host (including read access to
the curator's key file, tokens file or tmpfs cache).

## Reporting

Please **do not open a public issue** for a suspected vulnerability. Email
**frederick.madore@uni-bayreuth.de** instead. (GitHub's private reporting is
deliberately switched off for this repository, so the "Report a vulnerability"
button is not the route here.)

Include the version (`manifest.json` → `version`, or the release tag), the
mode (public or curator) and transport (stdio, relay or HTTP), and the
smallest reproduction you have. Never send a real personal token or Omeka key;
describe it instead. Expect an acknowledgement within about a week; this is
research infrastructure maintained alongside other work, not a staffed on-call
rotation.

## Supported versions

Fixes land on `main` and ship in the next tagged release. Only the latest
release is supported — older `.mcpb` builds are not patched in place.

## HTTP deployment and dependency checks

Local HTTP launches bind to `127.0.0.1` by default. Set `HOST=0.0.0.0`
explicitly when exposing the service; the Docker image already does so.
Origin validation remains enabled. Configure `AMIRA_ALLOWED_ORIGINS` for
trusted browser clients and put a public endpoint behind an HTTPS proxy. A
curator server should fetch Omeka over the internal network (`AMIRA_API_BASE`)
and sit behind an nginx whose log format strips `key_identity` and
`key_credential` from query strings ([docs/curator.md](docs/curator.md)).

Behind a reverse proxy, set `AMIRA_TRUST_PROXY=true` so the courtesy rate limit
applies per client rather than to the proxy as a whole. The server trusts only
what the proxy observed — `X-Real-IP`, otherwise the `X-Forwarded-For` entry
`AMIRA_PROXY_HOPS` from the right — never the client-supplied leftmost entry,
and it buckets IPv6 clients by /64. Leave the setting off when clients connect
directly, since they could then choose the header. The in-process limit is a
courtesy control; enforce quotas at the proxy.

Release assets carry GitHub build-provenance attestations
(`gh attestation verify amira-mcp-server.mcpb --repo AM-Digital-Research-Environment/amira-mcp-server`),
which replace the MCPB signatures removed in 1.18.1. The container image
published to GHCR carries a provenance and an SBOM attestation, and the release
fails if Trivy finds a fixable high or critical vulnerability in it before it is
pushed.

`npm run audit:prod` checks runtime dependencies; `npm run audit` includes all
development dependencies. CI and both publishing workflows gate on the full
audit, and the weekly image scan (`.github/workflows/image-scan.yml`) watches
the published image between releases. Audit results change over time; rerun
before release.

The repository packer validates the vendored official MCPB manifest schema and
produces unsigned ZIP bundles. It rejects symlinks and unsafe paths, verifies
required files are included, packs only the active snapshot generation, and
excludes development dependencies and local credentials even if `.mcpbignore`
tries to re-include them. Version 1.18.1 removed the MCPB CLI and its unused
signing/editor dependencies, including the unpatched `node-forge` dependency
responsible for
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
