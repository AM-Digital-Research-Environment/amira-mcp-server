---
name: africa-multiple
description: |
  Research workflow and context for the Africa Multiple MCP server — the read-only interface to AMIRA,
  the public research-data dashboard built by the Digital Research Environment (DRE) of the Africa
  Multiple Cluster of Excellence (University of Bayreuth).
  Use this skill when:
  - Querying the Africa Multiple MCP server (africa-multiple-mcp-server tools) about the cluster's
    research projects, research sections, digitised research items, people, institutions, groups,
    publications, subjects, or locations
  - Investigating the Africa Multiple Cluster of Excellence, its DRE, or the AMIRA dashboard and its
    digital research collections
  - Exploring how a theme, place, or person connects across projects and collections
  - Building cited research outputs grounded in AMIRA
  It provides a query workflow, tool-selection guidance, citation conventions, and coverage caveats; the
  bundled references add cluster background (references/cluster-context.md), the data model, and the tool
  catalogue.
---

# Africa Multiple Research Data — MCP Workflow

Context and method for working with the **africa-multiple-mcp-server** tools. They expose the research
data of the **Africa Multiple Cluster of Excellence** (University of Bayreuth) as published by **AMIRA**,
the public research-data dashboard at <https://amira.africamultiple.uni-bayreuth.de>. Both AMIRA and this
MCP server are built and maintained by the cluster's **Digital Research Environment (DRE)**.

## What this collection is

The **Africa Multiple Cluster of Excellence** (University of Bayreuth, est. 2019) studies Africa and its
diasporas under the banner **"Reconfiguring African Studies"**. Its three core concepts —
**multiplicity, relationality, reflexivity** — treat phenomena as products of ever-changing
relationships rather than fixed entities; `find_related` is the tool that puts this relational view into
practice. The cluster works through partner research centres in Burkina Faso, Nigeria, Kenya, South
Africa, and Brazil, coordinated from Bayreuth. See
[references/cluster-context.md](references/cluster-context.md) for the fuller picture — mission, the two
funding phases, the research centres, the DRE, and AMIRA.

AMIRA gathers material produced by collaborative projects. In the data, each project's `university` is
one of four id-prefixed partners, plus a bucket for outside collections:

- **UBT** — University of Bayreuth (Germany)
- **ULG** — University of Lagos (Nigeria)
- **UJKZ** — Université Joseph Ki-Zerbo, Ouagadougou (Burkina Faso)
- **UFB** — Federal University of Bahia (Brazil)
- **External** — outside collections, e.g. the International Library of African Music (ILAM, Rhodes
  University, South Africa) and Bayreuth Global / Bayreuth Postkolonial

Work is organised into thematic **research sections**, which were **redefined between the cluster's two
funding phases** — so `list_research_sections` returns *two distinct groups* of sections plus a synthetic
grouping. Don't hardcode the list (read it from the tool), but expect:

- **Phase 1 — AM 1.0 (2019–2025):** Affiliations, Arts & Aesthetics, Knowledges, Learning, Mobilities,
  Moralities. These carry **all** the digitised projects and items in the current snapshot.
- **Phase 2 — AM 2.0 (2026–2032):** Accumulation, Digitalities, Ecologies, In/securities, Re:membering,
  Translating. The structure for the next phase — **seeded but ~0 projects/items so far**, so treat
  empty results from these as expected, not a bug.
- **External:** a synthetic grouping for outside collections (e.g. ILAM, Bayreuth Global).

Each section returned by `list_research_sections` / `get_research_section` carries a **`funding_phase`**
label ("AM 1.0 (2019–2025)" / "AM 2.0 (2026–2032)", `null` for External) and a `date` range, so you can
group or filter the two sets directly. Filter with the exact strings the tool returns (note the
punctuation in "In/securities", "Re:membering").

The data is **read from a snapshot of AMIRA's public JSON** — the server contacts no backend database,
so it works offline and needs no database, key, or credentials.

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

- ALWAYS render an entity's `dashboard_url` as a markdown link, e.g.
  `[Volume 8: Yoruba Architecture…](https://amira.africamultiple.uni-bayreuth.de/research-items?id=aaa-02-0007)`.
- **Never** print a bare id (`aaa-02-0007`) and **never** collapse items into an id range
  (`aaa-02-0007 through aaa-02-0014`). List each referenced item as its own full link — a bulleted list
  of links is the right shape when there are several.
  - ❌ `Photos from fieldwork (aaa-02-0007 through aaa-02-0014).`
  - ✅ `Photos from fieldwork: [aaa-02-0007](…?id=aaa-02-0007), [aaa-02-0008](…?id=aaa-02-0008), …`
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
5. **Name format.** People are stored `Surname, Forename` — always display and cite that form. You may
   query in either order (and without accents): `search_persons`, `get_person` and the `contributor`
   filter resolve "Oliver Baumann" → "Baumann, Oliver". `get_person` echoes the canonical `name` plus the
   `query` you passed, and matches PIs/contributors/authors across projects, items and the bibliography.
6. **University label.** A project's university is inferred from its id prefix (UBT_/ULG_/UJKZ_/UFB_),
   matching the dashboard; unprefixed ids fall under "external".
7. **Language codes split.** Languages are ISO 639-2, and some appear under both the bibliographic and
   terminological code (e.g. French = `fre` + `fra`). Pass a language *name* ("French") to
   `search_research_items` `language` to capture all variants at once; `list_categories
   category=languages` lists the codes with human labels.
