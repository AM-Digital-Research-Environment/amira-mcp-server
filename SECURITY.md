# Security policy

## Scope and threat model

This server is **read-only** and holds **no secrets**. It serves openly
published metadata from the public
[AMIRA](https://data.africamultiple.uni-bayreuth.de) Omeka S site — the same
data any visitor can read in a browser. There is no API key, no account, no
database credential and no write path to the Omeka S instance, so a
compromised client cannot alter AMIRA through this server.

What is still worth reporting:

- A way to make the server read or write files outside its cache directory,
  or execute code, via tool arguments or a crafted API response.
- A way to make the HTTP transport (`server/http.js`) serve one caller's data
  to another, bypass its CORS/origin handling, or be used as an open proxy.
- A dependency vulnerability that reaches production code (the `.mcpb` bundle
  or the Docker image), not just the dev toolchain.
- Anything in the published `.mcpb` that ships more than the snapshot and the
  bundled server — credentials, absolute local paths, unrelated files.

Out of scope: rate-limiting the public Omeka S API, the content of AMIRA
records themselves, and findings that require an already-compromised host.

## Reporting

Please **do not open a public issue** for a suspected vulnerability. Email
**frederick.madore@uni-bayreuth.de** instead. (GitHub's private reporting is
deliberately switched off for this repository, so the "Report a vulnerability"
button is not the route here.)

Include the version (`manifest.json` → `version`, or the release tag), the
transport (stdio or HTTP), and the smallest reproduction you have. Expect an
acknowledgement within about a week; this is research infrastructure
maintained alongside other work, not a staffed on-call rotation.

## Supported versions

Fixes land on `main` and ship in the next tagged release. Only the latest
release is supported — older `.mcpb` builds are not patched in place.

## HTTP deployment and dependency checks

Local HTTP launches bind to `127.0.0.1` by default. Set `HOST=0.0.0.0`
explicitly when exposing the service; the Docker image already does so.
Origin validation remains enabled. Configure `AMIRA_ALLOWED_ORIGINS` for
trusted browser clients and put a public endpoint behind an HTTPS proxy.

`npm run audit:prod` checks runtime dependencies; `npm run audit` includes all
development dependencies. CI and both publishing workflows gate on the full
audit. On 5 October 2026 both audits reported zero vulnerabilities for v1.18.1.

Version 1.18.1 removes the MCPB CLI and its unused signing/editor dependencies,
including the unpatched `node-forge` dependency responsible for
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
The repository packer validates the vendored official manifest schema and
produces unsigned ZIP bundles. It rejects symlinks and unsafe paths, verifies
required files are included, and excludes development dependencies and local
credentials even if `.mcpbignore` tries to re-include them. No dependency audit
exceptions or overrides are needed. Audit results change over time; rerun before
release.
