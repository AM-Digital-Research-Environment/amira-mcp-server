import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  errorResult,
  exposureRestrictedResult,
  filtersEcho,
  limitEcho,
  pageOf,
  projectSummary,
  refLabels,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";
import { nameMatchesQuery } from "../names.js";

export function registerProjectTools(server: Server): void {
  // === search_projects ======================================================
  server.registerTool(
    "search_projects",
    {
      title: "Search research projects",
      description:
        "Search the cluster's research projects across AMIRA's partner/source metadata labels plus " +
        "external collections. Every registered project is searchable; `item_count` shows how many carry " +
        "digitised items (a subset do). Filters are optional and AND-combined; omit all to list every " +
        "project. Use get_project for full detail.",
      annotations: annotate("Search projects"),
      inputSchema: z.object({
        keyword: z.string().optional().describe("Matches the project name or description"),
        university: z
          .string()
          .optional()
          .describe("ubt | unilag | ujkz | ufba | external — code or name. A data facet, not a full AMRC list"),
        research_section: z.string().optional().describe("e.g. 'Knowledges', 'Moralities'"),
        principal_investigator: z.string().optional().describe("A PI name; either order works ('Oliver Baumann' finds 'Baumann, Oliver')"),
        member: z.string().optional().describe("A project member's name; either order works"),
        institution: z.string().optional().describe("Funding/affiliated institution name, partial"),
        limit: z.number().int().min(1).optional().describe("Default 25, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "search_projects");
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);

      const filtered = store.projects.filter((p) => {
        if (args.keyword && !(containsCI(p.name, args.keyword) || containsCI(p.description, args.keyword)))
          return false;
        if (args.university) {
          const v = args.university.toLowerCase();
          if (p.university !== v && !containsCI(UNIVERSITY_LABELS[p.university], args.university)) return false;
        }
        if (args.research_section && !p.sections.some((s) => equalsCI(s.label, args.research_section!)))
          return false;
        if (
          args.principal_investigator &&
          !p.pis.some(
            (x) =>
              nameMatchesQuery(x.label, args.principal_investigator!) ||
              containsCI(x.label, args.principal_investigator!),
          )
        )
          return false;
        if (
          args.member &&
          !p.members.some((x) => nameMatchesQuery(x.label, args.member!) || containsCI(x.label, args.member!))
        )
          return false;
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
  server.registerTool(
    "get_project",
    {
      title: "Get project detail",
      description:
        "Full detail for one project by Omeka `id` (preferred; the numeric o:id in `amira_url`). " +
        "Legacy project-key values are still accepted for compatibility. " +
        "Returns name, university, research sections, principal investigators, members, description, " +
        "start/end dates, funding institutions, project website, item_count, a breakdown of its items by " +
        "resource type, its top subjects, and a citable `amira_url`. Returns { error } if the id is unknown.",
      annotations: annotate("Get project detail"),
      inputSchema: z.object({ id: z.union([z.string(), z.number()]).describe("Project Omeka o:id, e.g. 37700") }),
    },
    async ({ id }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_project");
      const p = store.getProject(String(id));
      if (!p) {
        return errorResult("not_found", `No project with id '${id}'.`, { suggested_tool: "search_projects" });
      }
      const items = store.itemsForProject(p.o_id);

      const byType: Record<string, number> = {};
      const subjectCounts = new Map<string, number>();
      for (const it of items) {
        const t = it.type || "Unknown";
        byType[t] = (byType[t] ?? 0) + 1;
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
        university: UNIVERSITY_LABELS[p.university],
        research_sections: refLabels(p.sections),
        principal_investigators: refLabels(p.pis),
        members: refLabels(p.members),
        funded_by: refLabels(p.funded_by),
        description: p.description,
        date: p.date,
        website: p.url,
        item_count: items.length,
        items_by_resource_type: Object.fromEntries(Object.entries(byType).sort((a, b) => b[1] - a[1])),
        top_subjects: topSubjects,
        amira_url: itemUrl(p.o_id),
      });
    },
  );
}
