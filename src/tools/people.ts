import type { ToolMap } from "./policy.js";
import { z } from "zod";
import { ensureStore } from "../data.js";
import type { DataStore } from "../data.js";
import type { PersonRec, PublicationRec } from "../types.js";
import { allowStructured } from "../exposure.js";
import {
  READ_ONLY,
  anyContainsCI,
  capLimit,
  capOffset,
  emptySearchHint,
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
import { itemUrl, itemUrlOrNull } from "../urls.js";
import { nameKey, nearMissNames, personMatches, samePerson } from "../names.js";
import { guidanceEnabled } from "../guidance.js";
import { resolveEntities } from "../entityGraph.js";
import { stripTypedId } from "../typedIds.js";
import { fold } from "../text.js";

/** Author or editor role of a person on a publication — by Omeka id when both
 * sides are linked, otherwise by the full order-independent name. The old
 * prefix fallback credited "Ba" with 60 publications by Bauriedl, Bawa, Bango… */
function pubRole(p: PublicationRec, personOId: number | null, name: string): "author" | "editor" | null {
  const match = (refs: PublicationRec["authors"]) =>
    refs.some((r) => (personOId != null && r.o_id != null) ? r.o_id === personOId : samePerson(r.label, name));
  if (match(p.authors)) return "author";
  if (match(p.editors)) return "editor";
  return null;
}

/** True when the name occurs as a full credit anywhere (contributor, author, editor). */
function creditedAnywhere(store: DataStore, name: string): string | null {
  return store.cached(`credited-names`, () => {
    const names = new Map<string, string>();
    const add = (label: string) => { const key = nameKey(label); if (key && !names.has(key)) names.set(key, label); };
    for (const it of store.items) for (const c of it.contributors) add(c.name);
    for (const p of store.publications) for (const r of [...p.authors, ...p.editors]) add(r.label);
    return names;
  }).get(nameKey(name)) ?? null;
}

const COLLABORATOR_CAP = 15;

/** Near misses offered when a person search finds nobody. */
const SUGGESTION_CAP = 5;

/**
 * `{ suggestions, hint }` for a person query that matched nobody: the authority
 * records whose name is a typo away from it (src/names.ts), each with its typed
 * id and citation. Empty when there are none, and always with AMIRA_GUIDANCE=off.
 * Shared by search_persons and resolve_entity.
 */
export function personSuggestions(persons: readonly PersonRec[], query: string): Record<string, unknown> {
  if (!guidanceEnabled()) return {};
  const close = nearMissNames(persons, query, SUGGESTION_CAP);
  if (!close.length) return {};
  return {
    suggestions: close.map((p) => ({ id: `person:${p.o_id}`, name: p.name, amira_url: itemUrl(p.o_id) })),
    hint: "No person has this name. These authority names are spelled similarly; confirm one is the person meant before using it.",
  };
}

export function registerPeopleTools(server: Server, tools: ToolMap): void {
  // === search_persons =======================================================
  tools.search_persons = server.registerTool(
    "search_persons",
    {
      title: "Search people",
      description: "Find canonical person authority records. Names accept either order and ignore accents. Use resolve_entity to disambiguate homonyms.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        keyword: z.string().max(1000).optional().describe("Matches the name, a name variant or an affiliation"),
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

      const keywordMatches = (p: PersonRec, keyword: string) =>
        personMatches(p.name, keyword) ||
        (p.alt_names ?? []).some((alt) => personMatches(alt, keyword)) ||
        anyContainsCI(refLabels(p.affiliations), keyword);
      const affiliated = (p: PersonRec) => !args.affiliation || anyContainsCI(refLabels(p.affiliations), args.affiliation);
      const filtered = store.persons.filter((p) => (!args.keyword || keywordMatches(p, args.keyword)) && affiliated(p));

      const page = pageOf(filtered, offset, limit, personSummary, { ...limitEcho(args.limit, 100, limit), ...filtersEcho(args) });
      // Suggest spellings only when the keyword itself matched nobody: when an
      // affiliation filter removed the matches, the name was not the problem,
      // and the generic advice to relax filters applies instead.
      const spelling = filtered.length || !args.keyword || store.persons.some((p) => keywordMatches(p, args.keyword!))
        ? {} : personSuggestions(store.persons.filter(affiliated), args.keyword);
      return textResult({ ...page, ...("suggestions" in spelling ? spelling : emptySearchHint(filtered.length, args)) });
    },
  );

  // === get_person ===========================================================
  tools.get_person = server.registerTool(
    "get_person",
    {
      title: "Get person profile",
      description: "Person affiliations, authority identifiers, PI/member projects, credited items, publications and top collaborators. Lists cap at 50 with totals. Use id to disambiguate.",
      annotations: READ_ONLY,
      inputSchema: z.strictObject({
        name: z
          .string().max(1000)
          .optional()
          .describe("Full name in either order, with or without accents: 'Beier, Ulli' and 'Ulli Beier' both resolve"),
        id: z.union([z.number().int().positive(), z.string().max(64)]).optional()
          .describe("Exact person Omeka id or typed id (person:123); required to disambiguate homonyms"),
      }),
    },
    async ({ name, id }) => {
      const store = await ensureStore();
      if (!allowStructured()) return exposureRestrictedResult("structured", "get_person");
      if (id == null && !name) return errorResult("missing_entity", "Provide name or id.");
      const oIdArg = id != null ? Number(stripTypedId(String(id), ["person"])) : null;
      if (oIdArg != null && !Number.isSafeInteger(oIdArg)) return errorResult("invalid_id", "Use a numeric person id or person:<id>.");
      const candidates = oIdArg != null ? store.persons.filter((p) => p.o_id === oIdArg) : store.persons.filter((p) => samePerson(p.name, name!));
      if (oIdArg != null && !candidates.length) return errorResult("not_found", "Unknown person id.", { suggested_tool: "resolve_entity" });
      if (candidates.length > 1) return errorResult("ambiguous_entity", "Multiple people share this name; use an exact id from resolve_entity.", { suggested_tool: "resolve_entity", available_values: candidates.map((p) => String(p.o_id)), terse: "Multiple people share this name; use an exact id." });

      const record: PersonRec | undefined = candidates[0];
      // Without an authority record, the name must still be a full credit
      // somewhere — a fragment ("Ba") is a search, not a person.
      const canonical = record?.name ?? creditedAnywhere(store, name!);
      if (!canonical) {
        // Partial matches first, then names a typo away ("Rudigr Seeman").
        const close = [...new Set([
          ...resolveEntities(store, name!, "person").map((e) => `${e.label} (${e.id})`),
          ...nearMissNames(store.persons, name!, SUGGESTION_CAP).map((p) => `${p.name} (person:${p.o_id})`),
        ])].slice(0, 10);
        return errorResult("not_found", `No person named '${name}'. Names must be complete; use resolve_entity or search_persons for partial names.`, {
          suggested_tool: "resolve_entity", available_values: close, terse: `No person named '${name}'. Names must be complete.`,
        });
      }
      const oId = record?.o_id ?? null;
      const isPerson = (label: string, refOId: number | null): boolean =>
        oId != null && refOId != null ? refOId === oId : samePerson(label, canonical);

      const asPI = store.projects.filter((p) => p.pis.some((x) => isPerson(x.label, x.o_id)));
      const asMember = store.projects.filter((p) => p.members.some((x) => isPerson(x.label, x.o_id)));

      // Collaborators: other people credited on the same items or publications,
      // counted once per shared record.
      const collaborators = new Map<string, { name: string; o_id: number | null; shared_items: number; shared_publications: number }>();
      const tally = (refs: { label: string; o_id: number | null }[], field: "shared_items" | "shared_publications") => {
        const seen = new Set<string>();
        for (const ref of refs) {
          if (isPerson(ref.label, ref.o_id)) continue;
          const key = ref.o_id != null ? `id:${ref.o_id}` : `name:${nameKey(ref.label) || fold(ref.label)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const row = collaborators.get(key) ?? { name: ref.label, o_id: ref.o_id, shared_items: 0, shared_publications: 0 };
          row[field]++;
          collaborators.set(key, row);
        }
      };

      const contributed: { ref: Record<string, unknown>; role: string }[] = [];
      for (const it of store.items) {
        const credit = it.contributors.find((c) => isPerson(c.name, c.o_id));
        if (!credit) continue;
        contributed.push({ ref: itemRef(it), role: credit.role || "Contributor" });
        tally(it.contributors.map((c) => ({ label: c.name, o_id: c.o_id })), "shared_items");
      }

      const pubs: { p: PublicationRec; role: "author" | "editor" }[] = [];
      for (const p of store.publications) {
        const role = pubRole(p, oId, canonical);
        if (!role) continue;
        pubs.push({ p, role });
        tally([...p.authors, ...p.editors], "shared_publications");
      }
      const topCollaborators = [...collaborators.values()]
        .sort((a, b) => b.shared_items + b.shared_publications - (a.shared_items + a.shared_publications) || a.name.localeCompare(b.name));

      return textResult({
        name: canonical,
        ...(name ? { query: name } : {}),
        found_in_authority_list: !!record,
        ...(record ? { id: String(record.o_id), omeka_id: record.o_id } : {}),
        affiliations: refLabels(record?.affiliations),
        identifiers: record?.identifiers ?? [],
        ...(record?.alt_names?.length ? { name_variants: record.alt_names } : {}),
        as_principal_investigator: asPI.map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, name: p.name, amira_url: itemUrl(p.o_id) })),
        as_member: asMember.map((p) => ({ id: String(p.o_id), omeka_id: p.o_id, name: p.name, amira_url: itemUrl(p.o_id) })),
        contributed_item_count: contributed.length,
        contributed_items: contributed.slice(0, 50).map(({ ref, role }) => ({ role, ...ref })),
        contributed_items_truncated: contributed.length > 50 || undefined,
        publication_count: pubs.length,
        publications: pubs.slice(0, 50).map(({ p, role }) => ({ role, ...publicationSummary(p) })),
        publications_truncated: pubs.length > 50 || undefined,
        collaborator_count: topCollaborators.length,
        top_collaborators: topCollaborators.slice(0, COLLABORATOR_CAP).map((c) => ({
          name: c.name, shared_items: c.shared_items, shared_publications: c.shared_publications, amira_url: itemUrlOrNull(c.o_id),
        })),
        amira_url: itemUrlOrNull(oId),
      });
    },
  );
}
