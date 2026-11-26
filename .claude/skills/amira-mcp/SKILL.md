---
name: amira-mcp
description: |
  Research workflow, citation rules (amira_url) and coverage caveats for the AMIRA MCP server
  (amira-mcp-server) — the Africa Multiple Cluster of Excellence research data on Omeka S
  (data.africamultiple.uni-bayreuth.de). Use when querying or synthesising AMIRA research items
  (archival artefacts, images, audio, maps), projects, research sections (AM 1.0 / AM 2.0), people,
  institutions, groups, the cluster bibliography (with open-access PDF full text and BibTeX/RIS/CSL-JSON
  exports), journals, podcasts, YouTube transcripts, Cluster Chronicles (writer-in-residence essays,
  poems, photos), the ILAM African Music full-text map, entity graphs, or semantic similarity.
---

# Africa Multiple Research Data — MCP Workflow

Context, workflow and citation contract for **amira-mcp-server**. It exposes the research data of
the **Africa Multiple Cluster of Excellence** (University of Bayreuth, DFG EXC 2052) as published on
its public **Omeka S** site at <https://data.africamultiple.uni-bayreuth.de> (AMIRA), built and
maintained by the cluster's **Digital Research Environment (DRE)**.

This skill covers research questions answered with the MCP tools. The Omeka data model, REST API and
sync pipelines belong to the separate `africa-multiple-data` skill. On the internal **curator
server** (where server instructions start with `CURATOR MODE`), also read the companion
`amira-curator` skill for private records, `admin_url`, `restricted` values and private full text.

## Which reference to read (progressive disclosure)

Read only the reference needed for the task at hand:

| Need | Reference |
| --- | --- |
| Full 38-tool catalogue (40 over HTTP), filter params, MCP Apps charts, worked patterns | [references/tools-by-task.md](references/tools-by-task.md) |
| Field-level shapes of items, projects, sections, people, publications, media, chronicles | [references/data-model.md](references/data-model.md) |
| Cluster Chronicles, ILAM *African Music* full-text map, semantic neighbours/map, entity graph, text passages, cohort comparisons | [references/special-corpora.md](references/special-corpora.md) |
| Step-by-step recipes (literature review, project dossier, person profile, place report, transcript evidence) & evidence ledger | [references/research-recipes.md](references/research-recipes.md) |
| Cluster mission, funding phases, core concepts, AMRCs, DRE, other cluster bodies | [references/cluster-context.md](references/cluster-context.md) |

## Collection at a glance

AMIRA connects data across the cluster's five **Africa Multiple Research Centres (AMRCs)** —
University of Bayreuth (coordinating DRE), Université Joseph Ki-Zerbo, Rhodes University, University
of Lagos and Moi University (older records say African Cluster Centres, ACC) — and global partners.
**Federal University of Bahia** is a privileged partner, not an AMRC.

The `university` facet on projects is a current data/source label, not a formal AMRC list: **UBT**
(Bayreuth), **ULG** (Lagos), **UJKZ** (Ouagadougou), **UFB** (Bahia) and **External** (outside
collections such as ILAM / *African Music* at Rhodes and Bayreuth Global / Bayreuth Postkolonial).

**Research sections** were redefined between funding phases — read the live list with
`list_research_sections` rather than hardcoding:
- **AM 1.0 (2019–2025):** Affiliations, Arts & Aesthetics, Knowledges, Learning, Mobilities,
  Moralities (nearly all projects and all digitised items so far).
- **AM 2.0 (2026–2032):** Accumulation, Digitalities, Ecologies, In/securities, Re:membering,
  Translating (a first few projects, no items yet — empty item results are expected).
- **External:** synthetic grouping for outside collections.

```
ResearchSection ── projects belong to one or more sections
      │
   Project ──(items)── ResearchItem ──┬── contributors (Person / Institution / Group, with roles)
      │                               ├── subjects (incl. former free-form tags — one merged facet)
      ├── PIs & members               ├── places (countries + cities; `location` walks hierarchy)
      └── funding institutions        └── typed dates, formats, languages, media / IIIF, relations

Publication (bibliography) ── authors/editors → People; venue → Journal; OA PDFs carry full text
Podcast / YouTube video ── speakers → People; episodes & most videos carry searchable transcripts
Cluster Chronicles ── writer-in-residence essays, poems (verbatim text), photos, events, video
```

