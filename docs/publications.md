# Working with the cluster bibliography

The bibliography is harvested from ERef and EPub Bayreuth and published in
[Omeka item set 29918](https://data.africamultiple.uni-bayreuth.de/s/amira/item-set/29918).
The MCP server reads that set without restricting publication templates, so new
upstream types remain discoverable. It does not harvest the repositories directly.

On **9 September 2026**, the public API contained **562 publications**, including
**60 with extracted full text**, and **87 journal authority records**. These are
dated observations, not fixed limits. Start with `get_collection_overview` to
check the running server's counts and snapshot date.

## Discover and count

`list_publication_facets` counts the complete filtered bibliography. Choose one
`facet`: `type`, `year`, `language`, `subject`, `author`, or `venue`.

```json
{"facet":"type","language":"fr"}
```

The response reports `total_publications`, `missing_values`, and a paginated
`results` array with `value` and `publication_count`. Linked values also carry
an `amira_url`. `total_matches` means **distinct facet values**, not publications.
An author/editor credited twice in one publication counts once. A publication
with several subjects counts once under each, so multi-valued facet counts
need not sum to the total. Values are grouped by accent-insensitive label;
these are discovery counts, not a disambiguated bibliometric author network.

Use `limit` (default 25, maximum 100) and `next_offset` to page values. Missing
metadata is counted separately; it is never silently labelled as another type
or language. Year values feed `year_from` and `year_to`, set to the same year.

## Retrieve the matching records

Both `search_publications` and `list_publication_facets` accept the same filters:

| Filter | Matching |
| --- | --- |
| `keyword` | Substring in title, abstract, venue, subjects, or available full text |
| `author` | Authors and editors; either name order |
| `subject` | Partial subject heading |
| `language` | Name or ISO code, including `fr`, `fra`, `fre` |
| `type` | Exact type from the type facet |
| `venue` | Partial journal/book title |
| `has_fulltext` | Whether extracted text exists; `false` is also supported |
| `year_from`, `year_to` | Inclusive publication-year range |

Filters are AND-combined and text comparisons ignore case and accents. An
inverted year range returns `invalid_range`. Publication search is newest first;
it defaults to 25 records and caps at 100 per call.

```json
{"language":"French","subject":"Islam","year_from":2019,"limit":10}
```

For multi-word keyword queries, `search_publications` matches a phrase as a
substring. The HTTP `search` adapter ranks individual terms across multiple
corpora; its matching semantics differ.

## Read and cite

Pass the returned Omeka `id` to `get_publication`. Every retained ERef/EPub
identifier also resolves to the record, including secondary identities from
deduplication. For example, the aliases `eref-95983` and `epub-9405` resolve to
[the same AMIRA record](https://data.africamultiple.uni-bayreuth.de/s/amira/item/29919)
in the September snapshot. These aliases are lookup keys; cite the public page.

Detail includes `identifiers`, `series` (separate from the containing `venue`),
repository URLs, authors/editors, and generated `bibtex` by default. Corporate names are
brace-protected. Unsupported BibTeX categories retain their original type in a
neutral `misc` entry instead of claiming a different qualification or medium.
The bibliography export links to the DOI/repository; in a research answer,
cite `amira_url` and add the DOI as a supplementary link when useful.

Choose an alternative export with `citation_format`:

```json
{"id":"29919","citation_format":"csl-json"}
```

`bibtex`, `ris`, and `csl-json` select the response fields `bibtex`, `ris`, and
`csl_json` respectively. CSL-JSON returns an object; the other formats return a
record string. Exports preserve the AMIRA source link and repository identifiers
in their notes. CSL-JSON distinguishes literal corporate names from personal
names, and all formats keep authors and editors separate. Exports omit abstracts
and full text; read those through the detail fields below.

## Export a filtered bibliography

Pass `citation_format` to `search_publications` to replace its ordinary summaries
with citation entries for the same matching records:

```json
{"language":"fr","citation_format":"ris","limit":25}
```

Each result contains `id`, `omeka_id`, `identifiers`, `amira_url`, and the selected
export field. Filtering and newest-first ordering match ordinary search, with
Omeka ID breaking ties between identical years/titles. Follow `next_offset` until
`has_more` is false. Join the `ris` or `bibtex` strings with blank lines, or collect
the `csl_json` objects into a JSON array for import.

Exports default to and cap at **25 records per call**, with an additional
**44,000-byte UTF-8 limit** on the compact JSON response (Claude Code moves tool
results over 50,000 characters out of the conversation). An early stop sets
`response_limited: true`; always use `next_offset`, since a page may contain fewer
records than requested. Entries are never cut or silently skipped. A single
oversized entry returns `export_too_large` and identifies the publication to read
individually. Without `citation_format`, search still returns up to 100 summaries,
within the same 40,000-character page budget as every list tool.

For a whole result set, `export=bibtex` (or `ris`, `csl-json`, `csv`, `jsonl`) returns
a single `resource_link` to `amira://export/publications/…`. Reading that resource
recomputes the file from the snapshot with the same filters and ordering, up to
10,000 records, so nothing passes through the conversation page by page.

## Richer detail and authority links

| Detail field | Meaning |
| --- | --- |
| `author_refs`, `editor_refs`, `publisher_ref` | Labels with `omeka_id` and `amira_url`; the existing author/editor labels and publisher string remain available |
| `conference_details` | Source conference descriptions, often combining event, location and dates; no inferred splitting |
| `num_pages` | Total page extent, kept separately from the `pages` range or e-locator; CSL-JSON uses `number-of-pages`, text exports keep it in a note |
| `external_links` | Supplementary publisher/web links with labels, separate from repository links |
| `access_rights`, `rights` | Explicit source statements; empty arrays do not imply closed access or absence of copyright |
| `advisers`, `degree_granting_institutions` | Thesis references with labels and linked authority IDs when available |

Literal references have null IDs and URLs. Do not infer identity from matching
labels alone. The 9 September data check found conference descriptions on 40
publications, page extent on 81, supplementary links on 70, access statements on
27, advisers on 7, and degree-granting institutions on 8. Rights statements were
absent in that snapshot; the mapping is ready when records acquire them.

## Read full text

Full text is opt-in and paginated:

```json
{"id":"29919","include_fulltext":true,"fulltext_offset":0,"fulltext_max_chars":5000}
```

The next offset is `fulltext_offset + fulltext_returned_chars`. Continue only
while `fulltext_truncated` is true. A missing full text means this snapshot has
no extracted text; it does **not** establish that the publication is closed
access. Never infer cluster output from this curated bibliography alone.

The experimental metadata-exposure modes apply to filters, facets, authority
links and all citation formats, including notes inside exports. Facets and
structured relationships require `structured`; full-text search/read requires
`full`.

## Maintaining coverage

`npm run fetch-data` rebuilds the local snapshot. Existing schema-v4 snapshots
remain readable: the additional publication fields are optional, with empty/null
fallbacks for older records. Rebuild the snapshot to populate them; restarting an
unchanged older snapshot does not populate newly mapped metadata.

Export mappings follow the [CSL input schema](https://github.com/citation-style-language/schema/blob/master/schemas/input/csl-data.json)
and RIS conventions checked against [Zotero's RIS translator](https://github.com/zotero/translators/blob/master/RIS.js).
Further priorities are recorded in the [roadmap](../ROADMAP.md).
