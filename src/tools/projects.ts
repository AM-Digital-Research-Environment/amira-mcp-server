import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  itemSubjects,
  paginate,
  projectSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { projectUrl } from "../urls.js";

export function registerProjectTools(server: Server): void {
  // === search_projects ======================================================
  server.registerTool(
    "search_projects",
    {
      title: "Search research projects",
      description:
        "Search the cluster's research projects across the four partner universities plus external " +
        "collections. Every registered project is searchable; `item_count` shows how many have digitised " +
        "items (a subset do). All filters optional and AND-combined; omit all to list every project.\n\n" +
        "Filters:\n" +
        "  - keyword: match project name or description\n" +
        "  - university: ubt | unilag | ujkz | ufba | external (code or name)\n" +
        "  - research_section: e.g. 'Knowledges', 'Moralities'\n" +
        "  - principal_investigator: PI name (partial)\n" +
        "  - member: team-member name (partial)\n" +
        "  - institution: affiliated institution name (partial)\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Returns a paginated envelope; each result has id, name, university, research_sections, " +
        "principal_investigators, item_count and a `dashboard_url`. Use get_project for full detail.",
      annotations: annotate("Search projects"),
      inputSchema: {
        keyword: z.string().optional(),
        university: z.string().optional(),
        research_section: z.string().optional(),
        principal_investigator: z.string().optional(),
        member: z.string().optional(),
        institution: z.string().optional(),
        limit: z.number().int().optional().describe("Default 25, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);

      const filtered = store.projects.filter((p) => {
        if (args.keyword && !(containsCI(p.name, args.keyword) || containsCI(p.description, args.keyword)))
          return false;
        if (args.university) {
          const v = args.university.toLowerCase();
          if (p.university !== v && !containsCI(UNIVERSITY_LABELS[p.university], args.university)) return false;
        }
        if (args.research_section && !(p.researchSection ?? []).some((s) => equalsCI(s, args.research_section!)))
          return false;
        if (args.principal_investigator && !anyContainsCI(p.pi, args.principal_investigator)) return false;
        if (args.member && !anyContainsCI(p.members ?? [], args.member)) return false;
        if (args.institution && !anyContainsCI(p.institutions, args.institution)) return false;
        return true;
      });

      const results = filtered.map((p) => projectSummary(p, store.itemsForProject(p.id).length));
      return textResult(
        paginate(results, offset, limit, {
          filters: {
            keyword: args.keyword ?? null,
            university: args.university ?? null,
            research_section: args.research_section ?? null,
            principal_investigator: args.principal_investigator ?? null,
            member: args.member ?? null,
            institution: args.institution ?? null,
          },
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
        "Full detail for one project by `id` (e.g. 'UBT_ArtWorld2019', 'ULG_WOPP2021', 'Ext_ILAM'). " +
        "Returns name, university, research sections, principal investigators, members, emails, " +
        "description, start/end dates, affiliated institutions, item_count, a breakdown of its items by " +
        "resource type, its top subjects, and a citable `dashboard_url`. Returns { error } if id unknown.",
      annotations: annotate("Get project detail"),
      inputSchema: { id: z.string().describe("Project id, e.g. 'UBT_ArtWorld2019'") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      const p = store.getProject(id);
      if (!p) {
        return textResult({
          error: `No project with id '${id}'. Use search_projects to find valid ids.`,
        });
      }
      const items = store.itemsForProject(id);

      const byType: Record<string, number> = {};
      const subjectCounts = new Map<string, number>();
      for (const it of items) {
        const t = it.typeOfResource || "Unknown";
        byType[t] = (byType[t] ?? 0) + 1;
        for (const s of itemSubjects(it)) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
      }
      const topSubjects = [...subjectCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([subject, count]) => ({ subject, item_count: count }));

      return textResult({
        id: p.id,
        name: p.name,
        university: UNIVERSITY_LABELS[p.university],
        research_sections: p.researchSection ?? [],
        principal_investigators: p.pi ?? [],
        members: p.members ?? [],
        emails: p.emails ?? [],
        description: p.description ?? null,
        date: p.date ?? null,
        institutions: p.institutions ?? [],
        item_count: items.length,
        items_by_resource_type: Object.fromEntries(
          Object.entries(byType).sort((a, b) => b[1] - a[1]),
        ),
        top_subjects: topSubjects,
        dashboard_url: projectUrl(p.id),
      });
    },
  );
}
