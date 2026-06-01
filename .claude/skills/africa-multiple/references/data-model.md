# Data model (as the tools return it)

The server normalises the dashboard's Extended-JSON value wrappers before returning anything, so you
work with plain values. Publications come from a separate bibliography feed and are merged into the
same shape.

## Research item

The central artefact (image, text, audio, moving image, etc.). Returned in full by `get_research_item`.

| Field | Meaning |
| --- | --- |
| `dre_id` | Stable identifier (e.g. `abg-99-0000`). The key for `get_research_item` and citations. |
| `title` / `titles[]` | Main title; `titles[]` also holds translated variants. |
| `type_of_resource` | Image · Text · Audio · Moving image · … |
| `contributors[]` | `{ name, qualifier (person/institution/group), role (Author/Editor/Photographer/…), affiliations[] }` |
| `subjects[]` | LCSH subject headings `{ label, uri }`. The `label` is the canonical heading. |
| `locations[]` | Origin places `{ country (l1), region (l2), city (l3) }`. Levels may be partly empty. |
| `project` | `{ id, name }` — links to the parent project. |
| `research_sections` | The parent project's sections. |
| `university` | ubt / unilag / ujkz / ufba / external (inferred from the project id prefix). |
| `language[]` | ISO 639-2 codes (eng, yor, fra, …). |
| `genre[]`, `tags[]`, `target_audience[]` | MARC genre terms; free-form keywords; intended audiences. |
| `abstract`, `note`, `table_of_contents` | Free text (truncated at 25,000 chars). |
| `identifiers[]`, `access_condition`, `citation[]`, `external_urls[]` | Provenance / rights / external links. |

## Project

Returned by `search_projects` / `get_project`.

| Field | Meaning |
| --- | --- |
| `id` | e.g. `UBT_ArtWorld2019`, `ULG_WOPP2021`, `Ext_ILAM`. |
| `name`, `description`, `date {start,end}` | |
| `university` | From the id prefix. |
| `research_sections[]` | One or more thematic sections. |
| `principal_investigators[]`, `members[]`, `emails[]` | People (names as `Surname, Forename`). |
| `institutions[]` | Affiliated institutions. |
| `item_count` | How many digitised items belong to it (0 for registry-only projects). |

## Research section

Returned by `list_research_sections` / `get_research_section`: `name`, `funding_phase`
("AM 1.0 (2019–2025)" / "AM 2.0 (2026–2032)", or `null` for the synthetic External grouping),
`date {start,end}`, `description`, `objectives`, `work_programme`, `principal_investigators[]`,
`members[]`, `spokesperson`, `project_count`, `item_count`, and (for `get_research_section`) the
`projects[]` in it. **The cluster has two distinct groups of sections, one per funding phase** — group or
filter by `funding_phase`, and always read the live list rather than hardcoding it:

- **AM 1.0 (2019–2025):** Affiliations, Arts & Aesthetics, Knowledges, Learning, Mobilities, Moralities
  — all current projects/items belong here.
- **AM 2.0 (2026–2032):** Accumulation, Digitalities, Ecologies, In/securities, Re:membering, Translating
  — newly seeded; `project_count`/`item_count` are ≈0 in the current snapshot.
- plus a synthetic **External** grouping for outside collections.

Filter with the exact strings returned (incl. "In/securities", "Re:membering").

## Person

`search_persons` returns `{ name, affiliation[] }`. `get_person` aggregates a name across the graph:
`as_principal_investigator[]`, `as_member[]`, `contributed_items[]` (with role; capped at 50, total
reported), and `publications[]` (author/editor). Works even for names absent from the authority list.

## Institution / Group

`Institution`/`Group` are essentially `{ name }` authority records. `get_institution` adds the projects
affiliated with it and the items whose contributors are affiliated with it.

## Publication

A separate bibliography (ERef + EPub Bayreuth), not from the item collections. Fields: `title`, `type`
(article/book/chapter/conference/doctoral_thesis/working_paper/report/…), `year`, `authors[]`,
`editors[]`, venue (`journal`/`booktitle`/`series`/`volume`/`issue`/`pages`), `publisher`, `doi`,
`isbn`/`issn`, `keywords[]`, `abstract`, `language`, `url` (canonical DOI/permalink — cite this),
`eref_url`/`epub_url`, and ready-to-use `bibtex`.

## Relationships to exploit

- Item → Project (`project.id`) → Research sections (`project.research_sections`).
- Item → People (contributor `name`), Institutions (contributor `affiliations`), Groups (qualifier `group`).
- Item → Subjects (LCSH `label`), Locations (`country`/`region`/`city`), Tags, Genres, Languages.
- Project → PIs / members / institutions / sections.
- Publication contributors ↔ People (reconciled by name).

`find_related` operationalises these: it gathers the items matching a seed entity and ranks everything
that co-occurs with them. Coordinates for places come from a slimmed geo lookup (returned by
`list_locations`).
