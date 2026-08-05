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

Please **do not open a public issue** for a suspected vulnerability. Use
either:

- GitHub's private reporting:
  [Report a vulnerability](https://github.com/AM-Digital-Research-Environment/amira-mcp-server/security/advisories/new)
- Email: frederick.madore@uni-bayreuth.de

Include the version (`manifest.json` → `version`, or the release tag), the
transport (stdio or HTTP), and the smallest reproduction you have. Expect an
acknowledgement within about a week; this is research infrastructure
maintained alongside other work, not a staffed on-call rotation.

## Supported versions

Fixes land on `main` and ship in the next tagged release. Only the latest
release is supported — older `.mcpb` builds are not patched in place.
