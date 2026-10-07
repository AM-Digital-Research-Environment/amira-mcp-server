# Data model (as the tools return it)

Every entity is an Omeka S item; the server transforms the site's JSON-LD into the compact records
below at build time. Every record carries `amira_url` — the entity's public page
(`…/s/amira/item/<id>`), the citation target.

## Research item

The central artefact (image, text, audio, moving image, …). Returned in full by `get_research_item`.

| Field | Meaning |
| --- | --- |
| `id` / `omeka_id` | Omeka item id (e.g. `7392`), the final number in `amira_url` and the preferred key for `get_research_item`. Do not surface legacy DRE identifiers in final answers. |
| `title` / `alternative_titles[]` | Main title; translated titles, subtitles and variants. |
| `type` | Text · Image · Audio · Moving image · Manuscript · Dataset · … |
| `dates{}` / `date` | Typed dates keyed `created` / `collected` / `issued` / `copyrighted` / … Rights/admin dates (`copyrighted`, `available`, `valid`, `modified`) are exposed in `dates{}` but excluded from the derived content year range. `date` is the derived content year (range). |
| `contributors[]` | `{ name, role, amira_url?, affiliation_at_time? }` — 50+ MARC relator roles (Author, Photographer, Interviewee, Musician, …); the affiliation is the one recorded for this credit, which can differ from the person's current one. |
| `subjects[]` | Subject headings `{ label, amira_url }` — **includes the former free-form tags** (one merged facet). |
| `places[]` | `{ name, within[], amira_url }` — `within` is the region → country chain. |
| `project` / `research_sections` | Parent project `{ id, name, amira_url }` and its sections. |
| `university` | ubt / unilag / ujkz / ufba / external (from the project id prefix). |
| `languages[]` | Canonical names ("English", "Twi") — query with names or any ISO code. |
| `formats[]` / `physical_notes[]` | Genre/format descriptors (linked authority) and free-text physical notes. |
| `description`, `abstract`, `table_of_contents` | Free text (truncated at 25,000 chars). |
| `sponsors[]`, `access_rights[]`, `license` | Funding and rights statements. |
| `provenance[]` | Holding institution(s) `{ name, amira_url }` — linked when the institution has its own record. |
| `identifiers[]` | `{ value, type }` — e.g. "Locally defined identifier", "Publisher, distributor, or vendor stock number". |
| `doi`, `external_urls[]`, `collection_url`, `wisski_url`, `rdspace_handle` | External links and repository handles. |
| `extent` | Physical or file extent ("126 KB", "3 photographs"). |
| `media[]` / `iiif_manifest` | Attached files `{ type (MIME), url, source, size }` and the IIIF Presentation 3 manifest for viewers. |
| `created` / `modified` | When the record was added to / last changed in AMIRA — not content dates. |
| `related_items[]` | `{ relation (replaces/replaced by/has version/…), title, amira_url }` — resolvable links. |
| `citation[]` | The record's own `dcterms:bibliographicCitation`, when curators supplied one — **31 items of ~4,000 do**. |
| `generated_citation` + `bibtex` | Built by the server from the fields above (creator + role, medium, date, collection, holding repository, `amira_url`) because `citation[]` is almost always empty. `citation_format=ris` / `csl-json` returns `ris` / `csl_json` instead of `bibtex`. |
| `has_media` / `thumbnail` | Whether digitised media is attached; large-thumbnail URL when it is (open `amira_url` to view the full media). |
| `collections[]` | The item sets the item belongs to `{ title, amira_url }` — browsable collection pages. |

Search results are slimmer (no long text); profile views (`get_person`, `get_institution`,
`find_related`) return slim refs `{ id, omeka_id, title, type, date, amira_url }` — drill with
`get_research_item`.

## Project

`id` / `omeka_id` (Omeka o:id), `name`, `description`, `date {start,end}`, `university`,
`research_sections[]`, `principal_investigators[]`, `members[]`, `funded_by[]` (funding
institutions), `website`, `item_count` (0 for registry-only projects); `get_project` adds
`items_by_resource_type` and `top_subjects`.

## Research section

`name`, `funding_phase` ("AM 1.0 (2019–2025)" / "AM 2.0 (2026–2032)", `null` for External),
`date {start,end}`, `description`, `principal_investigators[]`, `members[]`, `spokesperson`,
`website` (the section's page on the cluster site), `project_count`, `item_count`, and (in the get
tool) the `projects[]`. The two phase groups are documented in SKILL.md — read the live list, don't
hardcode it.

## Person

