import { z } from "zod";
import { ensureStore } from "../data.js";
import type { DataStore } from "../data.js";
import type { OrganisationRec } from "../types.js";
import {
  annotate,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  errorResult,
  filtersEcho,
  itemRef,
  limitEcho,
  pageOf,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrl } from "../urls.js";

function projectCountFor(store: DataStore, org: OrganisationRec): number {
  return store.projects.filter((p) =>
    p.funded_by.some((f) => f.o_id === org.o_id || equalsCI(f.label, org.name)),
  ).length;
}

function contributedItems(store: DataStore, org: OrganisationRec) {
  return store.items.filter((it) =>
    it.contributors.some((c) => c.o_id === org.o_id || equalsCI(c.name, org.name)),
  );
}

export function registerOrganizationTools(server: Server): void {
  // === list_institutions ====================================================
  server.registerTool(
    "list_institutions",
    {
      title: "List institutions",
      description:
        "List institutions in the authority list. Optional `keyword` filters by name; `limit` (default 50, " +
        "max 200) and `offset` paginate. Each result has name, project_count (projects it funds/hosts), " +
        "coordinates when reconciled, and a citable `amira_url`. Use get_institution for the affiliated " +
        "projects and contributed items. Research groups are a separate list — see list_groups.",
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
      const filtered = store.organisations.filter(
        (o) => o.kind === "institution" && (!args.keyword || containsCI(o.name, args.keyword)),
      );
      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (o) => ({
            name: o.name,
            project_count: projectCountFor(store, o),
            ...(o.latitude != null ? { latitude: o.latitude, longitude: o.longitude } : {}),
            amira_url: itemUrl(o.o_id),
          }),
          { ...limitEcho(args.limit, 200, limit), ...filtersEcho(args) },
        ),
      );
    },
  );

  // === get_institution ======================================================
  server.registerTool(
    "get_institution",
    {
      title: "Get institution detail",
      description:
        "Detail for one institution (or group) by `name` (case-insensitive). Returns the projects it " +
        "funds/hosts, the research items crediting it (slim refs, capped at 50, total reported), people " +
        "affiliated with it, coordinates when known, and a citable `amira_url`. Returns { error } if the " +
        "name is not in the organisation authority list.",
      annotations: annotate("Get institution detail"),
      inputSchema: { name: z.string().describe("Institution name") },
    },
    async ({ name }) => {
      const store = await ensureStore();
      const record = store.getOrganisation(name);
      if (!record) {
        return errorResult("not_found", `No institution or group matching '${name}'.`, {
          suggested_tool: "list_institutions",
        });
      }
      const projects = store.projects.filter((p) =>
        p.funded_by.some((f) => f.o_id === record.o_id || equalsCI(f.label, record.name)),
      );
      const items = contributedItems(store, record);
      const people = store.persons.filter((p) =>
        p.affiliations.some((a) => a.o_id === record.o_id || equalsCI(a.label, record.name)),
      );

      return textResult({
        name: record.name,
        kind: record.kind,
        ...(record.latitude != null ? { latitude: record.latitude, longitude: record.longitude } : {}),
        wikidata: record.wikidata,
        project_count: projects.length,
        projects: projects.map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, name: p.name })),
        affiliated_person_count: people.length,
        affiliated_persons: people.slice(0, 50).map((p) => p.name),
        affiliated_persons_truncated: people.length > 50 || undefined,
        contributed_item_count: items.length,
        contributed_items: items.slice(0, 50).map(itemRef),
        contributed_items_truncated: items.length > 50 || undefined,
        amira_url: itemUrl(record.o_id),
      });
    },
  );

  // === list_groups ==========================================================
  server.registerTool(
    "list_groups",
    {
      title: "List groups",
      description:
        "List research groups (organisation authority records typed 'Group'). Optional `keyword` filters " +
        "by name; `limit` (default 50, max 200) and `offset` paginate. Each result has name, " +
        "contributed_item_count (items crediting the group) and a citable `amira_url`. Use " +
        "get_institution with the group's name for its items.",
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
      const filtered = store.organisations.filter(
        (o) => o.kind === "group" && (!args.keyword || containsCI(o.name, args.keyword)),
      );
      return textResult(
        pageOf(
          filtered,
          offset,
          limit,
          (g) => ({
            name: g.name,
            contributed_item_count: contributedItems(store, g).length,
            amira_url: itemUrl(g.o_id),
          }),
          { ...limitEcho(args.limit, 200, limit), ...filtersEcho(args) },
        ),
      );
    },
  );
}
