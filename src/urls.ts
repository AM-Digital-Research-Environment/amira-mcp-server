// The citation URL builder (issue #1 D3/D5). Every entity the server returns is
// an Omeka S item, so there is exactly one citable URL shape: the public item
// page on the amira site. Emitted as `amira_url` on every record; the pre-1.0
// dashboard URL scheme is gone.
import { SITE_BASE, SITE_SLUG } from "./config.js";

/** Public page for any Omeka item: `<site>/s/amira/item/<o:id>`. */
export function itemUrl(oId: number): string {
  return `${SITE_BASE}/s/${SITE_SLUG}/item/${oId}`;
}

/** `amira_url` for records that may lack a resolved item id. */
export function itemUrlOrNull(oId: number | null | undefined): string | null {
  return oId == null ? null : itemUrl(oId);
}
