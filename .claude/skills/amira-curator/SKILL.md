---
name: amira-curator
description: |
  Operating rules for the internal AMIRA curator MCP server (AMIRA_ACCESS=curator), which exposes
  private Omeka S records and private values alongside public AMIRA data. Use whenever server
  instructions declare CURATOR MODE or tool results include `visibility`, `admin_url`, `restricted`,
  `matched_in: "restricted_fulltext"` / `"restricted_text"` / `"restricted_transcript"`, or
  `possible_duplicate_of` — for reading private items, inspecting security levels/MongoDB ids,
  searching or paging private full text and transcripts, and citing or exporting private records.
---

# AMIRA Curator Mode — Private Records & Values

Rules and tool behaviour for the **internal AMIRA curator server** (`AMIRA_ACCESS=curator`), used by
AMIRA's developers and data curators with personal bearer tokens (or via the Claude Desktop `.mcpb`
curator relay). Use this alongside `amira-mcp` (which covers the general research workflow, corpora
and public `amira_url` citation rules).

You are on the curator server when server instructions begin with `CURATOR MODE` and tool results
carry `visibility`. The public server never serves this skill or any private field.

## Core stance: inform, never forbid

Every note on private material (`citation_note`, `restricted.note`, `restricted_match_note`,
`curator_note`) states **facts**: what is private, that a private record has no public page, and
that a private value or text is not on the public site. Curators are already authorised to read the
data — **do not refuse** to open, inspect, summarise or quote private records or private full text
for a curator. Clearly flag what is private; whether to share a passage externally is the curator's
decision.

## Visibility, URLs and media

- **`visibility`:** every record carries `visibility: "public"` or `"private"` (item-set rows inside
  collections also carry `visibility` when private).
- **Public record (`visibility: "public"`):** cite with its `amira_url` as usual. A public record
  may still carry private values or private text in `restricted` — the record itself stays public,
  while the private values/text are not on the public site.
- **Private record (`visibility: "private"`):** has **no `amira_url`** (anonymous visitors cannot
  open it). It carries **`admin_url`** (`…/admin/item/<id>`, accessible to curators only) and
  `citation_note`. Always **name it as private** and link its `admin_url` rather than presenting it
  as a public source.
- **Media & IIIF:** every media row carries `visibility` (a media of a private record is private
  whatever its own flag). A private media row has `url: null` and an `admin_url`; a private record's
  `thumbnail`, `iiif_manifest` and `iiif_collection` are `null`.
- **App views:** interactive MCP App views link private records to their `admin_url`, marked
  `(private)` and titled as a curators-only page (never as a public citation).

## The `restricted` block (detail tools & `amira://record/…`)

Detail tools (`get_research_item`, `get_publication`, `get_person`, `get_project`, `get_podcast`,
`get_video`, `get_chronicle`, …) and `amira://record/{kind}/{id}` add a `restricted` object whenever
a record has private values:

- `security_level` (`dre:security`, DSL1–DSL5)
- `mongo_id` (`dre:mongoId`)
- `bitstream` (`dre:bitstream`)
- `values` (all other private values grouped by property term, e.g. private `dcterms:description`)
- Private full text / transcript / chronicle text metadata (`has_fulltext` / `fulltext_length` /
  `fulltext_generated_by`, `has_transcript` / `transcript_length`, or `has_text` / `text_length`)

Private values **never** bleed into public fields (a private description never enters `description`;
private `bibo:content` never enters public `fulltext` or `transcript`). Individual private values
longer than 25,000 characters are truncated with `[…truncated: N characters in all]`. When paging
long text, `restricted.values` and `restricted.bitstream` are returned on the first page (offset 0)
only.

## Searching & reading private full text and transcripts

- **Search hits:**
  - `search_research_items` and `search_publications` match `keyword` against private full text
    (such as ILAM *African Music* OCR text): rows matched only there carry
    `matched_in: "restricted_fulltext"` and `fulltext_snippet`, with `restricted_match_note` on the
    envelope. Publications also expose `has_restricted_fulltext`.
  - `search_chronicles` matches private chronicle texts (`matched_in: "restricted_text"`,
    `has_restricted_text`, `text_snippet`).
  - `search_podcasts` and `search_videos` match private transcripts
    (`matched_in: "restricted_transcript"`, `has_restricted_transcript`, `transcript_snippet`).
  - Keyword filters without per-row markers (`list_years`, `list_locations`, `compare_collections`,
    `list_publication_facets`, and `search_publications` with `citation_format` or `export`) add a
    result-level `curator_note` when private text can match (requires `AMIRA_EXPOSURE=full`).
- **Full-text & transcript paging on detail tools (opt-in):**
  - `get_research_item` (adds `include_fulltext`, `fulltext_offset`, `fulltext_max_chars` in curator
    mode only), `get_publication`, `get_chronicle` (`include_text`, `text_offset`, `text_max_chars`),
    and `get_podcast` / `get_video` (`include_transcript`, `transcript_offset`,
    `transcript_max_chars`) page private text under `restricted` (cap 25,000 chars/call).
  - **Combined stream when both public and private text exist:** both share one offset stream; the
    private text begins at `restricted.fulltext_starts_at` (or `transcript_starts_at` /
    `text_starts_at`, equal to the public text's length) and shares the 25,000-character page budget.
    Records with private text only page from offset 0.
- **Close-reading passages (`get_text_passages`):**
  - Accepts `research_item:ID` (and `item:ID`) in curator mode alongside `publication:`, `video:`,
    `podcast:` and `chronicle:`, searching private full text, private chronicle texts and private
    podcast/video transcripts.
  - Private passages carry `matched_in` (`"restricted_fulltext"`, `"restricted_text"` or
    `"restricted_transcript"`) and `restricted_match_note`; offsets are UTF-16 offsets into that
    private text (on records with both public and private text, add `restricted.*_starts_at` when
    jumping to the detail tool). Public passages appear before private ones.

## Counts, duplicates, embeddings & exports

- **Counts:** `get_collection_overview` adds `access: "curator"` and `visibility` (public vs private
  counts per corpus, plus counts of records with private values or private full text);
  `amira://dataset` carries the same split. Facet counts include private records, so totals differ
  from the public site.
- **Retired private authority duplicates:** when a public record and a retired private duplicate
  share a name, lookups resolve to the public record; the private copy appears after it with
  `possible_duplicate_of`.
- **Semantic neighbours:** corpus embeddings come from the public API only, so private records are
  never embedded (`get_data_quality` reports them separately as `private_not_embedded`).
- **Citations & exports:** generated citations, BibTeX, RIS and CSL-JSON mark private records as
  `Private AMIRA record` and omit public `amira_url` (external DOIs/repository URLs stay). CSV/JSONL
  exports include `visibility` and `admin_url` for private rows, and never include `restricted`.
