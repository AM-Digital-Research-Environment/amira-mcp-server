// get_fulltext_map: the collection-level view of DRE Visualizations' full-text
// map of the ILAM journal *African Music* (src/fulltextMaps.ts). One tool, three
// readings of the same public files: content groups with AI-generated labels,
// the countries articles name, and word frequencies per year. Per-article
// readings live on get_research_item, find_related (research_item) and the
// `mentions_country` research-item filter. No article text is ever returned.
import { z } from "zod";
import type { ToolMap } from "./policy.js";
import { ensureStore } from "../data.js";
import { allowDescriptive } from "../exposure.js";
import {
  countriesNote, excludedCount, fulltextIndex, groupLabelNote, neighboursNote, sourceRef, wordsNote, wordTrends, type FulltextIndex,
} from "../fulltextMaps.js";
import { itemSetUrl, itemUrl } from "../urls.js";
import { READ_ONLY, errorResult, exposureRestrictedResult, textResult, yearLabel, type Server } from "./_shared.js";
import type { DataStore } from "../data.js";
import { guidanceEnabled } from "../guidance.js";

const SAMPLE_PER_GROUP = 2;

export function registerFulltextTools(server: Server, tools: ToolMap): void {
  tools.get_fulltext_map = server.registerTool(
    "get_fulltext_map",
    {
      title: "ILAM full-text map",
      description:
        "ILAM's journal African Music by its private full text, from public derived counts: AI-labelled content groups, " +
        "countries named, word rates per year. Never returns text.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        words: z.array(z.string().min(1).max(60)).min(1).max(6).optional()
          .describe("Single words: yearly rates per 10,000 words instead of the overview"),
        group: z.number().int().min(1).optional().describe("Group id: list its articles"),
        year_from: z.number().int().min(0).max(2200).optional(),
        year_to: z.number().int().min(0).max(2200).optional(),
      }),
    },
    async (args) => {
      if (!allowDescriptive()) return exposureRestrictedResult("descriptive", "get_fulltext_map");
      const store = await ensureStore();
      const index = fulltextIndex(store);
      if (!index) return errorResult("fulltext_map_unavailable", "This snapshot carries no full-text map.");
      if (args.year_from !== undefined && args.year_to !== undefined && args.year_from > args.year_to) {
        return errorResult("invalid_range", "`year_from` must be less than or equal to `year_to`.");
      }
      const head = header(store, index);
      if (args.words) {
        const trends = wordTrends(index, args.words, args.year_from, args.year_to);
        return textResult({ ...head, words: { ...trends, min_articles: index.maps.words.minArticles, note: wordsNote(index) } });
      }
      if (args.group !== undefined) {
        const group = index.groups.get(args.group);
        if (!group) {
          return errorResult("not_found", `No content group ${args.group}; groups run from 1 to ${Math.max(...index.groups.keys())}.`, {
            suggested_tool: "get_fulltext_map",
          });
        }
        const members = group.members.map((id) => store.getItem(String(id))!)
          .sort((a, b) => (a.year_min ?? 9999) - (b.year_min ?? 9999) || a.title.localeCompare(b.title));
        return textResult({
          ...head,
          group: { id: group.id, label: group.label, label_ai_generated: true, articles: members.length },
          group_note: groupLabelNote(index),
          results: members.map((it) => ({ title: it.title, date: yearLabel(it), omeka_id: it.o_id, amira_url: itemUrl(it.o_id) })),
        });
      }
      return textResult({ ...head, ...overview(store, index) });
    },
  );
}

function header(store: DataStore, index: FulltextIndex) {
  const set = store.getItemSet(index.itemSetId);
  const c = index.maps.map.counts;
  // Cited by the collection's project page when known (#18); the set page redirects there.
  const collection = index.collection
    ? { title: index.collection.title, omeka_id: index.collection.omeka_id, item_set_id: index.itemSetId, amira_url: index.collection.amira_url }
    : { title: set?.title ?? `Collection ${index.itemSetId}`, omeka_id: index.itemSetId, amira_url: itemSetUrl(index.itemSetId) };
  return {
    collection,
    source: sourceRef(index),
    coverage: {
      articles: c.items, with_full_text: c.withText, on_map: index.articles.size,
      // Reasons overlap: an article can be both short and journal furniture.
      not_on_map_with_full_text: excludedCount(index), exclusion_reasons: c.excluded,
    },
    privacy: "Derived from ILAM's full text offline; the text itself is private in AMIRA and is neither read nor quoted by this server.",
  };
}

function overview(store: DataStore, index: FulltextIndex) {
  const groups = [...index.groups.values()].filter((g) => g.members.length).sort((a, b) => b.members.length - a.members.length || a.id - b.id);
  const unclustered = [...index.articles.values()].filter((a) => !index.groups.has(a.group)).length;
  const countries = new Map<string, { country: string; articles: number; mentions: number }>();
  for (const article of index.articles.values()) {
    for (const { country, mentions } of article.countries) {
      const row = countries.get(country) ?? { country, articles: 0, mentions: 0 };
      row.articles++; row.mentions += mentions; countries.set(country, row);
    }
  }
  return {
    groups: groups.map((g) => ({
      id: g.id, label: g.label, label_ai_generated: true, articles: g.members.length,
      sample: g.members.slice(0, SAMPLE_PER_GROUP).map((id) => ({ title: store.getItem(String(id))!.title, amira_url: itemUrl(id) })),
    })),
    unclustered_articles: unclustered,
    group_note: groupLabelNote(index),
    countries_named: [...countries.values()].sort((a, b) => b.articles - a.articles || a.country.localeCompare(b.country)),
    countries_note: countriesNote(index),
    neighbours_note: neighboursNote(index),
    ...(guidanceEnabled() ? { next_steps: NEXT_STEPS } : {}),
  };
}

const NEXT_STEPS = "group=<id> lists a group's articles; words=[...] gives word trends; search_research_items mentions_country=<country> " +
  "lists articles naming a country; get_research_item or find_related(entity_type=research_item) gives an article's closest articles.";