Every entity is an Omeka item with a stable public page: **`amira_url`** (`…/s/amira/item/<id>`).
Data comes from a snapshot of the public Omeka S API (works offline, optional live refresh);
`get_collection_overview` reports its source and freshness (`data_snapshot`).

## Workflow

Batch independent tool calls in one turn (hosts cap tool rounds, not calls per turn) and sequence
only calls that depend on an earlier id or resolution.

### 1 — Scope
Call `get_collection_overview` once for counts across every corpus, text/transcript coverage,
breakdowns, content date range and `data_snapshot`. Many projects are registry entries without
digitised items (`item_count` separates them). In MCP Apps hosts it also renders a dashboard —
always read numbers from the JSON payload.

### 2 — Search
Pick the right entry point for the corpus:
- **Research items** → `search_research_items` (`keyword`, `subject`, `location` at any hierarchy
  level, exact `country` with aliases such as `Côte d'Ivoire` = `Ivory Coast`, `location_id`,
  `contributor`, `project_id`, `collection`, `research_section`, `university`, `resource_type`,
  `genre`, `language`, `year_from`/`year_to`, `has_media`, `added_since`/`modified_since`,
  `mentions_country`). Multi-word `keyword` matches records containing **every** word; quote a
  phrase for an exact match. Empty strict combinations return `suggestions` and `did_you_mean` —
  relax rather than giving up.
- **Projects & sections** → `search_projects`, `list_research_sections`.
- **People & organisations** → `search_persons`, `resolve_entity`, `list_institutions`,
  `list_cluster_partners`, `list_groups`.
- **Bibliography & journals** → `search_publications` (`keyword` searches abstracts and extracted OA
  PDF full text, flagging `matched_in: "fulltext"` + snippet; `include_abstract=true` adds
  abstracts/subjects to summaries), `list_publication_facets`, `list_journals`.
- **Talks, audio & chronicles** → `search_podcasts`, `search_videos` (both search transcripts),
  `search_chronicles` (searches essay/poem texts).
- **Vocabulary & timelines** → `list_subjects`, `list_locations`, `list_collections`,
  `list_categories` (formats/languages/resource_types), `list_years` (year/decade histogram).

Keep `limit` modest (10–25) while scoping and paginate with `offset` / `next_offset` (pages may stop
early at the byte budget with `response_limited: true`). For whole result sets, pass `export`
(`csv`/`jsonl`; publications also `bibtex`, `ris`, `csl-json`) to receive an `amira://export/…`
`resource_link`.

### 3 — Drill
Use `get_research_item`, `get_project`, `get_research_section`, `get_person`, `get_institution`,
`get_publication`, `get_podcast`, `get_video` or `get_chronicle` by Omeka `id` / `omeka_id` or typed
id (`item:`/`research_item:`, `pub:`/`publication:`, `person:`, `project:`, `video:`, `podcast:`,
`chronicle:`). `get_person` requires a complete name (either order) or exact `id`; fragments and
homonyms return candidates.

**Long texts are opt-in and paged:** `get_publication` (`include_fulltext`, `fulltext_offset`,
`fulltext_max_chars`), `get_podcast` / `get_video` (`include_transcript`, `transcript_offset`,
`transcript_max_chars`), `get_chronicle` (`include_text`, `text_offset`, `text_max_chars`). When
paging, advance by reported `*_returned_chars` (important on the HTTP `fetch` tool, where the window
shares `max_chars` with the metadata header).

### 4 — Connect & analyse
- **Co-occurrence pivot:** `find_related` (by `subject`, `location`, `person`, `project`,
  `research_item` for ILAM content neighbours, or `record` for semantic-neighbour themes).
- **Exact identity & graph:** `resolve_entity` (never silently merge homonyms) → `get_entity_graph`
  (explicit catalogue links vs per-corpus co-occurrence, paginated edge evidence via `edge_id` +
  `snapshot_id`).
- **Close reading:** `get_text_passages` for bounded literal-phrase passages with exact UTF-16
  extracted-text offsets across selected `publication:`, `video:`, `podcast:` and `chronicle:` ids.
