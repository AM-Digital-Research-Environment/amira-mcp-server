import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import { SITE_BASE } from "../config.js";
import { allowStructured, exposureLevel } from "../exposure.js";
import { annotate, textResult, type Server } from "./_shared.js";
import { OVERVIEW_UI_META } from "./apps.js";
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

export function registerOverviewTools(server: Server): void {
  server.registerTool(
    "get_collection_overview",
    {
      title: "Africa Multiple collection overview",
      // Renders as stat tiles + ranked breakdowns in MCP Apps hosts; plain JSON
      // everywhere else.
      _meta: OVERVIEW_UI_META,
      description:
        "START HERE to scope the collection before drilling in with the search/list tools: counts across " +
        "every corpus (projects, research items, people, institutions, groups, publications, podcasts, " +
        "videos, and how many carry full text or transcripts), breakdowns of items by university, " +
        "research section, resource type and language, the content date range, and the data snapshot's " +
        "freshness. Takes no arguments.",
      annotations: annotate("Collection overview"),
      inputSchema: {},
    },
    async () => {
      const store = await ensureStore();

      let yearMin: number | null = null;
      let yearMax: number | null = null;
      for (const it of store.items) {
        if (it.year_min != null && (yearMin == null || it.year_min < yearMin)) yearMin = it.year_min;
        if (it.year_max != null && (yearMax == null || it.year_max > yearMax)) yearMax = it.year_max;
      }

      const pubsWithFulltext = store.publications.filter((p) => p.fulltext).length;
      const videosWithTranscript = store.videos.filter((v) => v.transcript).length;
      const podcastsWithTranscript = store.podcasts.filter((p) => p.transcript).length;

      return textResult({
        collection_name: "Africa Multiple Cluster of Excellence — research data (AMIRA)",
        site_url: SITE_BASE,
        counts: {
          projects: store.projects.length,
          research_items: store.items.length,
          persons: store.persons.length,
          institutions: store.organisations.filter((o) => o.kind === "institution").length,
          groups: store.organisations.filter((o) => o.kind === "group").length,
          research_sections: store.sections.length,
          publications: store.publications.length,
          publications_with_fulltext: pubsWithFulltext,
          journals: store.journals.length,
          podcasts: store.podcasts.length,
          podcasts_with_transcript: podcastsWithTranscript,
          youtube_videos: store.videos.length,
          videos_with_transcript: videosWithTranscript,
        },
        // Relational breakdowns are structured-level metadata.
        ...(allowStructured()
          ? {
              universities: Object.fromEntries(
                (Object.keys(UNIVERSITY_LABELS) as University[]).map((u) => [u, UNIVERSITY_LABELS[u]]),
              ),
              items_by_university: tally(store.items, (it) => UNIVERSITY_LABELS[it.university]),
              items_by_research_section: tally(store.items, (it) => store.sectionsOfItem(it)),
              items_by_resource_type: tally(store.items, (it) => it.type),
              items_by_language: tally(store.items, (it) => it.languages.map((l) => l.label)),
              research_sections: store.sections.map((s) => s.name),
            }
          : { items_by_resource_type: tally(store.items, (it) => it.type) }),
        content_date_range: yearMin != null ? { earliest: yearMin, latest: yearMax } : null,
        ...(exposureLevel() !== "full" ? { metadata_exposure: exposureLevel() } : {}),
        data_snapshot: {
          source: store.source,
          fetched_at: store.manifest.fetchedAt,
          max_modified: store.manifest.maxModified,
          api_base: store.manifest.apiBase,
          note:
            "Data is a snapshot of the public Omeka S API (site 'amira'); the server contacts no database. " +
            (store.source === "cache" ? "Loaded from a refreshed local cache." : "Loaded from the bundled snapshot."),
        },
      });
    },
  );
}
