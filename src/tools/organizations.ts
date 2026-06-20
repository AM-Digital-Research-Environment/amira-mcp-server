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

type PartnerCategoryKey = "amrc" | "privileged" | "cooperation" | "global";

interface PartnerCategory {
  key: PartnerCategoryKey;
  name: string;
  o_id: number;
  description: string;
}

const PARTNER_CATEGORIES: PartnerCategory[] = [
  {
    key: "amrc",
    name: "Africa Multiple Research Centres",
    o_id: 37685,
    description:
      "AMRC/coordinating host institutions represented in Omeka's partner-category authority.",
  },
  {
    key: "privileged",
    name: "Privileged partner",
    o_id: 39073,
    description: "Privileged partner institution; Bahia/CEAO belongs here, not under AMRCs.",
  },
  {
    key: "cooperation",
    name: "Cooperation partners",
    o_id: 39072,
    description: "Africa Multiple cooperation partners.",
  },
  {
    key: "global",
    name: "Global partner Centres of African Studies",
    o_id: 39071,
    description: "Global partner centres of African Studies.",
  },
];

const PARTNER_CATEGORY_NAMES: Record<PartnerCategoryKey, string[]> = {
  amrc: [
    "University of Bayreuth",
    "Université Joseph Ki-Zerbo",
    "Moi University",
    "Rhodes University",
    "University of Lagos",
  ],
  privileged: ["Center for Afro-Oriental Studies"],
  cooperation: [
    "Les Afriques dans le monde",
    "Council for the Development of Social Science Research in Africa",
    "Université d’Abomey Calavi",
    "University of Dar es Salaam",
    "Mohammed V University of Rabat",
    "University of Sousse",
    "Eduardo Mondlane University",
    "Institute of African Studies, Hankuk University of Foreign Studies",
    "Centre for African Studies, Jawaharlal Nehru University",
    "Point Sud — Centre for Research on Local Knowledge",
    "Merian Institute for Advanced Studies in Africa",
  ],
  global: [
    "Université de Montréal",
    "University of Toronto",
    "African Studies Program, Indiana University Bloomington",
    "Universidad de Oriente (Santiago de Cuba)",
    "Universidad de Costa Rica",
    "Universidad de Cartagena",
    "Center for African Area Studies, Kyoto University",
    "Curtin University",
    "African Institute in Indigenous Knowledge Systems, University of KwaZulu-Natal",
  ],
};

function resolvePartnerCategory(input: string | undefined): PartnerCategory | null {
  if (!input) return null;
  const q = input.trim().toLowerCase();
  return (
    PARTNER_CATEGORIES.find(
      (c) => c.key === q || c.name.toLowerCase() === q || c.name.toLowerCase().includes(q),
    ) ?? null
  );
}

function partnerCategoriesFor(org: OrganisationRec): PartnerCategory[] {
  if (org.kind !== "institution") return [];
  const parentRefs = org.part_of ?? [];
  const fromRefs = PARTNER_CATEGORIES.filter((c) =>
    parentRefs.some((p) => p.o_id === c.o_id || equalsCI(p.label, c.name)),
  );
  if (fromRefs.length > 0) return fromRefs;

  // Older bundled snapshots did not preserve organisation dcterms:isPartOf.
  // Keep the tool useful offline by mirroring MongoDB2OmekaS CLUSTER_PARTNER_GROUPS.
  return PARTNER_CATEGORIES.filter((c) => PARTNER_CATEGORY_NAMES[c.key].some((name) => equalsCI(org.name, name)));
}

function partnerSummary(org: OrganisationRec): Record<string, unknown> {
  return {
    id: String(org.o_id),
    omeka_id: org.o_id,
    name: org.name,
    ...(org.latitude != null ? { latitude: org.latitude, longitude: org.longitude } : {}),
    wikidata: org.wikidata,
    amira_url: itemUrl(org.o_id),
  };
}

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
            ...(partnerCategoriesFor(o).length > 0
              ? { partner_categories: partnerCategoriesFor(o).map((c) => c.name) }
              : {}),
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
        part_of: (record.part_of ?? []).map((p) => ({
          id: p.o_id != null ? String(p.o_id) : null,
          omeka_id: p.o_id,
          name: p.label,
          amira_url: p.o_id != null ? itemUrl(p.o_id) : null,
        })),
        partner_categories: partnerCategoriesFor(record).map((c) => ({
          key: c.key,
          name: c.name,
          omeka_id: c.o_id,
          amira_url: itemUrl(c.o_id),
        })),
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

  // === list_cluster_partners ===============================================
  server.registerTool(
    "list_cluster_partners",
    {
      title: "List cluster partner institutions",
      description:
        "List Africa Multiple partner institutions by Omeka partner-category authority: Africa Multiple " +
        "Research Centres, Privileged partner, Cooperation partners, and Global partner Centres of " +
        "African Studies. Optional `category` accepts amrc, privileged, cooperation, global, or a " +
        "category label. Results include institution coordinates, Wikidata URI, category authority " +
        "Omeka ids, and citable `amira_url` links.",
      annotations: annotate("List cluster partners"),
      inputSchema: {
        category: z
          .string()
          .optional()
          .describe("Optional: amrc | privileged | cooperation | global, or a category label"),
      },
    },
    async ({ category }) => {
      const store = await ensureStore();
      const selected = category ? resolvePartnerCategory(category) : null;
      if (category && !selected) {
        return errorResult("invalid_category", `Unknown partner category '${category}'.`, {
          suggested_tool: "list_cluster_partners",
          available_values: PARTNER_CATEGORIES.map((c) => ({ key: c.key, name: c.name })),
        });
      }

      const categories = selected ? [selected] : PARTNER_CATEGORIES;
      const grouped = categories.map((c) => {
        const members = store.organisations
          .filter((o) => partnerCategoriesFor(o).some((pc) => pc.key === c.key))
          .sort((a, b) => a.name.localeCompare(b.name));
        return {
          key: c.key,
          name: c.name,
          omeka_id: c.o_id,
          description: c.description,
          member_count: members.length,
          amira_url: itemUrl(c.o_id),
          partners: members.map(partnerSummary),
        };
      });
      const uniquePartnerIds = new Set(grouped.flatMap((g) => g.partners.map((p) => p.omeka_id)));

      return textResult({
        source:
          "Organisation dcterms:isPartOf category links when present; MongoDB2OmekaS CLUSTER_PARTNER_GROUPS fallback for older offline snapshots.",
        ...(category ? { filters: { category } } : {}),
        category_count: grouped.length,
        partner_count: uniquePartnerIds.size,
        categories: grouped,
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
