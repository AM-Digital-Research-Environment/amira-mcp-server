import { z } from "zod";
import { ensureStore } from "../data.js";
import {
  annotate,
  capText,
  equalsCI,
  projectSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { researchSectionUrl } from "../urls.js";

function brief(text: string | undefined, n = 280): string | null {
  if (!text) return null;
  return text.length <= n ? text : `${text.slice(0, n).trimEnd()}…`;
}

export function registerResearchSectionTools(server: Server): void {
  // === list_research_sections ===============================================
  server.registerTool(
    "list_research_sections",
    {
      title: "List research sections",
      description:
        "List the cluster's research sections (its top-level thematic structure — e.g. 'Affiliations', " +
        "'Arts & Aesthetics', 'Knowledges', 'Learning', 'Mobilities', 'Moralities', plus newer thematic " +
        "sections and the synthetic 'External' grouping). Takes no arguments. For each section returns " +
        "name, principal_investigators, member_count, project_count, item_count, a brief description and a " +
        "`dashboard_url`. Use get_research_section for the full description, objectives and project list.",
      annotations: annotate("List research sections"),
      inputSchema: {},
    },
    async () => {
      const store = await ensureStore();
      const sectionByProject = new Map(store.projects.map((p) => [p.id, p.researchSection ?? []]));
      const itemCountBySection = new Map<string, number>();
      for (const it of store.items) {
        for (const s of sectionByProject.get(it.project?.id) ?? [])
          itemCountBySection.set(s, (itemCountBySection.get(s) ?? 0) + 1);
      }

      const sections = store.researchSections.map((s) => {
        const projectCount = store.projects.filter((p) =>
          (p.researchSection ?? []).some((x) => equalsCI(x, s.name)),
        ).length;
        return {
          name: s.name,
          principal_investigators: s.pi ?? [],
          member_count: (s.members ?? []).length,
          project_count: projectCount,
          item_count: itemCountBySection.get(s.name) ?? 0,
          description: brief(s.description),
          dashboard_url: researchSectionUrl(s.name),
        };
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
        "description, objectives, work programme, principal investigators, members, spokesperson, the list " +
        "of projects belonging to the section (with their item counts), the total item count, and a citable " +
        "`dashboard_url`. Returns { error, available_sections } if the name is unknown.",
      annotations: annotate("Get research section detail"),
      inputSchema: { name: z.string().describe("Section name, e.g. 'Arts & Aesthetics'") },
    },
    async ({ name }) => {
      const store = await ensureStore();
      const s = store.getSection(name);
      if (!s) {
        return textResult({
          error: `No research section named '${name}'.`,
          available_sections: store.researchSections.map((x) => x.name),
        });
      }
      const projects = store.projects.filter((p) =>
        (p.researchSection ?? []).some((x) => equalsCI(x, s.name)),
      );
      const itemCount = projects.reduce((acc, p) => acc + store.itemsForProject(p.id).length, 0);

      return textResult({
        name: s.name,
        description: s.description ? capText(s.description).text : null,
        objectives: s.objectives ? capText(s.objectives).text : null,
        work_programme: s.workProgramme ? capText(s.workProgramme).text : null,
        principal_investigators: s.pi ?? [],
        members: s.members ?? [],
        spokesperson: s.spokesperson ?? null,
        project_count: projects.length,
        item_count: itemCount,
        projects: projects.map((p) => projectSummary(p, store.itemsForProject(p.id).length)),
        dashboard_url: researchSectionUrl(s.name),
      });
    },
  );
}
