# Contributing

Bug reports, tool-behaviour observations and pull requests are welcome. This
is research infrastructure for the Africa Multiple Cluster of Excellence, so
the bar is "does this stay correct and citable", not "does it compile".

## Before you file anything about the *data*

The server serves what the public AMIRA Omeka S site publishes. If a record is
wrong, missing or duplicated, that is a **curation** matter, not a bug here —
check the record on
[data.africamultiple.uni-bayreuth.de](https://data.africamultiple.uni-bayreuth.de)
first. If the site shows the correct value and this server does not, that *is*
a bug here.

## Setup

```bash
npm ci
npm run fetch-data   # crawls the public Omeka S API into data/ (no key needed)
```

`data/` and `server/` are generated and git-ignored. `npm run fetch-data`
takes a few minutes and hits the public API; you only need it for the smoke
tests, the weigh check and a real `.mcpb` build.

## The loop

```bash
npm run typecheck && npm run build && npm test
```

Before opening a PR, run what CI runs:

```bash
npm run prepack-mcpb
npm run audit
```

That chains clean → typecheck → skill validation → unit tests → stdio smoke → HTTP smoke →
`weigh --check` → `validate:manifest`. Release and data-refresh workflows additionally run `npm run test:live`
(hits the real API). CI, release and data-refresh workflows run `npm run audit`,
including development dependencies; `npm run audit:prod` checks only runtime dependencies.
The test launcher enumerates files so `npm test` works on every supported Node
version (22+) and on Windows, with a 60-second timeout per test.

Tests must be hermetic. Call `hermeticEnv()` from `test/helpers/env.mjs` **before**
importing `server/lib.js`: it clears every inherited `AMIRA_*` variable, turns live
refresh off, isolates the snapshot cache in a temporary directory (a snapshot left
in `~/.amira-mcp/cache` would otherwise outrank the fixture) and removes its
temporary directories on exit. Spawned servers take `childEnv()`. The smoke tests
live in `test/smoke/` and bind the HTTP server to a free port. `connectInMemory()`
in `test/helpers/mcp.mjs` wires a client to a server in-process.

`scripts/mcpb.mjs` validates the official MCPB 0.3 JSON schema and creates unsigned
ZIP bundles with `fflate`. Schema provenance and its MIT license live in
`scripts/vendor/mcpb/`. This keeps unused signing and editor dependencies out of
the build. Packaging tests check archive contents, ignore rules, snapshot layout,
required files, version agreement and unsafe paths. Run `npm run pack-mcpb` after
changing packaging; it runs the prepack checks automatically. CI also packs a
generation-based fixture on Windows.

## Things that will be asked in review

- **Token budget.** Every tool response is weighed at its maximum `limit`
  (`npm run weigh -- --check`) and must stay under 45,000 characters. A new field
  on a list result multiplies by the page size; if the check fails, the field
  belongs on the `get_*` detail tool, not the `search_*` one. Prefer a prompt, a
  resource or a parameter on an existing tool to a new tool: prompts and
  resources cost nothing in the per-turn tool payload. See "Token budgets" in the
  README.
- **Errors are text.** Return failures through `errorResult` / `queryErrorResult`;
  the shared policy (`src/tools/policy.ts`) strips structured content from error
  results and trims every string argument, so handlers never see padded input.
- **Query logic lives in the core.** `src/researchItemQuery.ts`,
  `src/publicationQuery.ts`, `src/matching.ts` and `src/searchRanking.ts` return
  data and typed errors and never import from `src/tools/`.
- **`manifest.json` and the tool surface stay in sync.** The unit tests gate
  the tool list; `npm run validate:manifest` gates the extension manifest. A
  new tool needs an entry in both, plus a row in the README table.
- **Every entity keeps its `amira_url`.** Citability is the point of this
  server — a result a user cannot link back to the source is a regression.
- **Read-only stays read-only.** No tool writes to Omeka S, and nothing needs
  a credential.
- **The bundled snapshot stays authoritative offline.** A code path that only
  works when the live API is reachable is a bug.

## Versioning and releases

Version lives in both `package.json` and `manifest.json` — bump both. Releases
are tag-driven: pushing `v*` builds a fresh snapshot, packs the `.mcpb` and the
companion skill, and publishes the GitHub Release.

`CITATION.cff` is **not** a third file to bump. The release workflow stamps its
`version` and `date-released` from the tag — into the packed `.mcpb`, then back
onto `main` as a follow-up commit. To set it by hand (from `package.json` and
today's date):

```bash
npm run stamp-citation
```

`node scripts/stamp-citation.mjs --check` reports version drift without
writing; it deliberately ignores `date-released`, which records when a release
happened and cannot be derived from the working tree.

## Commit style

Short imperative subject, and say what changed in behaviour rather than which
files moved. The history reads as a changelog — keep it readable.

## Publication changes

Use item set **29918**, never a range of publication template ids. Search and
facets and exports share `src/publicationQuery.ts`; add filters there so counts
and retrieval agree. `src/publicationCitation.ts` owns citation mappings and
`src/publicationExport.ts` bounds batches without cutting entries. Add every export
format to response probes when changing this contract. Preserve all repository
identities during transformation. Keep optional
v4 fields backwards compatible, or bump the snapshot schema for required changes.
See [the publication guide](docs/publications.md) and [roadmap](ROADMAP.md).
