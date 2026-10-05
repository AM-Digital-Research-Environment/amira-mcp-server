import { z } from "zod";
import { ensureStore } from "../data.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
  capText,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  fundingPhase,
  projectSummary,
  refLabels,
  sectionSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";
import { SECTIONS_UI_META } from "./apps.js";

export function registerResearchSectionTools(server: Server): void {
  // === list_research_sections ===============================================
  server.registerTool(
    "list_research_sections",
    {
      title: "List research sections",
      // Renders as a funding-phase Gantt in MCP Apps hosts; plain JSON elsewhere.
      _meta: SECTIONS_UI_META,
      description: "Cluster research sections, funding phases, project/item counts and citation links. Includes the external-collection grouping.",
      annotations: annotate("List research sections"),
      inputSchema: z.strictObject({}),
    },
    async () => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_research_sections");
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
      description: "One research section's description, team and associated projects and research items.",
      annotations: annotate("Get research section detail"),
      inputSchema: z.strictObject({ name: z.string().describe("Section name, e.g. 'Arts & Aesthetics'") }),
    },
    async ({ name }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_research_section");
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
