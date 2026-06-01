import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import { DASHBOARD_BASE } from "../config.js";
import { annotate, textResult, type Server } from "./_shared.js";
import type { University } from "../types.js";

function tally<T>(items: T[], key: (t: T) => string | string[] | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    const keys = Array.isArray(k) ? k : k != null ? [k] : [];
    for (const one of keys) if (one) out[one] = (out[one] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function yearOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /(\d{4})/.exec(String(iso));
  return m ? Number(m[1]) : null;
}

export function registerOverviewTools(server: Server): void {
  server.registerTool(
    "get_collection_overview",
    {
      title: "Africa Multiple collection overview",
      description:
        "High-level overview of the Africa Multiple research data: counts of projects, research items, " +
        "people, institutions, groups and publications; breakdowns of items by university, research " +
        "section, resource type and language; the content date range; and the data snapshot's freshness. " +
        "Start here to scope what the collection contains before drilling in with the search/list tools. " +
        "Takes no arguments. Returns a JSON object with `counts`, `items_by_university`, " +
        "`items_by_research_section`, `items_by_resource_type`, `items_by_language`, `content_date_range`, " +
        "`research_sections` (names), `universities`, and `data_snapshot` (source + generatedAt).",
      annotations: annotate("Collection overview"),
      inputSchema: {},
    },
    async () => {
      const store = await ensureStore();

      const sectionByProject = new Map(store.projects.map((p) => [p.id, p.researchSection ?? []]));
      const years: number[] = [];
      for (const it of store.items) {
        for (const dr of Object.values(it.dateInfo ?? {})) {
          const ys = [yearOf(dr?.start), yearOf(dr?.end)].filter((y): y is number => y != null);
          for (const y of ys) if (y >= 1000 && y <= 2100) years.push(y);
        }
      }

      const payload: Record<string, unknown> = {
        collection_name: "Africa Multiple Cluster of Excellence — research data (amira)",
        dashboard_url: DASHBOARD_BASE,
        counts: {
          projects: store.projects.length,
          research_items: store.items.length,
          persons: store.persons.length,
          institutions: store.institutions.length,
          groups: store.groups.length,
          research_sections: store.researchSections.length,
          publications: store.publications.length,
        },
        universities: Object.fromEntries(
          (Object.keys(UNIVERSITY_LABELS) as University[]).map((u) => [u, UNIVERSITY_LABELS[u]]),
        ),
        items_by_university: tally(store.items, (it) => UNIVERSITY_LABELS[it.university]),
        items_by_research_section: tally(store.items, (it) => sectionByProject.get(it.project?.id) ?? []),
        items_by_resource_type: tally(store.items, (it) => it.typeOfResource),
        items_by_language: tally(store.items, (it) => it.language ?? []),
        content_date_range: years.length
          ? { earliest: Math.min(...years), latest: Math.max(...years) }
          : null,
        research_sections: store.researchSections.map((s) => s.name),
        data_snapshot: {
          source: store.source,
          generated_at: store.generatedAt || null,
          note:
            "Data is a snapshot of the public amira dashboard JSON; it never queries MongoDB directly. " +
            (store.source === "cache"
              ? "Loaded from a refreshed local cache."
              : "Loaded from the bundled snapshot."),
        },
      };
      return textResult(payload);
    },
  );
}
