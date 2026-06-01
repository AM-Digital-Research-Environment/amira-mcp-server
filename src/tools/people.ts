import { z } from "zod";
import { ensureStore } from "../data.js";
import type { Publication } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  equalsCI,
  itemSummary,
  paginate,
  personSummary,
  publicationSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { personUrl } from "../urls.js";

function pubMatchesPerson(p: Publication, name: string): "author" | "editor" | null {
  const match = (list?: { raw: string; normalized: string; person_name?: string | null }[]) =>
    (list ?? []).some(
      (c) => equalsCI(c.normalized, name) || equalsCI(c.person_name ?? "", name) || containsCI(c.raw, name),
    );
  if (match(p.authors)) return "author";
  if (match(p.editors) || match(p.book_editors)) return "editor";
  return null;
}

export function registerPeopleTools(server: Server): void {
  // === search_persons =======================================================
  server.registerTool(
    "search_persons",
    {
      title: "Search people",
      description:
        "Search the people authority list (researchers and contributors). Filters (optional, AND-combined):\n" +
        "  - keyword: match against name or affiliation\n" +
        "  - affiliation: match the person's affiliation only\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Returns a paginated envelope; each result has name, affiliation and a `dashboard_url`. Use " +
        "get_person for a full profile (projects led/joined, items contributed, publications). Note: names " +
        "follow 'Surname, Forename'.",
      annotations: annotate("Search people"),
      inputSchema: {
        keyword: z.string().optional(),
        affiliation: z.string().optional(),
        limit: z.number().int().optional().describe("Default 25, max 100"),
        offset: z.number().int().optional(),
      },
    },
    async (args) => {
      const store = await ensureStore();
      const limit = capLimit(args.limit, 25, 100);
      const offset = capOffset(args.offset);

      const filtered = store.persons.filter((p) => {
        if (args.keyword && !(containsCI(p.name, args.keyword) || anyContainsCI(p.affiliation, args.keyword)))
          return false;
        if (args.affiliation && !anyContainsCI(p.affiliation, args.affiliation)) return false;
        return true;
      });

      return textResult(
        paginate(filtered.map(personSummary), offset, limit, {
          filters: { keyword: args.keyword ?? null, affiliation: args.affiliation ?? null },
        }),
      );
    },
  );

  // === get_person ===========================================================
  server.registerTool(
    "get_person",
    {
      title: "Get person profile",
      description:
        "Aggregate everything the collection knows about one person by `name` ('Surname, Forename', " +
        "case-insensitive). Returns affiliation; projects where they are a principal investigator; projects " +
        "where they are a team member; research items they contributed to (with their role, capped at 50 — " +
        "total reported); publications they authored or edited; and a citable `dashboard_url`. Works even " +
        "for names not in the authority list (PIs/contributors are matched across projects, items and the " +
        "bibliography). Returns empty role lists if the name appears nowhere.",
      annotations: annotate("Get person profile"),
      inputSchema: { name: z.string().describe("Person name, e.g. 'Beier, Ulli'") },
    },
    async ({ name }) => {
      const store = await ensureStore();
      const record = store.getPerson(name);

      const asPI = store.projects.filter((p) => (p.pi ?? []).some((x) => equalsCI(x, name)));
      const asMember = store.projects.filter((p) => (p.members ?? []).some((x) => equalsCI(x, name)));

      const contributed = store.items
        .map((it) => {
          const entry = (it.name ?? []).find((n) => equalsCI(n.name?.label, name));
          return entry ? { it, role: entry.role || "Contributor" } : null;
        })
        .filter((x): x is { it: (typeof store.items)[number]; role: string } => x !== null);

      const pubs = store.publications
        .map((p) => {
          const role = pubMatchesPerson(p, name);
          return role ? { p, role } : null;
        })
        .filter((x): x is { p: Publication; role: "author" | "editor" } => x !== null);

      return textResult({
        name,
        found_in_authority_list: !!record,
        affiliation: record?.affiliation ?? [],
        as_principal_investigator: asPI.map((p) => ({ id: p.id, name: p.name })),
        as_member: asMember.map((p) => ({ id: p.id, name: p.name })),
        contributed_item_count: contributed.length,
        contributed_items: contributed.slice(0, 50).map(({ it, role }) => ({
          role,
          ...itemSummary(it),
        })),
        publication_count: pubs.length,
        publications: pubs.map(({ p, role }) => ({ role, ...publicationSummary(p) })),
        dashboard_url: personUrl(name),
      });
    },
  );
}
