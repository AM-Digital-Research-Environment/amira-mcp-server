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

That chains clean → build → typecheck (server and app views) → skill validation → unit
tests → stdio smoke → HTTP smoke → `weigh --check` → `validate:manifest`; everything
after the build is `npm run prepack-mcpb:ci`. Release and data-refresh workflows run
that part on the build `npm run fetch-data` just made, then the live API tests
(`.github/actions/verify-and-pack`, shared by both). CI, release and data-refresh workflows run `npm run audit`,
including development dependencies; `npm run audit:prod` checks only runtime dependencies.
The test launcher enumerates files so `npm test` works on every supported Node
version (22+) and on Windows, with a 60-second timeout per test. `npm test` builds
with `--sourcemap`, which writes `server/lib.js.map` for the test library only, and
the launcher runs with `--enable-source-maps`, so a failing stack names `src/` lines;
the runtime bundles never get a map.

Which scripts build first: `test`, `test:live`, `benchmark`, `evaluate-retrieval`,
`preview:apps`, `fetch-data` and `curator-token` run `npm run build` themselves.
`smoke`, `smoke:http` and `weigh` do not: they run on the build that already exists
(CI and `prepack-mcpb` run them right after `fetch-data` or a build), so after
changing `src/` run `npm run build` before them.

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
required files, version agreement and unsafe paths. A bundle carries only the
snapshot generation `data/active.json` names (its pointer rewritten to list no
previous one), not the older generations `fetch-data` keeps for history. Run `npm run pack-mcpb` after
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
  The one exception is a private record in curator mode, which gets an
  `admin_url` instead ([docs/curator.md](docs/curator.md)).
- **Read-only stays read-only.** No tool writes to Omeka S, and the public
  server needs no credential. Curator mode reads with one service key; keep it
  inside the fetch (`src/snapshot/http.ts`) and out of every log, error and URL.
- **Private data stays curator-only.** New fields come from the record the
  transforms see, which never holds a private value (`src/visibility.ts`);
  a private value belongs in `restricted`. `test/unit/curator*.test.mjs`
  check both modes through tools, resources, exports and counts.
- **The bundled snapshot stays authoritative offline.** A code path that only
  works when the live API is reachable is a bug.

## Versioning and releases

Version lives in `package.json`, `manifest.json` and `CITATION.cff`. Bump all
three with `npm version <major|minor|patch> --no-git-tag-version`: its `version`
lifecycle runs `scripts/sync-version.mjs`, which copies the new version into
`manifest.json`, then `scripts/stamp-citation.mjs`, which sets `CITATION.cff`'s
`version` and today's `date-released` (`--check` on either script reports
drift). Commit the three with an entry in `CHANGELOG.md`: its `## X.Y.Z` section
becomes the release notes (`scripts/release-notes.mjs`), and a tag without one
fails before anything is published. A unit test requires `CITATION.cff` to cite
`package.json`'s version, so the citation belongs in the version commit, not
after it. Releases are tag-driven: pushing `v*` builds a fresh
snapshot, packs the `.mcpb` and the companion skill, builds the image, and
publishes the GitHub Release and the GHCR image. Released versions are
immutable: `scripts/release-guard.mjs` refuses a version that already exists on
GitHub or the MCP Registry, so fix a release with a new version, never by
moving its tag.

Run `npm run lint` (Biome, rules only) before committing; CI runs it. It reports
nothing, infos included: keep it that way, so a new diagnostic stands out.
`noUselessStringRaw` is off for `src/ui/` and the test helpers, whose CSS and
scripts sit in `String.raw` templates so a backslash added later stays literal;
agent worktrees under `.claude/worktrees/` are skipped. On
Windows ARM64 the native Biome binary can crash; the x64 build under emulation
works.

The release workflow stamps `CITATION.cff` again from the tag, into the packed
`.mcpb`, and commits it back to `main` only when the version commit left it
behind (normally it finds nothing to change). To set it by hand (from
`package.json` and today's date):

```bash
npm run stamp-citation
```

`server.json` (the MCP Registry entry) is not bumped either: in git it is a
placeholder (`0.0.0-stamped-by-release`), and the release's registry job stamps
the version, the `.mcpb` URL and its SHA-256 before publishing it.

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
