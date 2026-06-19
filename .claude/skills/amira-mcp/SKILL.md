---
name: amira-mcp
description: |
  Research workflow and context for the AMIRA MCP server (amira-mcp-server) — the read-only interface to
  the Africa Multiple Cluster of Excellence research data, as published on the cluster's public Omeka S
  site (data.africamultiple.uni-bayreuth.de) by its Digital Research Environment (DRE).
  Use this skill when:
  - Querying the AMIRA MCP server tools about the cluster's research projects, research sections,
    digitised research items, people, institutions, groups, publications, subjects, locations,
    podcasts, or YouTube videos/transcripts
  - Investigating the Africa Multiple Cluster of Excellence, its DRE, or the AMIRA collection
  - Exploring how a theme, place, or person connects across projects and collections
  - Building cited research outputs grounded in the AMIRA data
  It provides a query workflow, tool-selection guidance, citation conventions (amira_url), and coverage
  caveats; the bundled references add cluster background (references/cluster-context.md), the data
  model, and the tool catalogue.
---

# Africa Multiple Research Data — MCP Workflow

Context and method for working with the **amira-mcp-server** tools. They expose the research data of
the **Africa Multiple Cluster of Excellence** (University of Bayreuth) as published on the cluster's
public **Omeka S site** at <https://data.africamultiple.uni-bayreuth.de> (the AMIRA collection). Both
the site and this MCP server are built and maintained by the cluster's **Digital Research Environment
(DRE)**.

## What this collection is

The **Africa Multiple Cluster of Excellence** (University of Bayreuth, est. 2019) studies Africa and
its diasporas under the banner **"Reconfiguring African Studies"**. Its three core concepts —
**multiplicity, relationality, reflexivity** — treat phenomena as products of ever-changing
relationships rather than fixed entities; `find_related` is the tool that puts this relational view
into practice. See [references/cluster-context.md](references/cluster-context.md) for the fuller
picture — mission, funding phases, research centres, the DRE.

Each project's `university` is one of four id-prefixed partners, plus a bucket for outside collections:

- **UBT** — University of Bayreuth (Germany)
- **ULG** — University of Lagos (Nigeria)
- **UJKZ** — Université Joseph Ki-Zerbo, Ouagadougou (Burkina Faso)
- **UFB** — Federal University of Bahia (Brazil)
- **External** — outside collections, e.g. the International Library of African Music (ILAM, Rhodes
  University; ~1,000 audio items) and Bayreuth Global / Bayreuth Postkolonial

Work is organised into thematic **research sections**, redefined between the cluster's two funding
phases — so `list_research_sections` returns *two distinct groups* plus a synthetic grouping. Don't
hardcode the list (read it from the tool), but expect:

- **Phase 1 — AM 1.0 (2019–2025):** Affiliations, Arts & Aesthetics, Knowledges, Learning, Mobilities,
  Moralities. These carry **all** the digitised projects and items in the current snapshot.
- **Phase 2 — AM 2.0 (2026–2032):** Accumulation, Digitalities, Ecologies, In/securities,
  Re:membering, Translating — **seeded but ~0 projects/items so far**; empty results from these are
  expected, not a bug.
- **External:** the synthetic grouping for outside collections.

Each section carries a `funding_phase` label and `date` range, so you can group or filter the two sets
directly. Filter with the exact strings the tool returns (note "In/securities", "Re:membering").

Beyond the research items, the collection carries the cluster **bibliography** (~250 publications),
**podcast episodes** (e.g. *Cluster Conversations*), and the cluster's **YouTube videos** — most with
full **transcripts**, making `search_videos keyword=…` the collection's main full-text search over
talks and lectures.

The data is **read from a snapshot of the public Omeka S API**. The server works offline from the
bundled snapshot and needs no key or credentials; when live refresh is enabled, it may probe and
refresh a local cache from the public API. `get_collection_overview` reports which snapshot source is
serving and when it was fetched.

## The entities (and how they connect)

```
ResearchSection ── research projects belong to one or more sections
      │
   Project ──(items)── ResearchItem ──┬── contributors (Person / Institution / Group, with roles)
      │                               ├── subjects (incl. former "tags" — one merged facet)
      ├── principal investigators     ├── places (countries + cities; `location` walks the chain)
      ├── members                     ├── typed dates (created / collected / issued / …)
      └── funding institutions        └── formats / languages / sponsors / related items

Publication (bibliography) ── authors/editors reconciled to People
Podcast / YouTube video ── speakers reconciled to People; videos carry transcripts
```

Every entity is an Omeka item with a stable public page: its **`amira_url`**
(`…/s/amira/item/<id>`). The preferred identifier is the Omeka `id` / `omeka_id`, i.e. the final
number in that URL; use that when an identifier is needed.

See [references/data-model.md](references/data-model.md) for field-level detail, and
[references/tools-by-task.md](references/tools-by-task.md) for the full 24-tool catalogue.

## Workflow

### 1 — Scope
Call `get_collection_overview` once. It returns counts (now incl. podcasts and videos), breakdowns,
the content date range, and **snapshot freshness** (`data_snapshot`). Note the distinction it implies:
many projects are registry entries; only a subset carry digitised items.

### 2 — Search
Use the right entry point for the question:
- Things/artefacts → `search_research_items` (filters: keyword, **subject**, **location** (any level —
  a country OR a city; `location=Nigeria` finds Lagos items too, since the place hierarchy is walked),
  **country** (the country level specifically), contributor, project_id (Omeka id preferred),
  research_section, university,
  resource_type, genre/format, language, year range). When a strict AND combination returns nothing, the envelope adds
  `suggestions` naming which single filter to drop (and how many items that would surface) — relax,
  don't give up.
