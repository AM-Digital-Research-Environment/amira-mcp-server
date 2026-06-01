import { z } from "zod";
import { ensureStore } from "../data.js";
import type { Publication } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  itemSummary,
  paginate,
  personSummary,
  publicationSummary,
  textResult,
  type Server,
} from "./_shared.js";
import { personUrl } from "../urls.js";
import { nameMatchesQuery, samePerson } from "../names.js";

function pubMatchesPerson(p: Publication, name: string): "author" | "editor" | null {
  const match = (list?: { raw: string; normalized: string; person_name?: string | null }[]) =>
    (list ?? []).some(
      (c) =>
        samePerson(c.normalized, name) ||
        samePerson(c.person_name ?? "", name) ||
        nameMatchesQuery(c.raw, name),
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
        "  - keyword: match against name or affiliation. Name matching is order-independent and " +
        "accent-insensitive — 'Oliver Baumann', 'Baumann, Oliver' and 'Baumann' all find 'Baumann, Oliver'\n" +
        "  - affiliation: match the person's affiliation only\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Returns a paginated envelope; each result has name (always stored as 'Surname, Forename'), " +
        "affiliation and a `dashboard_url`. Use get_person for a full profile.",
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
        if (
          args.keyword &&
          !(
            containsCI(p.name, args.keyword) ||
            nameMatchesQuery(p.name, args.keyword) ||
            anyContainsCI(p.affiliation, args.keyword)
          )
        )
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
        "Aggregate everything the collection knows about one person by `name`. Names are stored " +
        "'Surname, Forename' (e.g. 'Baumann, Oliver'), but you may pass either order and with or without " +
        "accents — 'Oliver Baumann' resolves to 'Baumann, Oliver'. Returns the canonical `name`, the " +
        "`query` you passed, affiliation, projects where they are a principal investigator, projects where " +
        "they are a team member, research items they contributed to (with their role, capped at 50 — total " +
        "reported), publications they authored or edited, and a citable `dashboard_url`. Works even for " +
        "names not in the authority list. Empty role lists mean the name appears nowhere.",
      annotations: annotate("Get person profile"),
      inputSchema: {
        name: z.string().describe("Person name in either order, e.g. 'Beier, Ulli' or 'Ulli Beier'"),
      },
    },
    async ({ name }) => {
      const store = await ensureStore();

      // Resolve to the canonical stored "Surname, Forename" form, accepting
      // either name order (e.g. "Oliver Baumann" -> "Baumann, Oliver").
      const record = store.getPerson(name) ?? store.persons.find((p) => samePerson(p.name, name));
      let canonical = record?.name;
      if (!canonical) {
        for (const it of store.items) {
          const hit = (it.name ?? []).find((n) => samePerson(n.name?.label, name));
          if (hit?.name?.label) {
            canonical = hit.name.label;
            break;
          }
        }
      }
      canonical = canonical ?? name;

      const asPI = store.projects.filter((p) => (p.pi ?? []).some((x) => samePerson(x, canonical)));
      const asMember = store.projects.filter((p) => (p.members ?? []).some((x) => samePerson(x, canonical)));

      const contributed = store.items
        .map((it) => {
          const entry = (it.name ?? []).find((n) => samePerson(n.name?.label, canonical));
          return entry ? { it, role: entry.role || "Contributor" } : null;
        })
        .filter((x): x is { it: (typeof store.items)[number]; role: string } => x !== null);

      const pubs = store.publications
        .map((p) => {
          const role = pubMatchesPerson(p, canonical);
          return role ? { p, role } : null;
        })
        .filter((x): x is { p: Publication; role: "author" | "editor" } => x !== null);

      return textResult({
        name: canonical,
        query: name,
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
        dashboard_url: personUrl(canonical),
      });
    },
  );
}
