import { z } from "zod";
import { ensureStore } from "../data.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  institutionSummary,
  itemSummary,
  paginate,
  textResult,
  type Server,
} from "./_shared.js";
import { groupUrl, institutionUrl } from "../urls.js";

export function registerOrganizationTools(server: Server): void {
  // === list_institutions ====================================================
  server.registerTool(
    "list_institutions",
    {
      title: "List institutions",
      description:
        "List institutions in the collection. Optional `keyword` filters by name; `limit` (default 50, " +
        "max 200) and `offset` paginate. Each result has name, project_count (projects affiliated with it) " +
        "and a `dashboard_url`. Use get_institution for the affiliated projects and contributed items.",
      annotations: annotate("List institutions"),
      inputSchema: {
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 200"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 50, 200);
      const offset = capOffset(args.offset);
      const filtered = store.institutions.filter((i) => !args.keyword || containsCI(i.name, args.keyword));
      const results = filtered.map((i) => ({
        name: i.name,
        project_count: store.projects.filter((p) => anyContainsCI(p.institutions, i.name)).length,
        dashboard_url: institutionUrl(i.name),
      }));
      return textResult(paginate(results, offset, limit, { filters: { keyword: args.keyword ?? null } }));
    },
  );

  // === get_institution ======================================================
  server.registerTool(
    "get_institution",
    {
      title: "Get institution detail",
      description:
        "Detail for one institution by `name` (case-insensitive). Returns the projects affiliated with it, " +
        "the research items whose contributors are affiliated with it (capped at 50, total reported), and a " +
        "citable `dashboard_url`. Returns { error } if the name is not found in the institution list.",
      annotations: annotate("Get institution detail"),
      inputSchema: { name: z.string().describe("Institution name") },
    },
    async ({ name }) => {
      const store = await ensureStore();
      const record = store.getInstitution(name);
      const projects = store.projects.filter((p) => anyContainsCI(p.institutions, name));
      const items = store.items.filter((it) => (it.name ?? []).some((n) => anyContainsCI(n.affl, name)));

      if (!record && projects.length === 0 && items.length === 0) {
        return textResult({ error: `No institution matching '${name}'.` });
      }
      return textResult({
        name: record?.name ?? name,
        in_authority_list: !!record,
        project_count: projects.length,
        projects: projects.map((p) => ({ id: p.id, name: p.name })),
        contributed_item_count: items.length,
        contributed_items: items.slice(0, 50).map(itemSummary),
        dashboard_url: institutionUrl(record?.name ?? name),
      });
    },
  );

  // === list_groups ==========================================================
  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "List research groups. Optional `keyword` filters by name; `limit` (default 50, max 200) and " +
        "`offset` paginate. Each result has name, contributed_item_count (items crediting the group) and a " +
        "`dashboard_url`.",
      annotations: annotate("List groups"),
      inputSchema: {
        keyword: z.string().optional(),
        limit: z.number().int().optional().describe("Default 50, max 200"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 50, 200);
      const offset = capOffset(args.offset);
      const filtered = store.groups.filter((g) => !args.keyword || containsCI(g.name, args.keyword));
      const results = filtered.map((g) => ({
        name: g.name,
        contributed_item_count: store.items.filter((it) =>
          (it.name ?? []).some((n) => n.name?.qualifier === "group" && equalsCI(n.name?.label, g.name)),
        ).length,
        dashboard_url: groupUrl(g.name),
      }));
      return textResult(paginate(results, offset, limit, { filters: { keyword: args.keyword ?? null } }));
    },
  );
}
