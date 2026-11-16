// What counts as a person's credit on a record, shared by get_person
// (top_collaborators), find_related (related_people) and get_entity_graph
// (co-occurrence). Each used its own definition, so the three disagreed: an
// organisation credited as a contributor ("Government of …") was listed among
// find_related's people, and a podcast's sound engineer counted as a shared
// record in two tools but not in the third.
import type { DataStore } from "./data.js";
import { fold } from "./text.js";
import type { LinkedRef } from "./types.js";

/**
 * Credits that place a person on a record without sharing its work: production
 * crew and custodial or sponsoring roles. Until v1.29.0 a podcast's sound
 * engineer was listed among the speakers' collaborators, and an answer passed
 * that on to the researcher it described.
 */
const NON_COLLABORATIVE_ROLES = new Set([
  "Sound engineer", "Transcriber", "Repository", "Sponsor", "Publisher", "Provider",
  "Copyright holder", "Owner", "Former owner", "Patron",
].map(fold));

/** True for a role that shares the record's work (an absent role counts). */
export const collaborativeRole = (role: string | null | undefined): boolean => !role || !NON_COLLABORATIVE_ROLES.has(fold(role));

/** True when the credit's linked record is an organisation (an institution, a group, a company). */
export const isOrganisationCredit = (store: DataStore, oId: number | null | undefined): boolean =>
  oId != null && store.getOrganisationByOId(oId) != null;

/** A credit as a person credit: a person (not an organisation) in a collaborative role. */
export const isPersonCredit = (store: DataStore, credit: { o_id: number | null; role?: string | null }): boolean =>
  collaborativeRole(credit.role) && !isOrganisationCredit(store, credit.o_id);

/** The person credits among `credits` (contributors, speakers, authors…), as linked refs. */
export function personCredits(store: DataStore, credits: readonly { name?: string; label?: string; o_id: number | null; role?: string | null }[]): LinkedRef[] {
  const out: LinkedRef[] = [];
  for (const c of credits) if (isPersonCredit(store, c)) out.push({ label: c.name ?? c.label ?? "", o_id: c.o_id });
  return out;
}
