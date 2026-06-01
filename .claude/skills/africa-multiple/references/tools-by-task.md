# Tools by task

All 18 tools are read-only. Results are JSON. Search/list tools return a pagination envelope:
`{ count, total_matches, offset, has_more, next_offset?, results[] }` (plus an echoed `filters` block).
Every record carries a citable `dashboard_url`.

## Scoping

| Task | Tool | Notes |
| --- | --- | --- |
| Understand the whole collection | `get_collection_overview` | No args. Counts, breakdowns, content date range, snapshot freshness. Call first. |

## Research items (the ~4,000 digitised artefacts)

| Task | Tool | Key params |
| --- | --- | --- |
| Find items about a subject | `search_research_items` | `subject` (e.g. "Islam", "Architecture") |
| Find items from a place | `search_research_items` | `location` (any level) or `country` |
| Find items by a contributor | `search_research_items` | `contributor` |
| Items in a project / section / university | `search_research_items` | `project_id`, `research_section`, `university` |
| By media type / language / genre / tag | `search_research_items` | `resource_type`, `language` (name or ISO code — "French" matches both `fre` and `fra`), `genre`, `tag` |
| By date | `search_research_items` | `year_from`, `year_to` |
| Free text | `search_research_items` | `keyword` (title, abstract, note, tags, identifiers) |
| Full record of one item | `get_research_item` | `dre_id` (e.g. "abg-99-0000") |

Filters are AND-combined and all optional. Default `limit` 20 (max 100).

## Projects

| Task | Tool | Key params |
| --- | --- | --- |
| Find projects | `search_projects` | `keyword`, `university`, `research_section`, `principal_investigator`, `member`, `institution` |
| Full project detail | `get_project` | `id` (e.g. "UBT_ArtWorld2019", "Ext_ILAM") — returns item breakdown + top subjects |

`item_count` distinguishes projects with digitised items from registry-only entries.

## Research sections

| Task | Tool |
| --- | --- |
| List the cluster's thematic sections (+ PIs, counts) | `list_research_sections` |
| One section's description, objectives, and projects | `get_research_section` (`name`) |

## People & organisations

| Task | Tool | Key params |
| --- | --- | --- |
| Search people | `search_persons` | `keyword`, `affiliation` |
| Full person profile (PI/member/contributor/author) | `get_person` | `name` ("Surname, Forename") |
| List / detail institutions | `list_institutions` / `get_institution` | `keyword` / `name` |
| List groups | `list_groups` | `keyword` |

## Discovery facets (vocabulary)

| Task | Tool | Notes |
| --- | --- | --- |
| Subjects ranked by item count | `list_subjects` | LCSH headings; feed back into `search_research_items` `subject` |
| Places ranked by item count | `list_locations` | `level` = country/region/city; `country` filter; returns coordinates |
| Tags / genres / languages / resource types | `list_categories` | `category` enum; feed values into the matching item filter |

## Bibliography

| Task | Tool | Key params |
| --- | --- | --- |
| Search publications | `search_publications` | `keyword`, `author`, `type`, `year_from`/`year_to` |
| Full publication + BibTeX | `get_publication` | `id` (e.g. "eref-95983") |

## Cross-entity discovery

| Task | Tool | Key params |
| --- | --- | --- |
| What connects to X? | `find_related` | `entity_type` (subject/location/person/project/tag) + `value` |

Returns ranked related projects, sections, subjects, people, locations, tags (with co-occurrence counts)
plus sample items. The go-to tool for relational questions ("what themes travel with Y across projects?").

## Worked patterns

- *"What does the collection hold on Islam in West Africa?"* → `get_collection_overview` →
  `list_subjects keyword=Islam` → `search_research_items subject=Islam` (+ `country`) →
  `get_research_item` on the best hits → cite each `dashboard_url`.
- *"Map a person's footprint."* → `get_person name="Beier, Ulli"` (projects, items, publications).
- *"How do Arts & Aesthetics projects relate to a place?"* → `search_projects research_section="Arts & Aesthetics"`
  → `find_related entity_type=location value="Nigeria"`.
