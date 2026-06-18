import { z } from "zod";
import { ensureStore } from "../data.js";
import {
  annotate,
  capText,
  equalsCI,
  errorResult,
  fundingPhase,
  projectSummary,
  refLabels,
  sectionSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";

export function registerResearchSectionTools(server: Server): void {
  // === list_research_sections ===============================================
  server.registerTool(
    "list_research_sections",
    {
      title: "List research sections",
      description:
        "List the cluster's research sections (its top-level thematic structure). They fall into two " +
        "groups, one per funding phase: AM 1.0 / 2019–2025 (Affiliations, Arts & Aesthetics, Knowledges, " +
        "Learning, Mobilities, Moralities) and AM 2.0 / 2026–2032 (Accumulation, Digitalities, Ecologies, " +
        "In/securities, Re:membering, Translating), plus a synthetic 'External' grouping for outside " +
        "collections. The AM 2.0 sections are newly seeded and currently have ~0 projects/items. Takes no " +
        "arguments. For each section returns name, funding_phase, date, principal_investigators, " +
        "member_count, project_count, item_count, a brief description, the section's website and a " +
        "citable `amira_url`. Use get_research_section for the full description and project list.",
      annotations: annotate("List research sections"),
      inputSchema: {},
    },
    async () => {
      const store = await ensureStore();
      const itemCountBySection = new Map<string, number>();
      for (const it of store.items) {
        for (const s of store.sectionsOfItem(it))
          itemCountBySection.set(s, (itemCountBySection.get(s) ?? 0) + 1);
      }

      const sections = store.sections.map((s) => {
        const projectCount = store.projects.filter((p) =>
          p.sections.some((x) => equalsCI(x.label, s.name)),
        ).length;
        return sectionSummary(s, { projectCount, itemCount: itemCountBySection.get(s.name) ?? 0 });
      });

      return textResult({ count: sections.length, results: sections });
    },
  );

  // === get_research_section =================================================
  server.registerTool(
    "get_research_section",
    {
      title: "Get research section detail",
      description:
        "Full detail for one research section by `name` (case-insensitive, e.g. 'Mobilities'). Returns the " +
        "funding_phase (AM 1.0 / 2019–2025 or AM 2.0 / 2026–2032) and its date range, the full " +
        "description, principal investigators, members, spokesperson, the section's page on the cluster " +
        "website, the projects belonging to it (with item counts), the total item count, and a citable " +
        "`amira_url`. Returns a structured { error } (with the valid names in `available_values`) if the " +
        "name is unknown.",
      annotations: annotate("Get research section detail"),
      inputSchema: { name: z.string().describe("Section name, e.g. 'Arts & Aesthetics'") },
    },
    async ({ name }) => {
      const store = await ensureStore();
      const s = store.getSection(name);
      if (!s) {
        return errorResult("not_found", `No research section named '${name}'.`, {
          suggested_tool: "list_research_sections",
          available_values: store.sections.map((x) => x.name),
        });
      }
      const projects = store.projects.filter((p) => p.sections.some((x) => equalsCI(x.label, s.name)));
      const itemCount = projects.reduce((acc, p) => acc + store.itemsForProject(p.o_id).length, 0);

      return textResult({
        name: s.name,
        funding_phase: fundingPhase(s),
        date: s.date,
        description: s.description ? capText(s.description).text : null,
        principal_investigators: refLabels(s.pis),
        members: refLabels(s.members),
        spokesperson: s.spokesperson,
        website: s.url,
        project_count: projects.length,
        item_count: itemCount,
        projects: projects.map((p) => projectSummary(p, store.itemsForProject(p.o_id).length)),
        amira_url: itemUrl(s.o_id),
      });
    },
  );
}
