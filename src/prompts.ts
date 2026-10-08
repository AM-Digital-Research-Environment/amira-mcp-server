// MCP prompts: user-invoked research workflows (slash commands in most hosts).
//
// Prompts cost nothing in the per-turn tool budget — they are listed through
// `prompts/list`, not `tools/list` — so they are where multi-step guidance
// belongs: each one chains the existing tools and restates the citation
// contract. Arguments autocomplete (`completion/complete`) from the snapshot's
// own authority names, so a user picks "Baumann, Oliver" rather than guessing
// the stored spelling.
import { completable, type McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ensureStore, type DataStore } from "./data.js";
import { fold } from "./text.js";

const CITE =
  "Cite every record you mention with its `amira_url` as a markdown link, one link per record; use only URLs the " +
  "tools return and never print legacy DRE identifiers. State what the collection does not cover rather than " +
  "implying absence.";

/** Up to 20 stored names that start with (then contain) the typed prefix. */
function suggest(key: string, pick: (store: DataStore) => string[]) {
  return async (value: string | undefined): Promise<string[]> => {
    const store = await ensureStore();
    const names = store.cached(`complete:${key}`, () => [...new Set(pick(store))].sort());
    const q = fold(value ?? "");
    const starts = names.filter((n) => fold(n).startsWith(q));
    const contains = q ? names.filter((n) => !fold(n).startsWith(q) && fold(n).includes(q)) : [];
    return [...starts, ...contains].slice(0, 20);
  };
}

const subjectNames = (store: DataStore): string[] =>
  store.subjects.length ? store.subjects.map((s) => s.name) : store.items.flatMap((it) => it.subjects.map((s) => s.label));
const projectNames = (store: DataStore): string[] => store.projects.map((p) => p.name);
const personNames = (store: DataStore): string[] => store.persons.map((p) => p.name);
const placeNames = (store: DataStore): string[] => store.locations.map((l) => l.name);

const text = (body: string) => ({
  messages: [{ role: "user" as const, content: { type: "text" as const, text: body } }],
});

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "literature_review",
    {
      title: "Literature review from the cluster bibliography",
      description: "Survey what the Africa Multiple bibliography and research data hold on a topic, with cited sources.",
      argsSchema: z.object({
        topic: completable(z.string().describe("Topic or subject heading"), suggest("subjects", subjectNames)),
        year_from: z.string().optional().describe("Earliest publication year (optional)"),
        year_to: z.string().optional().describe("Latest publication year (optional)"),
      }),
    },
    ({ topic, year_from, year_to }) => {
      const years = [year_from && `from ${year_from}`, year_to && `to ${year_to}`].filter(Boolean).join(" ");
      return text(
        `Write a short literature review on "${topic}"${years ? ` (${years})` : ""} from the AMIRA collection.\n\n` +
          "1. get_collection_overview — note the snapshot date and coverage.\n" +
          `2. list_publication_facets (facet: type, then year) with keyword "${topic}"${years ? " and the year range" : ""} to size the field.\n` +
          `3. search_publications with keyword "${topic}" (and subject if a heading fits); page with next_offset. Prefer records with has_fulltext.\n` +
          "4. For the most relevant open-access works, get_text_passages with their typed ids and the topic to quote evidence.\n" +
          `5. search_research_items and find_related (entity_type subject) for archival material and connected projects.\n` +
          "6. Group the works by theme and period, name the main authors and projects, and list open questions.\n\n" +
          CITE,
      );
    },
  );

  server.registerPrompt(
    "project_dossier",
    {
      title: "Project dossier",
      description: "Profile one research project: team, sections, holdings, places, time span and connections.",
      argsSchema: z.object({ project: completable(z.string().describe("Project name or Omeka id"), suggest("projects", projectNames)) }),
    },
    ({ project }) =>
      text(
        `Prepare a dossier on the research project "${project}".\n\n` +
          `1. search_projects with keyword "${project}" (or get_project if you already have its id).\n` +
          "2. get_project — description, team, sections, funders, item counts and sample items.\n" +
          "3. list_years and list_locations with filters.project_id — when and where its material comes from.\n" +
          "4. search_research_items with project_id — representative items; note has_media and media types.\n" +
          "5. resolve_entity (type project) then get_entity_graph — the people, subjects and places it connects to.\n" +
          "6. Summarise scope, holdings, coverage gaps and links to related projects.\n\n" +
          CITE,
      ),
  );

  server.registerPrompt(
    "person_profile",
    {
      title: "Researcher profile",
      description: "Profile one person: affiliations, projects, publications, credited items and collaborators.",
      argsSchema: z.object({ name: completable(z.string().describe("Person name, either order"), suggest("persons", personNames)) }),
    },
    ({ name }) =>
      text(
        `Profile the researcher "${name}" from the AMIRA collection.\n\n` +
          `1. resolve_entity with query "${name}" and type person. If several candidates match, ask which one is meant.\n` +
          "2. get_person with the chosen id — affiliations, authority identifiers, project and research-section roles, publications, credited items, podcasts, videos and collaborators.\n" +
          "3. get_entity_graph with the person id — the subjects, places and projects around their work.\n" +
          "4. search_publications with author — the full publication list, newest first.\n" +
          "5. Summarise research themes, roles (PI, member, author, editor) and main collaborators.\n\n" +
          CITE + " Display the name in its stored 'Surname, Forename' form.",
      ),
  );

  server.registerPrompt(
    "place_report",
    {
      title: "Place report",
      description: "What the collection holds about a place: items, projects, subjects, periods and media.",
      argsSchema: z.object({ place: completable(z.string().describe("Country, city or region"), suggest("places", placeNames)) }),
    },
    ({ place }) =>
      text(
        `Report what the AMIRA collection holds about "${place}".\n\n` +
          `1. list_locations with keyword "${place}" — the matching place records, their country and item counts.\n` +
          `2. search_research_items with location "${place}" — representative items; use has_media to find digitised material.\n` +
          `3. find_related with entity_type location and value "${place}" — connected projects, subjects and people.\n` +
          `4. list_years with filters.location "${place}" — the periods covered.\n` +
          "5. Summarise holdings by project, type, language and period, and note what is missing.\n\n" +
          CITE,
      ),
  );

  server.registerPrompt(
    "transcript_evidence",
    {
      title: "Evidence in transcripts and full texts",
      description: "Find and quote passages on a theme across podcast and video transcripts and open-access publications.",
      argsSchema: z.object({ query: z.string().describe("Word or quoted phrase to find") }),
    },
    ({ query }) =>
      text(
        `Find evidence about "${query}" in AMIRA transcripts and full texts.\n\n` +
          `1. search_podcasts, search_videos and search_publications with keyword "${query}" — keep the records matched in transcript or fulltext.\n` +
          "2. get_text_passages with up to ten of their typed ids (podcast:, video:, publication:) and the same keyword; follow next_offset.\n" +
          "3. Quote short passages with their offsets; say who speaks or writes and when.\n" +
          "4. Transcripts may be machine-generated: report transcript_generated_by from get_podcast / get_video when present.\n\n" +
          CITE,
      ),
  );
}
