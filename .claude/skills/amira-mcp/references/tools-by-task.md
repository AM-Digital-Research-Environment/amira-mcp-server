# Tools by task

All 24 tools are read-only. Results are compact JSON. Search/list tools return a pagination envelope:
`{ count, total_matches, offset, has_more, next_offset?, results[] }` (plus a `filters` echo of the
filters you actually passed). Ask for more than a tool's max and it also echoes `requested_limit` /
`effective_limit`. `search_research_items` adds `suggestions` (which filter to drop) when a strict
combination matches nothing. Lookups that miss return `{ error: { code, message, suggested_tool?,
available_values? } }`. Every record carries a citable `amira_url`.

## Scoping

| Task | Tool | Notes |
| --- | --- | --- |
| Understand the whole collection | `get_collection_overview` | No args. Counts (incl. podcasts/videos), breakdowns, content date range, snapshot freshness. Call first. |

## Research items (the ~4,000 digitised artefacts)

| Task | Tool | Key params |
| --- | --- | --- |
| Find items about a subject | `search_research_items` | `subject` (e.g. "Islam", "Architecture") — tags are merged into subjects |
| Find items from a place | `search_research_items` | `location` — a country OR a city (hierarchy-aware: "Nigeria" includes Lagos items). One place filter, no level distinction |
| Find items by a contributor | `search_research_items` | `contributor` (either name order) |
| Items in a project / section / university | `search_research_items` | `project_id`, `research_section`, `university` |
| By media type / language / format | `search_research_items` | `resource_type`, `language` (name or any ISO code incl. legacy `fre`/`ger`), `genre` (format descriptors) |
| By date | `search_research_items` | `year_from`, `year_to` (overlaps the item's content-date range) |
| Free text | `search_research_items` | `keyword` (titles, description, abstract, ToC, identifiers) |
| Full record of one item | `get_research_item` | `dre_id` (e.g. "abg-99-0000") — includes typed `dates`, place hierarchy, sponsors, related items |

Filters are AND-combined and all optional. Default `limit` 20 (max 100).

## Projects

| Task | Tool | Key params |
| --- | --- | --- |
| Find projects | `search_projects` | `keyword`, `university`, `research_section`, `principal_investigator`, `member` (either name order), `institution` (funder) |
| Full project detail | `get_project` | `id` (e.g. "UBT_ArtWorld2019", "Ext_ILAM") — item breakdown + top subjects |

`item_count` distinguishes projects with digitised items from registry-only entries.

## Research sections

| Task | Tool |
| --- | --- |
| List the cluster's thematic sections (+ funding phase, PIs, counts) | `list_research_sections` |
| One section's description, website, and projects | `get_research_section` (`name`) |

## People & organisations

| Task | Tool | Key params |
| --- | --- | --- |
| Search people | `search_persons` | `keyword` (either name order), `affiliation` |
| Full person profile (PI/member/contributor/author) | `get_person` | `name` — either order resolves to 'Surname, Forename' |
| List / detail institutions | `list_institutions` / `get_institution` | `keyword` / `name` (get_institution also resolves groups) |
| List research groups | `list_groups` | `keyword` |

## Discovery facets (vocabulary)

| Task | Tool | Notes |
| --- | --- | --- |
| Subjects ranked by item count | `list_subjects` | Tags merged in; each subject links to its own authority page |
| Places ranked by item count | `list_locations` | Flat list of every place — countries and cities together (hierarchy rolled up, so an item from Lagos counts toward both Lagos and Nigeria); optional `country` narrows; returns coordinates |
| Collections ranked by item count | `list_collections` | Per-project + external item sets; feed the title/id into the `collection` filter of search_research_items |
| Formats / languages / resource types | `list_categories` | `category` ∈ formats (alias: genres) / languages / resource_types |
| Coverage over time (date histogram) | `list_years` | `bucket` = year/decade; `from`/`to` window; `sort` = chronological/count; ranged items count in every year they span |

## Bibliography

| Task | Tool | Key params |
| --- | --- | --- |
| Search publications | `search_publications` | `keyword`, `author`, `type`, `year_from`/`year_to` |
| Full publication + BibTeX | `get_publication` | `id` (e.g. "eref-94882") — BibTeX is generated from the structured fields |

## Podcasts & YouTube videos

| Task | Tool | Key params |
| --- | --- | --- |
| Find podcast episodes | `search_podcasts` | `keyword`, `series`, `person`, year range; results carry `date_status` |
| One episode (transcript opt-in) | `get_podcast` | `id` (numeric, from search); `include_transcript=true` + `transcript_offset`/`transcript_max_chars` for the text |
| Find videos — incl. INSIDE transcripts | `search_videos` | `keyword` (transcript hits flagged `matched_in` + a `transcript_snippet`), `playlist`, `speaker`, `language`, year range |
| One video (transcript opt-in) | `get_video` | `id` (numeric, from search); `include_transcript=true` to include it, paged via `transcript_offset`/`transcript_max_chars` (cap 25k chars/call) |

## Cross-entity discovery

| Task | Tool | Key params |
| --- | --- | --- |
| What connects to X? | `find_related` | `entity_type` (subject/location/person/project) + `value` |

Returns ranked related projects, sections, subjects, people, countries (rolled up to each place's
top-level country), formats (with co-occurrence counts) plus slim sample items. The go-to tool for
relational questions. Matching: subject = substring on labels (incl. former tags); person = name in
either order; location = any hierarchy level; project = id/label. The rule is echoed in `matching`,
and `matched_items` counts *items* (so it can differ from a `list_subjects` heading count).

## Worked patterns

- *"What does the collection hold on Islam in West Africa?"* → `get_collection_overview` →
  `list_subjects keyword=Islam` → `search_research_items subject=Islam` (+ `country`) →
  `get_research_item` on the best hits → cite each `amira_url`.
- *"Map a person's footprint."* → `get_person name="Ulli Beier"` (projects, items, publications).
- *"Where is decoloniality discussed in cluster talks?"* → `search_videos keyword=decolonial` →
  `get_video` for the transcript context → cite the watch `url` + `amira_url`.
- *"How do Arts & Aesthetics projects relate to a place?"* → `search_projects research_section="Arts & Aesthetics"`
  → `find_related entity_type=location value="Nigeria"`.