- **Similarity, maps & comparisons:** `get_similar_items`, `get_semantic_map`, `get_fulltext_map`,
  `compare_collections`, `get_data_quality`, `get_snapshot_changes`. Read
  [references/special-corpora.md](references/special-corpora.md) for their caveats and exact rules
  before citing AI-labelled groups or `wording_only` semantic neighbours.

### 5 — Synthesise with citations (and prompts/resources)
For structured deliverables (literature review, project dossier, researcher profile, place report,
transcript evidence), follow [references/research-recipes.md](references/research-recipes.md) (hosts
also expose these five workflows as MCP prompts). Data resources `amira://record/{kind}/{id}` and
`amira://dataset` provide citable JSON and schema.org dataset provenance.

## Citation rules (important)

- **Always render every mentioned entity's `amira_url` as a markdown link**, e.g.
  `[Lagos Immigration Map](https://data.africamultiple.uni-bayreuth.de/s/amira/item/9902)`.
- **Never print legacy DRE identifiers.** When an id is explicitly needed, use the Omeka
  `id` / `omeka_id` (the final number of `amira_url`). Never collapse items into an id range — list
  each referenced item with its own link.
- For publications, videos and podcasts, keep `amira_url` as the main link; add DOI, repository,
  watch or listen URLs only as secondary links where helpful.
- **Never invent URLs or ids** — use only values returned by tools.
- **Formal references:** do not hand-assemble them. `get_research_item` and `get_publication` return
  `generated_citation` plus `bibtex` (or `ris` / `csl_json` via `citation_format`). On research
  items, prefer curated `citation[]` verbatim when present (~31 items) and use `generated_citation`
  otherwise. For a filtered bibliography export, use `search_publications` with `export=…` (one
  resource link) or `citation_format=ris|bibtex|csl-json` paged via `next_offset`.

## Key caveats

1. **Snapshot, not live API.** Data reflects the last crawl (`get_collection_overview` →
   `data_snapshot`) and may lag the live site.
2. **Curated, not exhaustive.** Absence of a result is never proof of absence.
3. **Uneven coverage.** Item counts skew toward a few large collections (ILAM *African Music*,
   Liberia broadcasting tapes); disclose this when comparing universities, places or themes.
4. **Projects ≠ items.** Many projects are registry entries (`item_count: 0`).
5. **Names & ethics.** People are stored `Surname, Forename` — always display and cite that form
   (filters accept either order). A person's records reflect what AMIRA catalogues, not their full
   work or standing: never rank, rate or evaluate researchers.
6. **Accent-insensitive everywhere.** `Côte d'Ivoire` and `Cote d'Ivoire` are identical queries in
   every tool — do not re-query in a second spelling.
7. **Subjects absorb tags.** Free-form tags and LCSH headings share one `subject` facet (distinguished
   by `vocabulary=lcsh|tag` on `list_subjects`).
8. **Canonical languages.** Names, ISO 639-1/2 and legacy bibliographic codes (`fre`, `ger`) all work.
9. **Opt-in texts & coverage.** Podcast transcripts cover all episodes; video transcripts cover most
   videos; publication full text covers only EPub PDF deposits (ERef is metadata-only — missing text
   does not mean closed access). Podcast transcripts are machine-generated (`transcript_generated_by`);
   Cluster Chronicles abstracts are AI-written (`abstract_ai_generated`).
10. **Places & dates.** `list_locations` rolls up countries and places into one flat ranked list
    (`level`: `country` or `place`); `location` matches any level (and may match homonyms — use
    `location_id` for exact authority + descendants); `country` matches countries only. Podcasts and
    videos tag `date_status` (`published`, `scheduled`, `unknown`) — flag future scheduled dates.
    Research-item year filters use content dates, not rights/admin dates; inverted ranges return
    `invalid_range`.
11. **Structured errors & profiles.** Errors return `{ error: { code, message, suggested_tool?,
    available_values? } }` — use them to recover. Full mode exposes 38 core tools (40 over HTTP);
    smaller profiles (`research`, `discovery`, `visualization`) omit subsets — rely on the advertised
    catalogue.
