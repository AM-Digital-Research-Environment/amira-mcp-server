import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec } from "../types.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  filtersEcho,
  itemRef,
  limitEcho,
  pageOf,
  personSummary,
  publicationSummary,
  refLabels,
  textResult,
  type Server,
} from "./_shared.js";
import { itemUrlOrNull } from "../urls.js";
import { nameMatchesQuery, samePerson } from "../names.js";

function pubRole(p: PublicationRec, personOId: number | null, name: string): "author" | "editor" | null {
  const match = (refs: PublicationRec["authors"]) =>
    refs.some((r) => (personOId != null && r.o_id === personOId) || samePerson(r.label, name) || nameMatchesQuery(r.label, name));
  if (match(p.authors)) return "author";
  if (match(p.editors)) return "editor";
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
        "  - affiliation: match the person's affiliations only\n" +
        "  - limit (default 25, max 100), offset\n\n" +
        "Each result has name (stored 'Surname, Forename'), affiliations and a citable `amira_url`. Use " +
        "get_person for a full profile.",
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
            anyContainsCI(refLabels(p.affiliations), args.keyword)
          )
        )
          return false;
        if (args.affiliation && !anyContainsCI(refLabels(p.affiliations), args.affiliation)) return false;
        return true;
      });

      return textResult(
        pageOf(filtered, offset, limit, personSummary, { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) }),
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
        "'Surname, Forename' (e.g. 'Baumann, Oliver'), but either order works, with or without accents — " +
        "'Oliver Baumann' resolves to 'Baumann, Oliver'; the canonical `name` is echoed back. Returns " +
        "affiliations, projects led (PI) and joined (member), research items contributed (slim refs with " +
        "the person's role — use get_research_item for detail; capped at 50, total reported), " +
        "publications authored/edited, and a citable `amira_url`. Works even for names absent from the " +
        "authority list; empty lists mean the name appears nowhere.",
      annotations: annotate("Get person profile"),
      inputSchema: {
        name: z.string().describe("Person name in either order, e.g. 'Beier, Ulli' or 'Ulli Beier'"),
      },
    },
    async ({ name }) => {
      const store = await ensureStore();

      // Resolve to the canonical stored "Surname, Forename" form.
      const record =
        store.getPersonByName(name) ?? store.persons.find((p) => samePerson(p.name, name));
      let canonical = record?.name ?? null;
      if (!canonical) {
        outer: for (const it of store.items) {
          for (const c of it.contributors) {
            if (samePerson(c.name, name)) {
              canonical = c.name;
              break outer;
            }
          }
        }
      }
      canonical = canonical ?? name;
      const oId = record?.o_id ?? null;
      const isPerson = (label: string, refOId: number | null): boolean =>
        (oId != null && refOId === oId) || samePerson(label, canonical!);

      const asPI = store.projects.filter((p) => p.pis.some((x) => isPerson(x.label, x.o_id)));
      const asMember = store.projects.filter((p) => p.members.some((x) => isPerson(x.label, x.o_id)));

      const contributed: { ref: Record<string, unknown>; role: string }[] = [];
      for (const it of store.items) {
        const credit = it.contributors.find((c) => isPerson(c.name, c.o_id));
        if (credit) contributed.push({ ref: itemRef(it), role: credit.role || "Contributor" });
      }

      const pubs: { p: PublicationRec; role: "author" | "editor" }[] = [];
      for (const p of store.publications) {
        const role = pubRole(p, oId, canonical);
        if (role) pubs.push({ p, role });
      }

      return textResult({
        name: canonical,
        query: name,
        found_in_authority_list: !!record,
        affiliations: refLabels(record?.affiliations),
        as_principal_investigator: asPI.map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, name: p.name })),
        as_member: asMember.map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, name: p.name })),
        contributed_item_count: contributed.length,
        contributed_items: contributed.slice(0, 50).map(({ ref, role }) => ({ role, ...ref })),
        contributed_items_truncated: contributed.length > 50 || undefined,
        publication_count: pubs.length,
        publications: pubs.map(({ p, role }) => ({ role, ...publicationSummary(p) })),
        amira_url: itemUrlOrNull(oId),
      });
    },
  );
}
