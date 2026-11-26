# Research recipes & evidence discipline

Structured multi-step workflows matching the server's five MCP prompts — apply them automatically
whenever a user asks for a literature review, project dossier, researcher profile, place report or
transcript/full-text evidence, even without an explicit slash command.

## Shared method (apply to every recipe)

- **Batch independent tool calls in one turn** (hosts cap tool rounds at ~20, not calls within a
  round); sequence only calls that depend on an earlier id or entity resolution.
- **Open substantial answers with a one-line evidence ledger:** state how many records you read in
  full, how many you cite from search metadata, and which figures come from facets or counts.
- **Cite every mentioned record** with its `amira_url` as a markdown link (one link per record, no
  id ranges, no legacy DRE ids; in curator mode, name private records as private with `admin_url`).
- **State coverage limits** explicitly rather than implying absence from empty results.

## 1. Literature review (`literature_review`)

For *"Survey what AMIRA holds / write a literature review on X [optional years]"*:

1. `get_collection_overview` — record snapshot date and corpus scope.
2. `list_publication_facets` (`facet: "type"`, then `facet: "year"`) with `keyword` (and year range)
   to size the field.
3. `search_publications` with `keyword` (and `subject` if a heading matches; `include_abstract=true`
   helps build reading lists without calling `get_publication` on every hit). Page via `next_offset`;
   prioritise works with `has_fulltext: true`.
4. `get_text_passages` on the most relevant open-access `publication:ID` records to quote verbatim
   evidence.
5. `search_research_items` and `find_related` (`entity_type: "subject"`) for archival holdings and
   connected projects.
6. Group findings by theme and period, name key authors and projects, and note open questions and
   bibliography coverage gaps (post-2019 Bayreuth ERef/EPub harvests).

## 2. Project dossier (`project_dossier`)

For *"Prepare a dossier / profile of research project X"*:

1. `search_projects` with `keyword` (or `get_project` directly if an Omeka id is given).
2. `get_project` — description, PIs, members, research sections, funders, item breakdown, top
   subjects and sample items.
3. In parallel: `list_years` and `list_locations` with `filters: { project_id }`, plus
   `search_research_items` with `project_id` (note `has_media` and media types).
4. `resolve_entity` (`type: "project"`) → `get_entity_graph` for connected people, subjects and
   places.
5. Summarise scope, holdings, periods, geography, coverage gaps (distinguish registry-only projects
   with `item_count: 0`) and links to related projects.

## 3. Researcher profile (`person_profile`)

For *"Profile researcher X / what has X done in AMIRA?"*:

1. `resolve_entity` with `query` and `type: "person"`. **If several candidates match, stop and ask
   which person is meant** — never merge homonyms.
2. `get_person` with the chosen `id` — affiliations, authority identifiers (GND, ORCID, Wikidata),
   project/section roles, credited items, publications, podcasts, videos, Cluster Chronicles works
   and `top_collaborators`.
3. In parallel: `get_entity_graph` with the person's typed id, and `search_publications` with
   `author` (newest first).
4. Summarise research themes, roles (PI, member, contributor, author, editor) and shared credits.
5. **Mandatory ethical & coverage framing:** open with one sentence stating that the profile is
   compiled from AMIRA records and is **not an assessment of the person or their scholarship**. Do
   not rank, rate or judge people. Note that the bibliography harvests works from 2019 onward filed
   under the Cluster in University of Bayreuth repositories (EPub, ERef), so other publications —
   especially from partner AMRCs — are missing. Display names as `Surname, Forename`.

## 4. Place report (`place_report`)

For *"What does AMIRA hold about country/city/region X?"*:

1. `list_locations` with `keyword` — inspect matching place records, `level` (`country` vs `place`),
   ancestor countries and item counts (use `location_id` if homonyms exist).
2. In parallel: `search_research_items` (`location` or `country` / `location_id`, noting `has_media`),
   `find_related` (`entity_type: "location"`), and `list_years` (`filters: { location }`).
3. Summarise holdings by project, resource type, language and time span, noting hierarchy rollups
   (city items also count under their country) and collection skew.

## 5. Transcript & full-text evidence (`transcript_evidence`)

For *"Where is X discussed / find quotes about X across talks, publications and chronicles?"*:

1. In parallel: `search_podcasts`, `search_videos`, `search_publications` and `search_chronicles`
   with `keyword` — keep hits matched in `transcript`, `fulltext` or `text`.
2. `get_text_passages` with up to ten of their typed ids (`podcast:`, `video:`, `publication:`,
   `chronicle:`) and the literal phrase; paginate via `next_offset`.
3. Quote short passages with their UTF-16 offsets, naming the speaker or author and date.
4. Call `get_podcast` / `get_video` where needed to report `transcript_generated_by` (machine-generated
   transcripts should be flagged as such and verified against audio for critical quotations).