- Projects → `search_projects`. Sections → `list_research_sections`. People → `search_persons`.
  Institutions → `list_institutions`. Bibliography → `search_publications`.
- Talks and audiovisual: `search_videos` (keyword reaches INTO transcripts; hits are flagged
  `matched_in: "transcript"` with a `transcript_snippet` around the match) and `search_podcasts`.
- Discover vocabulary first when unsure of exact terms: `list_subjects` (tags are merged in),
  `list_locations`, `list_collections` (item sets — pair with the `collection` filter),
  `list_categories` (formats/languages/resource_types), all ranked by item count. Feed a returned
  value straight back into the matching filter. `list_years` gives the date distribution (by year or
  decade) for coverage-over-time and most-covered-year questions. For date ranges, pass `from <= to`
  / `year_from <= year_to`; inverted ranges return a structured `invalid_range` error.

Keep `limit` modest (10–25) while scoping; paginate with `offset` / `next_offset`. Ask for more than
a tool's max and it caps silently but tells you — the envelope echoes `requested_limit` /
`effective_limit`.

### 3 — Drill
`get_research_item` (by Omeka `id` / `omeka_id`) returns the full record — including the **typed dates** and the
place hierarchy. `get_project`, `get_research_section`, `get_person`, `get_institution`,
`get_publication` (with generated BibTeX), `get_podcast`, `get_video` complete the detail layer.
**Transcripts are opt-in:** `get_podcast` / `get_video` omit the transcript by default (you still see
`has_transcript` + `transcript_length`); pass `include_transcript=true` for the text, and
`transcript_offset` / `transcript_max_chars` to page a long one. Profile views return slim item refs —
follow up with `get_research_item`.

### 4 — Connect
`find_related` pivots from a subject / location / person / project to the entities that co-occur with
it (related projects, sections, subjects, people, countries, formats, with counts). Use it to trace a
theme across projects — the cluster's core analytic. Matching is by substring (subject), name in
either order (person), any level of the place hierarchy (location) or id/label (project); the response
echoes the rule in `matching`. `matched_items` counts *items*, so it can legitimately differ from a
`list_subjects` heading count.

### 5 — Synthesise with citations
Every record carries an **`amira_url`**. Cite each entity you mention as a **markdown link** to that
URL whenever possible. For publications, videos, and podcasts, you may also include DOI, repository,
watch, or listen URLs when useful, but they should supplement rather than replace the AMIRA record
link.

## Citation rules (important)

- ALWAYS render an entity's `amira_url` as a markdown link, e.g.
  `[Volume 8: Yoruba Architecture…](https://data.africamultiple.uni-bayreuth.de/s/amira/item/7392)`.
- **Never** print legacy DRE identifiers. If an identifier is explicitly needed, use
  the Omeka `id` / `omeka_id` (the final number in the `amira_url`). Never collapse items into an id
  range. List each referenced item as its own full link — a bulleted list is the right shape when
  there are several.
- For a publication, video, or podcast, include the AMIRA `amira_url` as the main source link; add DOI,
  repository, watch, or listen URLs only as secondary links where they help.
- Do not invent links or ids — only use the URLs the tools return.

## Caveats

1. **Snapshot, not live API.** Data reflects the last crawl (`get_collection_overview` →
   `data_snapshot`). The server may lag the live site.
2. **Curated, not exhaustive.** Absence of a result is not proof of absence.
3. **Coverage is uneven.** Item counts skew toward a few large collections (ILAM ≈ South Africa audio,
   the Liberia broadcasting tapes). Disclose this when comparing universities, places, or themes.
4. **Projects ≠ items.** The registry is larger than the set of projects with digitised items; use
   `item_count` to tell them apart.
5. **Name format.** People are stored `Surname, Forename` — always display and cite that form. Every
   person filter accepts either order (and ignores accents); `get_person` echoes the canonical name.
6. **Subjects absorb tags.** The former dashboard distinguished subjects from free-form tags; the
   collection now stores both as subjects. There is no tag filter — use `subject`.
7. **Languages are canonical records.** One record per language ("French", code `fra`); the server
   accepts names, ISO 639-1/2 codes and the legacy bibliographic codes (`fre`, `ger`) alike.
8. **Podcast transcripts are not filled yet** (0/43 as of 2026-06); video transcripts cover 91/140.
   `has_transcript` on each result tells you; absence of a transcript is not an error. The detail
   tools omit the transcript text unless you pass `include_transcript=true` (see Drill).
9. **Places: flat facet, hierarchy-aware filters.** `list_locations` is a flat, item-count-ranked list
   (countries and cities together, hierarchy rolled up — no level to choose). On
   `search_research_items`, `location` matches a place at ANY level (a country *or* a city —
   `location=Nigeria` includes Lagos items), and `country` narrows to the country level specifically.
10. **Dates carry a `date_status`.** Podcasts and videos label each date `published`, `scheduled`
    (dated in the future — e.g. an episode page posted ahead of release) or `unknown`. Scheduled items
    are returned, not hidden; flag them when a future date would mislead.
11. **Research-item year ranges are content ranges.** `get_research_item.dates` still exposes typed
    rights/admin dates such as `copyrighted`, `available`, `valid`, and `modified`, but derived `date`,
    `year_from`/`year_to` filtering, `list_years`, and `content_date_range` are based on content dates
    such as `created`, `collected`, `issued`, and `date`.
12. **Errors are structured.** A miss or invalid input returns `{ error: { code, message, suggested_tool?,
    available_values? } }` — read `suggested_tool`/`available_values` to recover rather than guessing.
