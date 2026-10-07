import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { ensureStore } from "../data.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  capText,
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
import { stripTypedId } from "../typedIds.js";

export function registerResearchSectionTools(server: Server, tools: ToolMap): void {
  // === list_research_sections ===============================================
  tools.list_research_sections = server.registerTool(
    "list_research_sections",
    {
      title: "List research sections",
      // Renders as a funding-phase Gantt in MCP Apps hosts; plain JSON elsewhere.
      _meta: SECTIONS_UI_META,
      description: "Cluster research sections, funding phases, project/item counts and citation links. Includes the external-collection grouping.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({}),
    },
    async () => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_research_sections");
      const sections = store.sections.map((s) => {
        // Projects link to sections by id; counting by label orphaned a project
        // whenever a section was renamed.
        const projects = store.projectsOfSection(s);
        const itemCount = projects.reduce((n, p) => n + store.itemsForProject(p.o_id).length, 0);
        return sectionSummary(s, { projectCount: projects.length, itemCount });
      });
      return textResult({ count: sections.length, results: sections });
    },
  );

  // === get_research_section =================================================
  tools.get_research_section = server.registerTool(
    "get_research_section",
    {
      title: "Get research section detail",
      description: "One research section's description, team and projects, each with its research-item count.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        name: z.string().max(1000).optional().describe("Section name, e.g. 'Arts & Aesthetics'"),
        id: z.union([z.string().max(64), z.number()]).optional().describe("Section Omeka id or typed id section:218"),
      }),
    },
    async ({ name, id }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_research_section");
      if (id == null && !name) return errorResult("missing_entity", "Provide name or id.");
      const s = id != null ? store.getSectionByOId(Number(stripTypedId(String(id), ["section"]))) : store.getSection(name!);
      if (!s) {
        return errorResult("not_found", `No research section ${id != null ? `with id '${id}'` : `named '${name}'`}.`, {
          suggested_tool: "list_research_sections",
          available_values: store.sections.map((x) => x.name),
        });
      }
      const projects = store.projectsOfSection(s);
      const itemCount = projects.reduce((acc, p) => acc + store.itemsForProject(p.o_id).length, 0);

      return textResult({
        id: String(s.o_id),
        omeka_id: s.o_id,
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
