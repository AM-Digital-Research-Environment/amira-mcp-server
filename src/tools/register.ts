import { registerOverviewTools } from "./overview.js";
import { registerResearchItemTools } from "./researchItems.js";
import { registerProjectTools } from "./projects.js";
import { registerResearchSectionTools } from "./researchSections.js";
import { registerPeopleTools } from "./people.js";
import { registerOrganizationTools } from "./organizations.js";
import { registerFacetTools } from "./facets.js";
import { registerPublicationTools } from "./publications.js";
import { registerRelatedTools } from "./related.js";
import { registerMediaTools } from "./media.js";
import { registerAppResources } from "./apps.js";
import { registerResearchTools } from "./research.js";
import { registerOpenAITools } from "./openai.js";
import { applyToolPolicy, type ToolMap } from "./policy.js";
import { allowedTools, type ToolProfile } from "../toolProfiles.js";
import type { Server } from "./_shared.js";

/**
 * Register every AMIRA tool (33 on stdio; 35 with the HTTP-only OpenAI
 * `search`/`fetch`), then apply the shared policy: profile filtering, argument
 * trimming, error shaping, discovery hints and, with `guidance: false`, the
 * removal of every title and description. App resources follow the tools: an
 * app is served only when a tool that renders it is.
 */
export function registerTools(server: Server, profile: ToolProfile = "full", opts: { openai?: boolean; guidance?: boolean } = {}): ToolMap {
  const tools: ToolMap = {};
  registerOverviewTools(server, tools); // get_collection_overview
  registerResearchItemTools(server, tools); // search_research_items, get_research_item
  registerProjectTools(server, tools); // search_projects, get_project
  registerResearchSectionTools(server, tools); // list_research_sections, get_research_section
  registerPeopleTools(server, tools); // search_persons, get_person
  registerOrganizationTools(server, tools); // list_institutions, get_institution, list_cluster_partners, list_groups
  registerFacetTools(server, tools); // list_subjects, list_locations, list_collections, list_categories, list_years
  registerPublicationTools(server, tools); // search_publications, get_publication, list_publication_facets, list_journals
  registerRelatedTools(server, tools); // find_related
  registerMediaTools(server, tools); // search_podcasts, get_podcast, search_videos, get_video
  registerResearchTools(server, tools); // resolve_entity, get_entity_graph, get_text_passages, compare_collections, get_data_quality, get_snapshot_changes
  if (opts.openai) registerOpenAITools(server, tools); // search, fetch (HTTP only)
  const allowed = allowedTools(profile);
  applyToolPolicy(tools, allowed, { guidance: opts.guidance });
  registerAppResources(server, (name) => name in tools && (!allowed || allowed.has(name)), { guidance: opts.guidance });
  return tools;
}
