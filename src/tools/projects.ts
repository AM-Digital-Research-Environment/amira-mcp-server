import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  itemRef,
  limitEcho,
  pageOf,
  projectSummary,
  refLabels,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";
import { personMatches } from "../names.js";
import { matchesUniversity } from "../researchItemQuery.js";
import { stripTypedId } from "../typedIds.js";
import { fold } from "../text.js";

export function registerProjectTools(server: Server, tools: ToolMap): void {
  // === search_projects ======================================================
  tools.search_projects = server.registerTool(
    "search_projects",
    {
      title: "Search research projects",
      description: "Search project names, descriptions and membership. Returns cited summaries and item counts; use get_project for detail.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Matches the project name, an acronym or the description"),
        university: z
          .string().max(1000)
          .optional()
          .describe("ubt | unilag | ujkz | ufba | external — code or name. A data facet, not a full AMRC list"),
        research_section: z.string().max(1000).optional().describe("Name or id, e.g. 'Knowledges'"),
        principal_investigator: z.string().max(1000).optional().describe("A PI name; either order works ('Oliver Baumann' finds 'Baumann, Oliver')"),
        member: z.string().max(1000).optional().describe("A project member's name; either order works"),
        institution: z.string().max(1000).optional().describe("Funding/affiliated institution name, partial"),
        limit: z.number().int().min(1).optional().describe("Default 25, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "search_projects");
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);
      // A section by name or id; projects link to it by id (their label may be stale).
      const section = args.research_section
        ? store.getSection(args.research_section) ?? store.getSectionByOId(Number(stripTypedId(args.research_section, ["section"])))
        : undefined;

      const filtered = store.projects.filter((p) => {
        if (args.keyword && !(containsCI(p.name, args.keyword) || containsCI(p.description, args.keyword) ||
          anyContainsCI(p.alt_names, args.keyword)))
          return false;
        if (args.university && !matchesUniversity(p.university, args.university)) return false;
        if (args.research_section && !(section
          ? p.sections.some((s) => s.o_id != null ? s.o_id === section.o_id : fold(s.label) === fold(section.name))
          : p.sections.some((s) => equalsCI(s.label, args.research_section!))))
          return false;
        if (args.principal_investigator && !p.pis.some((x) => personMatches(x.label, args.principal_investigator!)))
          return false;
        if (args.member && !p.members.some((x) => personMatches(x.label, args.member!))) return false;
        if (args.institution && !anyContainsCI(refLabels(p.funded_by), args.institution)) return false;
        return true;
      });

      return textResult(
        pageOf(filtered, offset, limit, (p) => projectSummary(p, store.itemsForProject(p.o_id).length), {
          ...limitEcho(args.limit, 100, limit),
          ...filtersEcho(args),
        }),
      );
    },
  );

  // === get_project ==========================================================
  tools.get_project = server.registerTool(
    "get_project",
    {
      title: "Get project detail",
      description: "Project description, team, sections, funders, item counts by type, top subjects and ten sample research items, with citation links.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({ id: z.union([z.string().max(256), z.number()]).describe("Project Omeka id (e.g. 37700) or typed id project:37700") }),
    },
    async ({ id }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_project");
      const p = store.getProject(stripTypedId(String(id), ["project"]));
      if (!p) {
        return errorResult("not_found", `No project with id '${id}'.`, { suggested_tool: "search_projects" });
      }
      const items = store.itemsForProject(p.o_id);

      const byType: Record<string, number> = {};
      const subjectCounts = new Map<string, number>();
      let withMedia = 0;
      for (const it of items) {
        const t = it.type || "Unknown";
        byType[t] = (byType[t] ?? 0) + 1;
        if (it.has_media) withMedia++;
        for (const s of it.subjects) subjectCounts.set(s.label, (subjectCounts.get(s.label) ?? 0) + 1);
      }
      const topSubjects = [...subjectCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([subject, count]) => ({ subject, item_count: count }));

      return textResult({
        id: String(p.o_id),
        omeka_id: p.o_id,
        name: p.name,
        ...(p.alt_names?.length ? { name_variants: p.alt_names } : {}),
        university: UNIVERSITY_LABELS[p.university],
        research_sections: refLabels(p.sections),
        principal_investigators: refLabels(p.pis),
        members: refLabels(p.members),
        funded_by: refLabels(p.funded_by),
        description: p.description,
        date: p.date,
        website: p.url,
        item_count: items.length,
        items_with_media: withMedia,
        items_by_resource_type: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
        top_subjects: topSubjects,
        sample_items: items.slice(0, 10).map(itemRef),
        amira_url: itemUrl(p.o_id),
      });
    },
  );
}
