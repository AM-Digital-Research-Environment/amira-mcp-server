import { z } from "zod";
import { ensureStore } from "../data.js";
import type { DataStore } from "../data.js";
import type { OrganisationRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
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
      description: "Browse institution authorities by name, country or affiliation; returns citation links.",
      annotations: annotate("List institutions"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional(),
        limit: z.number().int().min(1).optional().describe("Default 50, max 200"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_institutions");
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
      description: "Institution profile, members, funded projects and research connections, with citation links.",
      annotations: annotate("Get institution detail"),
      inputSchema: z.strictObject({ name: z.string().max(1000).describe("Institution name") }),
    },
    async ({ name }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_institution");
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
      description: "Cluster partner institutions grouped by catalogue category, with citation links.",
      annotations: annotate("List cluster partners"),
      inputSchema: z.strictObject({
        category: z
          .string().max(1000)
          .optional()
          .describe("Optional: amrc | privileged | cooperation | global, or a category label"),
      }),
    },
    async ({ category }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_cluster_partners");
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
      description: "Browse research groups and associations by name, with citation links.",
      annotations: annotate("List groups"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional(),
        limit: z.number().int().min(1).optional().describe("Default 50, max 200"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "list_groups");
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
