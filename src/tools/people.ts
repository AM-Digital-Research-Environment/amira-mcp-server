import { z } from "zod";
import { ensureStore } from "../data.js";
import type { PublicationRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  annotate,
  anyContainsCI,
  capLimit,
  capOffset,
  containsCI,
  errorResult,
  exposureRestrictedResult,
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
    refs.some((r) => (personOId != null && r.o_id != null) ? r.o_id === personOId : samePerson(r.label, name) || nameMatchesQuery(r.label, name));
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
      description: "Find canonical person authority records. Names accept either order and ignore accents. Use resolve_entity to disambiguate homonyms.",
      annotations: annotate("Search people"),
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Matches the name or an affiliation"),
        affiliation: z.string().max(1000).optional().describe("Matches the person's affiliations only"),
        limit: z.number().int().min(1).optional().describe("Default 25, max 100"),
        offset: z.number().int().min(0).max(100_000).optional(),
      }),
    },
    async (args) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "search_persons");
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
      description: "Person affiliations, PI/member projects, contributed items and publications. Profile lists cap at 50 with total counts. Use id to disambiguate names.",
      annotations: annotate("Get person profile"),
      inputSchema: z.strictObject({
        name: z
          .string().max(1000)
          .optional()
          .describe("Either name order, with or without accents: 'Beier, Ulli' and 'Ulli Beier' both resolve"),
        id: z.number().int().positive().optional().describe("Exact person Omeka ID; required to disambiguate homonyms"),
      }),
    },
    async ({ name, id }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_person");
      if (!id && !name) return errorResult("missing_entity", "Provide name or id.");
      const candidates = id ? store.persons.filter((p) => p.o_id === id) : store.persons.filter((p) => samePerson(p.name, name!));
      if (id && !candidates.length) return errorResult("not_found", "Unknown person id.");
      if (candidates.length > 1) return errorResult("ambiguous_entity", "Multiple people share this name; use an exact id from resolve_entity.", { suggested_tool: "resolve_entity", available_values: candidates.map((p) => String(p.o_id)) });
      name = name ?? candidates[0]!.name;

      // Resolve to the canonical stored "Surname, Forename" form.
      const record =
        candidates[0];
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
        oId != null && refOId != null ? refOId === oId : samePerson(label, canonical!);

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
        publications: pubs.slice(0, 50).map(({ p, role }) => ({ role, ...publicationSummary(p) })),
        publications_truncated: pubs.length > 50 || undefined,
        amira_url: itemUrlOrNull(oId),
      });
    },
  );
}