`search_persons` returns `{ name, affiliations[], amira_url }` (names stored 'Surname, Forename').
`get_person` aggregates a complete name (or an id) across the graph: `identifiers[]` (`{ scheme, id,
url }`, e.g. GND), `as_principal_investigator[]`, `as_member[]`, `contributed_items[]` (slim refs with the
person's `role`; capped at 50, total reported), `publications[]` (author/editor) and
`top_collaborators[]` (`shared_items`, `shared_publications`). Works for names absent from the authority
list when they occur as a full credit; a fragment returns candidates.

## Institution / Group

Organisation authority records, typed: `kind` = institution (508) or group (84). `get_institution`
(works for both) adds `part_of[]`, `partner_categories[]`, funded/hosted projects, affiliated
persons, and contributed items (slim refs); coordinates, Wikidata link and `identifiers[]` when
reconciled, and `name_variants[]` (acronyms such as "UJKZ", which also resolve).
`list_cluster_partners` groups the Africa Multiple institutional partner network by Omeka category:
`amrc`, `privileged`, `cooperation`, and `global`.

## Publication

`id` / `omeka_id` (Omeka o:id), `type` — one of nineteen: `article`, `book`, `chapter`,
`conference`, `doctoral_thesis`, `working_paper`, `journal_issue`, `book_review`, `online_post`,
`research_data`, and (added 2026-09) `preprint`, `newspaper_article`, `legal_commentary`,
`encyclopedia_entry`, `translation`, `series_editorship`, `habilitation`, `masters_thesis`,
`bachelors_thesis` — plus
`title`, `year`, `authors[]`, `editors[]`, `venue` (journal/book/series title — for journal articles
also `venue_omeka_id` / `venue_amira_url` / `venue_issn`, linking the Journal authority record),
`volume`, `issue`, `pages`, `publisher`, `doi`, `isbn`/`issn`, `status` (peer-review flag),
`funders[]`, `places_of_publication[]`, `subjects[]`, `abstract` (plus `abstracts[]` `{ lang, text }`
when there are several languages), `language` / `languages[]`,
`identifiers[]` (all ERef/EPub aliases), `series[]` (distinct from the containing venue),
`repository_urls[]` (ERef/EPub), `url` (publication DOI/repository link), `has_media` (open-access
PDF attached) + `thumbnail`, `amira_url` (the AMIRA record link to cite whenever possible), and
`bibtex` by default (`citation_format=ris`/`csl-json` selects `ris`/`csl_json`; all respect exposure settings).
All repository identifiers resolve to the same publication; refreshed snapshots preserve aliases
from deduplicated records. Older v4 snapshots remain readable but need a refresh for these fields.

Detail also exposes `author_refs`, `editor_refs`, `publisher_ref`, `advisers`, and
`degree_granting_institutions`: each reference has `label`, `omeka_id`, and `amira_url` (null IDs/URLs
for literal references). `conference_details[]` preserves the source's combined event/location/date
descriptions. `num_pages` is total page extent, distinct from `pages` ranges/e-locators.
`external_links[]` carries supplementary URLs and labels; `access_rights[]` and `rights[]` preserve
explicit source statements. Empty arrays indicate missing metadata in the loaded snapshot, not
closed access. Structured relationships and statements are hidden below `structured` exposure.

Open-access publications carry the **extracted full text** of their PDF: summaries show
`has_fulltext`, `search_publications keyword=…` reaches into it (`matched_in: "fulltext"` +
`fulltext_snippet`), and `get_publication` returns the text only with `include_fulltext=true`,
windowed by `fulltext_offset` / `fulltext_max_chars` (cap 25k chars/call — full texts run ~100k,
always page).

## Journal

The publication-venue authority (`list_journals`): `journal` (title), `id` / `omeka_id`, `issn`,
`country` (+ `country_amira_url`), `publication_count` (bibliography entries linked to it),
`website`, `amira_url`. Journal articles link here via `venue`; series/book titles stay literal.

## Podcast episode / YouTube video

Podcasts: `title`, `series`, `episode`, `date`, `date_status` (published/scheduled/unknown),
`duration` (ISO 8601, e.g. `PT21M35S`), `abstract`, `people[]` (speaker/host/sound engineer), `url`
plus `amira_url`, `media[]` (the audio file), `transcript_generated_by` (the speech model that wrote the
transcript — all 43 are machine-generated), and `has_transcript` / `transcript_length`. Videos: `title`,
`date`, `date_status`, `abstract`, `playlists[]`, `speakers[]`, `languages[]`, watch `url`, `thumbnail`,
`amira_url`, and `has_transcript` (most videos have transcripts). Transcripts are searchable in full via
`search_podcasts` and `search_videos` (a transcript hit returns a `transcript_snippet`), but the
detail tools (`get_video` / `get_podcast`) **omit the transcript text unless
`include_transcript=true`** — then `transcript_offset` / `transcript_max_chars` page it (cap
25k chars per call). The ChatGPT `search` / `fetch` tools use the AMIRA/Omeka page as the primary
`url`; DOI, watch, or listen URLs appear in metadata/text as secondary links.

## Subjects and places

Subject authorities are either curated **Library of Congress Subject Headings** (646, each with an
`id.loc.gov` URI) or free **tags** (2,438); `list_subjects` reports which. Places carry coordinates and,
when reconciled, a Wikidata id; countries are the roots of the place hierarchy (42), with cities and
regions beneath them.

## Relationships to exploit

- Item → Project (`project.id`) → Research sections; Item → People/Organisations (contributor
  roles); Item → Subjects, Places (hierarchy), Formats, Languages; Item → related items.
- Project → PIs / members / funders / sections.
- Publication contributors ↔ People; Publication venue → Journal; Podcast/Video speakers ↔ People.

`find_related` operationalises these: it gathers the items matching a seed entity and ranks
everything that co-occurs with them. Coordinates come from the Location authority records (returned
by `list_locations`).
