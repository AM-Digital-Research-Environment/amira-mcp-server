# Special corpora & analytical tools

Detailed guidance and caveats for Cluster Chronicles, the ILAM *African Music* full-text map,
semantic similarity, the entity graph, close-reading text passages, and corpus comparisons.

## Cluster Chronicles (writer-in-residence programme)

Curated by Ute Fendler (Elnathan John 2021, Jean Luc Raharimanana 2023, Umar Timol 2024, Egara
Kabaji 2026): one record per work — essays and poems (with verbatim **full text**), photographs and
drawings, events and a video.

- **Search:** `search_chronicles` filters by `person` (chronicler, another credited person or someone
  depicted in a photo), `form` (`essay`, `poem`, `still image`, `event`, `video`), `year_from` /
  `year_to`, `subject`, `place` (any hierarchy level or literal venue), `language` and `keyword`
  (reaches into essay/poem texts, flagging `matched_in: "text"` with a `text_snippet`).
- **Detail:** `get_chronicle` returns credits with roles, `depicts`, linked and literal subjects and
  places (literals have `amira_url: null`), `related` works plus linked video/podcast records as
  typed ids, images, and opt-in verbatim text (`include_text=true`, paged via `text_offset` /
  `text_max_chars`).
- **Caveats:**
  - **Every chronicle abstract was written by a language model** (`abstract_ai_generated`,
    `abstract_generated_by`): state this whenever you quote an abstract, and prefer the chronicler's
    own text.
  - French titles carry `title_language: "fr"` with translations in `alternative_titles`.
  - Chronicles also appear in `get_person`, `find_related` (subject/place/person pivots),
    `get_entity_graph`, `get_text_passages` (`chronicle:ID`) and `get_data_quality`, but not in the
    remote `search`/`fetch` pair (use `search_chronicles` / `get_chronicle`).

## ILAM *African Music* full-text map

The full text of ILAM's journal *African Music* (collection `27724`) is private in Omeka. DRE
Visualizations derived public offline statistics from it (657 mapped articles), exposed without
showing or quoting article text on the public server (for private OCR reading on the curator server,
see `amira-curator`):

- `get_fulltext_map` (no args): AI-labelled content groups with sample articles, unclustered count,
  and countries named across the journal.
- `get_fulltext_map group=<id>`: articles in one content group (optional `year_from` / `year_to`).
- `get_fulltext_map words=[...]` (1–6 single words, optional year window): yearly counts and rates
  per 10,000 words (`not_counted` words return `similar` forms).
- `search_research_items mentions_country=…` (also in `list_years`, `list_locations`,
  `compare_collections` filters): articles whose text names a country 3+ times (`country_mentions`).
- `get_research_item` (`closest_in_content`, `full_text_map`) and `find_related
  entity_type=research_item`: closest articles by full-text embedding.

**Caveats:**
- Group labels are **AI-generated and experimental** — always say so and judge a group by its
  articles.
- Neighbour cosine scores sit in a narrow band (~0.90–0.97): compare ranks, not raw scores.
- Country mentions come from a gazetteer (3+ mentions, journal addresses excluded); a mention is not
  a subject heading.
- Word trends cover single unstemmed word forms in 10+ articles; `sparse` years give unstable rates.
- Never claim to have read an ILAM article on the public server.

## Semantic neighbours & semantic map

Precomputed cosine similarities over `google/embeddinggemma-2` vectors of catalogue descriptions
(title, abstract/description, subjects, places — never full text), covering research items,
publications, videos, podcasts, projects and research sections:

- `get_similar_items` (`id`, optional `types`, `limit` ≤ 10): cross-corpus records whose descriptions
  read most alike, with cosine scores. Each neighbour states what the pair also shares in the
  catalogue (`basis: "shared_metadata"` + `shared` subjects/places/people/project) or
  `basis: "wording_only"`.
- Detail tools (`get_research_item`, `get_publication`, `get_podcast`, `get_video`, `get_project`)
  accept `include_similar: true` for five explained neighbours inline.
- `find_related entity_type=record`: counts projects, subjects, people and countries shared across a
  record's 20 closest semantic neighbours — the thematic neighbourhood rather than a look-alike list.
- `get_semantic_map`: whole collection as unnamed k-means groups of records close in meaning
  (`group=<id>` lists a group's records; `id=<record>` finds a record's group and `rank_in_group`).

**Caveats:**
- Present a `wording_only` pair as **"described in similar terms"**, never as a documented catalogue
  link; name what is shared whenever `shared_metadata` is present.
- Characterise `get_semantic_map` groups from `top_subjects`, `top_countries`, `top_projects` and
  central records — never present them as curated categories, and do not cite group ids across
  snapshots (they renumber per build).
- `no_neighbours: "low_signal"` (too little own text) or `"not_in_release"` (newer than the vector
  build) says nothing about the record's importance.

## Entity resolution, graph & close-reading passages

- **`resolve_entity`**: always prefer when a name may be ambiguous. Returns typed ids, separate
  homonym candidates and unresolved literal nodes — never silently merge or pick one person.
- **`get_entity_graph`**: one-hop graph from a typed `seed` (or `item:`/`pub:` alias), distinguishing
  explicit catalogue links from per-corpus co-occurrence (`types` filters neighbours before the
  100-node / 200-edge / 42 KB bounds; `neighbour_types` counts all). Check `truncated` before
  claiming completeness. Page an edge's citations with `edge_id` + `snapshot_id` (`snapshot_changed`
  means restart from a fresh graph).
- **`get_text_passages`**: literal, accent-insensitive phrase search across 1–10 selected
  `publication:ID`, `video:ID`, `podcast:ID` or `chronicle:ID` records (`item:`/`research_item:` on
  the curator server only). Returns bounded passages with exact original UTF-16 offsets (extracted-text
  offsets, not PDF page numbers or timestamps). Every match is reachable via `next_offset`;
  `scanned_matches_capped` flags documents exceeding 10,000 matches. Requires full text exposure.
- Typed ids are interchangeable across tools (`item:ID` = `research_item:ID`, `pub:ID` =
  `publication:ID`).

## Comparisons, data quality & snapshot diffs

- **`compare_collections`**: compare 2–4 project or collection cohorts under identical research-item
  filters. Always report denominators (`total_items`, `matched_items`) and `missing` counts; never
  sum overlapping cohorts or date ranges as disjoint observations.
- **`get_data_quality`**: snapshot coverage, missing metadata, unresolved references, semantic
  coverage and refresh state.
- **`get_snapshot_changes`**: diffs retained local generations from the same source only (never
  arbitrary dates or the live site). Use `added_since` / `modified_since` on search tools for recent
  additions when `history_unavailable` is returned.
