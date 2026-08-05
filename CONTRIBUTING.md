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
```

That chains clean → typecheck → unit tests → stdio smoke → HTTP smoke →
`weigh --check` → `validate:manifest`. CI additionally runs `npm run test:live`
(hits the real API) and `npm run audit:prod` on release.

## Things that will be asked in review

- **Token budget.** Every tool response is weighed at its maximum `limit`
  (`npm run weigh -- --check`). A new field on a list result multiplies by the
  page size; if the check fails, the field belongs on the `get_*` detail tool,
  not the `search_*` one. See "Token budgets" in the README.
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
