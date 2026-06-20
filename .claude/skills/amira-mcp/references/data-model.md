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
| `contributors[]` | `{ name, role }` — 50+ MARC relator roles (Author, Photographer, Interviewee, Musician, …). |
| `subjects[]` | Subject headings `{ label, amira_url }` — **includes the former free-form tags** (one merged facet). |
| `places[]` | `{ name, within[], amira_url }` — `within` is the region → country chain. |
| `project` / `research_sections` | Parent project `{ id, name, amira_url }` and its sections. |
| `university` | ubt / unilag / ujkz / ufba / external (from the project id prefix). |
| `languages[]` | Canonical names ("English", "Twi") — query with names or any ISO code. |
| `formats[]` / `physical_notes[]` | Genre/format descriptors (linked authority) and free-text physical notes. |
| `description`, `abstract`, `table_of_contents` | Free text (truncated at 25,000 chars). |
| `sponsors[]`, `provenance[]`, `access_rights[]`, `license` | Funding, holding source, rights. |
| `identifiers[]`, `doi`, `external_urls[]`, `collection_url`, `wisski_url` | Provenance / external links. |
| `related_items[]` | `{ relation (replaces/replaced by/has version/…), title, amira_url }` — resolvable links. |
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
`get_person` aggregates a name across the graph: `as_principal_investigator[]`, `as_member[]`,
`contributed_items[]` (slim refs with the person's `role`; capped at 50, total reported), and
`publications[]` (author/editor). Works even for names absent from the authority list.

## Institution / Group

Organisation authority records, typed: `kind` = institution (508) or group (84). `get_institution`
(works for both) adds `part_of[]`, `partner_categories[]`, funded/hosted projects, affiliated
persons, and contributed items (slim refs); coordinates and Wikidata link when reconciled.
`list_cluster_partners` groups the Africa Multiple institutional partner network by Omeka category:
`amrc`, `privileged`, `cooperation`, and `global`.

## Publication

`id` / `omeka_id` (Omeka o:id), `type` (article/book/chapter/conference/doctoral_thesis/working_paper/…),
`title`, `year`, `authors[]`, `editors[]`, `venue` (journal/book/series title), `volume`, `issue`,
`pages`, `publisher`, `doi`, `isbn`/`issn`, `subjects[]`, `abstract`, `language`,
`repository_urls[]` (ERef/EPub), `url` (publication DOI/repository link), `amira_url` (the AMIRA
record link to cite whenever possible), and `bibtex` (generated from the structured fields).

## Podcast episode / YouTube video

Podcasts: `title`, `series`, `episode`, `date`, `date_status` (published/scheduled/unknown),
`abstract`, `people[]` (speaker/host/sound engineer), `url` plus `amira_url`, and `has_transcript` /
`transcript_length` (43/43 filled in the refreshed 2026-06 snapshot). Videos: `title`, `date`,
`date_status`, `abstract`, `playlists[]`, `speakers[]`, `languages[]`, watch `url`, `amira_url`,
and `has_transcript` (most videos have transcripts). Transcripts are searchable in full via
`search_podcasts` and `search_videos` (a transcript hit returns a `transcript_snippet`), but the
detail tools (`get_video` / `get_podcast`) **omit the transcript text unless
`include_transcript=true`** — then `transcript_offset` / `transcript_max_chars` page it (cap
25k chars per call). The ChatGPT `search` / `fetch` tools use the AMIRA/Omeka page as the primary
`url`; DOI, watch, or listen URLs appear in metadata/text as secondary links.

## Relationships to exploit

- Item → Project (`project.id`) → Research sections; Item → People/Organisations (contributor
  roles); Item → Subjects, Places (hierarchy), Formats, Languages; Item → related items.
- Project → PIs / members / funders / sections.
- Publication contributors ↔ People; Podcast/Video speakers ↔ People.

`find_related` operationalises these: it gathers the items matching a seed entity and ranks
everything that co-occurs with them. Coordinates come from the Location authority records (returned
by `list_locations`).
