// The optional GitHub-hosted enrichments a crawl fetches: DRE Visualizations'
// full-text map files and its corpus-vector releases.

import { config } from "../config.js";
import { FULLTEXT_SOURCE, parseFulltextMaps, type FulltextMaps } from "../fulltextMaps.js";
import { SEMANTIC_SOURCE, semanticBuild, servableSemantic, verifySemanticRelease, type SemanticNeighbours, type VerifiedRelease } from "../semantic.js";
import { fetchJSON, fetchRetrying } from "./http.js";

/** GitHub endpoints of the enrichments, or their stand-ins under AMIRA_ENRICHMENT_BASE (tests). */
const GITHUB = {
  raw: "https://raw.githubusercontent.com",
  api: "https://api.github.com",
  download: "https://github.com",
} as const;
const github = (host: keyof typeof GITHUB, pathname: string): string =>
  `${config.enrichmentBase ? `${config.enrichmentBase}/${host}` : GITHUB[host]}/${pathname}`;

/** Fetch the pinned full-text map files from the public repository (raw.githubusercontent.com). */
export async function fetchFulltextMaps(signal?: AbortSignal): Promise<FulltextMaps> {
  const { repository, tag, map, words } = FULLTEXT_SOURCE;
  const base = github("raw", `${repository}/${tag}/`);
  const [mapRes, wordsRes] = await Promise.all([fetchJSON<unknown>(base + map, signal), fetchJSON<unknown>(base + words, signal)]);
  return parseFulltextMaps({ source: { repository, tag, map, words }, map: mapRes.body, words: wordsRes.body });
}

/**
 * Download and verify a corpus-vector release. `setting` is a release tag to
 * pin, "latest" (the newest build whose manifest matches the accepted space;
 * older builds are tried when a newer one does not verify) or "off".
 */
export async function fetchSemanticRelease(setting: string, log: (msg: string) => void = () => {},
  signal?: AbortSignal): Promise<VerifiedRelease | null> {
  if (setting === "off") return null;
  const repo = SEMANTIC_SOURCE.repository;
  let tags: string[];
  if (setting === "latest") {
    // The API is the only listing of release tags. A token (CI) avoids the
    // anonymous rate limit; it is sent to api.github.com only.
    // Never to a stand-in host (AMIRA_ENRICHMENT_BASE).
    const token = config.enrichmentBase ? undefined : process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
    const releases = await fetchRetrying(github("api", `repos/${repo}/releases?per_page=100`),
      (res) => res.json() as Promise<{ tag_name?: unknown; draft?: unknown; prerelease?: unknown }[]>,
      { signal, headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    if (!Array.isArray(releases)) throw new Error("semantic release: the GitHub release listing is not an array");
    tags = releases.filter((r) => typeof r.tag_name === "string" && !r.draft && !r.prerelease && semanticBuild(r.tag_name) != null)
      .map((r) => r.tag_name as string).sort((a, b) => semanticBuild(b)! - semanticBuild(a)!).slice(0, 3);
    if (!tags.length) throw new Error("semantic release: no corpus-vector release found");
  } else {
    if (semanticBuild(setting) == null) {
      throw new Error("AMIRA_SEMANTIC_RELEASE must be \"latest\", \"off\" or a release tag such as semantic-embeddings-v1-35");
    }
    tags = [setting];
  }
  let lastError: Error | null = null;
  for (const tag of tags) {
    try {
      const asset = (name: string) => github("download", `${repo}/releases/download/${tag}/${name}`);
      const manifest = await fetchJSON<unknown>(asset("manifest.json"), signal);
      const ids = await fetchJSON<unknown>(asset("ids.json"), signal);
      const vectors = await fetchRetrying(asset("vectors.f32"), async (res) => new Uint8Array(await res.arrayBuffer()),
        { signal, timeoutMs: 180_000 });
      return verifySemanticRelease({ tag, manifest: manifest.body, ids: ids.body, vectors });
    } catch (err) {
      signal?.throwIfAborted();
      lastError = err as Error;
      if (setting !== "latest") break;
      log(`semantic release ${tag} skipped: ${lastError.message}`);
    }
  }
  throw lastError ?? new Error("semantic release: nothing to verify");
}

/**
 * The optional GitHub enrichments a crawl could not fetch (GitHub unreachable),
 * carried over from the snapshot being replaced: the server's live refresh
 * (the store it serves) and fetch-data (the snapshot on disk) both use it (#52).
 * Without this a crawl during a GitHub outage publishes a snapshot without
 * them, and nothing later notices they are missing.
 *  - The pinned full-text files never change: kept when the tag still matches.
 *  - The neighbours: kept when the semantic setting still serves them; they are
 *    filtered to the new snapshot at load, so a deleted record is never cited.
 * Returns what was carried, for the log.
 */
export function carryEnrichments(
  out: { fulltext?: FulltextMaps | null; semantic?: SemanticNeighbours | null },
  previous: { fulltext?: FulltextMaps | null; semantic?: SemanticNeighbours | null } | null,
  semanticSetting: string,
): string[] {
  const carried: string[] = [];
  if (!out.fulltext && previous?.fulltext?.source.tag === FULLTEXT_SOURCE.tag) {
    out.fulltext = previous.fulltext;
    carried.push(`full-text map ${previous.fulltext.source.tag}`);
  }
  const semantic = out.semantic ? null : servableSemantic(previous?.semantic, semanticSetting);
  if (semantic) {
    out.semantic = semantic;
    carried.push(`semantic neighbours ${semantic.source.tag}`);
  }
  return carried;
}
