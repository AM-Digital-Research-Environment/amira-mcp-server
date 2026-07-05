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
import type { Server } from "./_shared.js";

/** Register every AMIRA tool on the server, grouped by domain (26 tools). */
export function registerTools(server: Server): void {
  registerOverviewTools(server); // get_collection_overview
  registerResearchItemTools(server); // search_research_items, get_research_item
  registerProjectTools(server); // search_projects, get_project
  registerResearchSectionTools(server); // list_research_sections, get_research_section
  registerPeopleTools(server); // search_persons, get_person
  registerOrganizationTools(server); // list_institutions, get_institution, list_cluster_partners, list_groups
  registerFacetTools(server); // list_subjects, list_locations, list_collections, list_categories, list_years
  registerPublicationTools(server); // search_publications, get_publication, list_journals
  registerRelatedTools(server); // find_related
  registerMediaTools(server); // search_podcasts, get_podcast, search_videos, get_video
}
