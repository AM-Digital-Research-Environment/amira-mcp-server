# Africa Multiple — cluster context

Background for framing answers and for "what is Africa Multiple / the DRE / AMIRA?" questions. None of
this is needed to *run* the tools — for the data shape see [data-model.md](data-model.md) and for the
tool catalogue [tools-by-task.md](tools-by-task.md). For anything quantitative (counts, content date
range, snapshot freshness), call `get_collection_overview` rather than quoting figures from here.

## The cluster

The **Africa Multiple Cluster of Excellence** is based at the **University of Bayreuth** (Germany) and
was established in **January 2019** through the Excellence Strategy of the German federal and state
governments (DFG-funded). It builds on roughly fifty years of African Studies at Bayreuth and now hosts
100+ scholars from three continents. Its programmatic subtitle, **"Reconfiguring African Studies"**,
signals its aim: to address power imbalances in how knowledge about Africa is produced, through new
inter- and transdisciplinary forms of collaborative research and theory-building.

Two seven-year funding phases:

- **AM 1.0 (2019–2025)** — built the collaboration between the research centres and the shared
  infrastructure. Most digitised material in AMIRA comes from this phase.
- **AM 2.0 (2026–2032), "Worldmaking from the Vantage Point of Africa"** — research on the multiple,
  relational, and reflexive **making and unmaking of world(s)**, approaching Africa not as a world apart
  but as part of a globally entangled world (after Achille Mbembe's "from the vantage point of Africa").

## Three core concepts

These are the cluster's analytic vocabulary; expect them in project and section descriptions.

- **Multiplicity** — goes beyond diversity/plurality by focusing on the *relationships* that produce
  entities, not the discrete entities themselves. Knowledge, researchers, and fields of study are all
  "relata": temporary products of relationships, and thus always multiple.
- **Relationality** — phenomena form in and through past, present, and future relationships, and the
  multiple (life-)worlds emerging from them — including worlds unmade or silenced.
- **Reflexivity** — researchers reflect on their own positionalities and the power relations behind
  them; the basis for a relational research ethics.

`find_related` is the tool that puts this relational analytic into practice, pivoting from a seed entity
to everything that co-occurs with it across the collection.

## Partner research centres

The cluster operates as a network of African Cluster Centres (ACCs) / Africa Multiple Research Centres
(AMRCs), coordinated from Bayreuth:

- **University of Bayreuth** (Germany) — coordinating centre
- **Université Joseph Ki-Zerbo**, Ouagadougou (Burkina Faso)
- **University of Lagos** (Nigeria)
- **Moi University**, Eldoret (Kenya)
- **Rhodes University**, Makhanda (South Africa) — hosts the International Library of African Music (ILAM)
- **Centro de Estudos Afro-Orientais (CEAO)**, Federal University of Bahia (Brazil)

In AMIRA's data, projects are grouped under four id prefixes — **UBT** (Bayreuth), **ULG** (Lagos),
**UJKZ** (Ouagadougou), **UFB** (Bahia) — plus an **External** bucket for outside collections (e.g. ILAM
at Rhodes, Bayreuth Global / Bayreuth Postkolonial). Kenya's Moi centre has no projects in the current
snapshot, and Rhodes material surfaces via the External ILAM collection rather than its own prefix — so
don't read the data's university split as the full institutional map of the cluster.

## Research sections

Projects are organised into thematic **Research Sections**, and these were **redefined between the two
funding phases** — so the cluster has *two different sets* of sections, each dated to its phase. AMIRA's
section list carries both:

- **AM 1.0 (2019–2025):** Affiliations · Arts & Aesthetics · Knowledges · Learning · Mobilities ·
  Moralities — **all** current projects and items sit here.
- **AM 2.0 (2026–2032):** Accumulation · Digitalities · Ecologies · In/securities · Re:membering ·
  Translating — the new-phase structure; **seeded but not yet populated** in the current snapshot
  (≈0 projects/items), so expect empty results from these for now.
- plus a synthetic **External** grouping for outside collections (e.g. ILAM, Bayreuth Global).

Always read the live list with `list_research_sections`, and filter with the exact strings it returns
(note the punctuation in "In/securities" and "Re:membering").

## The DRE and AMIRA

All cluster members are connected through the **Digital Research Environment (DRE)** — the cluster's
shared digital infrastructure and the team that builds it. The DRE integrates highly heterogeneous
analogue and digital, qualitative and quantitative data into a common research platform, with the
long-term aim of developing fluid IT ontologies.

**AMIRA** (<https://amira.africamultiple.uni-bayreuth.de>) is the DRE's public-facing research-data
dashboard, where the cluster's projects, digitised collections, people, and bibliography are published.
This MCP server is itself a DRE project: it reads AMIRA's openly published JSON snapshot and re-exposes
it as read-only tools, so every result can be cited back to its page on AMIRA.

## Other cluster bodies (context, not entities in the data)

You may see these named in project descriptions or publications:

- **Knowledge Lab** — the cluster's intellectual core, where theoretical and methodological issues are
  debated and synergies sparked.
- **Bayreuth Academy of Advanced African Studies** — fellowship scheme (junior and senior) and host of
  independent junior research groups.
- **BIGSAS** (Bayreuth International Graduate School of African Studies, est. 2007) — doctoral training;
  a large network of fellows and alumni.
- **Iwalewahaus** (est. 1981) — centre for engagement with African arts: exhibitions, documentation, and
  transdisciplinary work with artists.
- **Gender & Diversity Office (GDO)** — equal opportunity, intersectionality, and Critical Diversity
  Literacy.
