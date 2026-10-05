import { z } from "zod";
export const countMap = z.record(z.string(), z.number());
export const refreshSchema = z.object({ enabled: z.boolean(), in_flight: z.boolean(), last_attempt: z.string().nullable(),
  last_success: z.string().nullable(), error_class: z.string().nullable() });
export const overviewSchema = z.object({ collection_name: z.string(), site_url: z.string(), counts: countMap,
  universities: z.record(z.string(), z.string()).optional(), items_by_university: countMap.optional(),
  items_by_research_section: countMap.optional(), items_by_resource_type: countMap, items_by_language: countMap.optional(),
  research_sections: z.array(z.string()).optional(), content_date_range: z.object({ earliest: z.number(), latest: z.number().nullable() }).nullable(),
  metadata_exposure: z.string().optional(), data_snapshot: z.object({ source: z.string(), fetched_at: z.string(), max_modified: z.string().nullable(), api_base: z.string(), note: z.string() }), refresh: refreshSchema });
export const timelineSchema = z.object({ count: z.number(), total_matches: z.number(), offset: z.number(), has_more: z.boolean(), next_offset: z.number().optional(),
  bucket: z.string(), sort: z.string(), distinct_buckets: z.number(), dated_items: z.number(), undated_items: z.number(),
  year_range: z.object({ min: z.number(), max: z.number() }).optional(),
  results: z.array(z.object({ item_count: z.number(), year: z.number().optional(), decade: z.string().optional(), from: z.number().optional(), to: z.number().optional() })) }).loose();
