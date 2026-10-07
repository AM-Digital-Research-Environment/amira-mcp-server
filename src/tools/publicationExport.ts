import type { PublicationRec } from "../types.js";
import type { CitationFormat } from "../citation.js";
import { publicationCitation } from "../publicationCitation.js";
import { itemUrl } from "../urls.js";
import { errorResult, textResult } from "./responses.js";

// Measure the complete compact JSON body in UTF-8; never cut an export entry.
// 44 KB keeps a page under the 50,000-character threshold above which Claude Code
// stores a tool result in a file instead of the conversation.
const EXPORT_BYTE_LIMIT = 44_000;

export function publicationExportPage(
  records: PublicationRec[], offset: number, limit: number, format: CitationFormat,
  extra: Record<string, unknown>,
) {
  const results: Record<string, unknown>[] = [];
  const envelope = () => ({
    ...extra, citation_format: format, count: results.length,
    total_matches: records.length, offset,
    has_more: offset + results.length < records.length,
    ...(offset + results.length < records.length ? { next_offset: offset + results.length } : {}),
    results,
  });
  const bytes = () => Buffer.byteLength(JSON.stringify({ ...envelope(), response_limited: true }), "utf8");
  if (bytes() > EXPORT_BYTE_LIMIT) {
    return errorResult("export_too_large", "Export filters exceed the response budget. Shorten the filter text.");
  }
  let responseLimited = false;
  for (const p of records.slice(offset, offset + limit)) {
    const citation = publicationCitation(p, format);
    results.push({
      id: String(p.o_id), omeka_id: p.o_id, amira_url: itemUrl(p.o_id),
      identifiers: [...new Set([p.pub_id, ...(p.identifiers ?? [])])],
      [citation.field]: citation.export,
    });
    if (bytes() > EXPORT_BYTE_LIMIT) {
      results.pop();
      if (!results.length) {
        return errorResult("export_too_large", `Publication ${p.o_id} exceeds the batch export budget. Read it individually with get_publication.`, {
          suggested_tool: "get_publication",
        });
      }
      responseLimited = true;
      break;
    }
  }
  return textResult({ ...envelope(), ...(responseLimited ? { response_limited: true } : {}) });
}
