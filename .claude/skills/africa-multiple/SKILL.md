---
name: africa-multiple
description: |
  Research workflow and context for the Africa Multiple MCP server (the amira dashboard data).
  Use this skill when:
  - Querying the Africa Multiple MCP server (africa-multiple-mcp-server tools) about the cluster's
    research projects, research sections, digitised research items, people, institutions, groups,
    publications, subjects, or locations
  - Investigating the Africa Multiple Cluster of Excellence's digital research collections
  - Exploring how a theme, place, or person connects across projects and collections
  - Building cited research outputs grounded in the amira dashboard
  It provides cluster background, a query workflow, tool-selection guidance, citation conventions, and
  the collection's coverage caveats. See the bundled references for the data model and tool catalogue.
---

# Africa Multiple Research Data — MCP Workflow

Context and method for working with the **africa-multiple-mcp-server** tools, which expose the research
data of the **Africa Multiple Cluster of Excellence** (University of Bayreuth) as published by the
**amira dashboard** at <https://amira.africamultiple.uni-bayreuth.de>.

## What this collection is

Africa Multiple is a Cluster of Excellence studying Africa and its diasporas through the lens of
**multiplicity** and **relationality**. Its digital research environment gathers material produced by
collaborative projects across four partner universities and some external collections:

- **UBT** — University of Bayreuth (Germany)
- **ULG** — University of Lagos (Nigeria)
- **UJKZ** — Université Joseph Ki-Zerbo, Ouagadougou (Burkina Faso)
- **UFB** — Federal University of Bahia (Brazil)
- **External** — e.g. the International Library of African Music (ILAM, Rhodes University) and
  Bayreuth Global / Bayreuth Postkolonial

Work is organised into thematic **research sections** (don't hardcode the list — read it with
`list_research_sections`; it currently includes Affiliations, Arts & Aesthetics, Knowledges, Learning,
Mobilities, Moralities plus newer thematic sections and a synthetic "External" grouping).

The data is **read from a snapshot of the dashboard's public JSON** — the server contacts no backend
database, so it works offline and needs no database, key, or credentials.

## The entities (and how they connect)

```
ResearchSection ── research projects belong to one or more sections
      │
   Project ──(items)── ResearchItem ──┬── contributors (Person / Institution / Group, with roles)
      │                               ├── subjects (LCSH headings)
      ├── principal investigators     ├── locations (country → region → city)
      ├── members                     ├── resourceType / genre / language / tags
      └── institutions                └── dre_id (stable id)

Publication (separate bibliography) ── authors/editors reconciled to People
```

See [references/data-model.md](references/data-model.md) for field-level detail, and
[references/tools-by-task.md](references/tools-by-task.md) for the full tool reference.

## Workflow

### 1 — Scope
Call `get_collection_overview` once. It returns counts, breakdowns (items by university / section /
resource type / language), the content date range, and **snapshot freshness** (`data_snapshot`). Note
the distinction it implies: many projects are registry entries; only a subset carry digitised items.

### 2 — Search
Use the right entry point for the question:
- Things/artefacts → `search_research_items` (filters: keyword, **subject**, **location**, contributor,
  project_id, research_section, university, resource_type, genre, language, tag, year range).
- Projects → `search_projects`. Sections → `list_research_sections`. People → `search_persons`.
  Institutions → `list_institutions`. Bibliography → `search_publications`.
- Discover vocabulary first when unsure of exact terms: `list_subjects`, `list_locations`,
  `list_categories` (tags/genres/languages/resource_types) all return values ranked by item count.
  Feed a returned value straight back into the matching `search_research_items` filter.

Keep `limit` modest (10–25) while scoping; paginate with `offset` / `next_offset`.

### 3 — Drill
`get_research_item` (by `dre_id`), `get_project` (by `id`), `get_research_section` (by name),
`get_person` (by name), `get_institution`, `get_publication` return full records.

### 4 — Connect
`find_related` pivots from a subject / location / person / project / tag to the entities that co-occur
with it (related projects, sections, subjects, people, locations, tags, with counts). Use it to trace a
theme across projects or to build a relational picture — the cluster's core analytic.

### 5 — Synthesise with citations
Every record carries a **`dashboard_url`**. Cite each entity you mention as a **markdown link** to that
URL so the reader can open and verify the source page. For publications, also cite the `url` (DOI or
repository permalink) as the primary reference. Never cite a bare id.

## Citation rules (important)

- ALWAYS render `dashboard_url` as a markdown link, e.g.
  `[Volume 8: Yoruba Architecture…](https://amira.africamultiple.uni-bayreuth.de/research-items?id=abg-99-0000)`.
- When listing several results, attach each one's link to the item you mention.
- For a publication, lead with its own `url`/DOI; the `dashboard_url` points to the publications page.
- Do not invent links or ids — only use the URLs the tools return.

## Caveats

1. **Snapshot, not live DB.** Data reflects the last dashboard refresh (`get_collection_overview` →
   `data_snapshot.generated_at`). The server may lag the live site; it contacts no backend database.
2. **Curated, not exhaustive.** Absence of a result is not proof of absence.
3. **Coverage is uneven.** Item counts skew toward a few large collections (e.g. ILAM ≈ South Africa,
   the Liberia broadcasting tapes). Disclose this when comparing universities, places, or themes.
4. **Projects ≠ items.** The project registry is larger than the set of projects with digitised items;
   use `item_count` from `get_project` / `search_projects` to tell them apart.
5. **Name format.** People are `Surname, Forename`. Contributor names on items may not perfectly match
   the people authority list — `get_person` matches across projects, items, and the bibliography anyway.
6. **University label.** A project's university is inferred from its id prefix (UBT_/ULG_/UJKZ_/UFB_),
   matching the dashboard; unprefixed ids fall under "external".
7. **Language codes split.** Languages are ISO 639-2, and some appear under both the bibliographic and
   terminological code (e.g. French = `fre` + `fra`). Pass a language *name* ("French") to
   `search_research_items` `language` to capture all variants at once; `list_categories
   category=languages` lists the codes with human labels.
