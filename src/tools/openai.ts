// OpenAI / ChatGPT compatibility tools: `search` and `fetch`.
//
// ChatGPT's Deep Research + connector contract calls exactly two tools, with
// fixed names and shapes:
//   search(query)  -> { results: [{ id, title, url }] }
//   fetch(id)      -> { id, title, text, url, metadata }
// Both must return `structuredContent` alongside the JSON content array — which
// our `textResult` helper already does. These adapters sit OVER the same
// in-memory store the rich tools use; they are registered only on the remote
// HTTP transport (src/http.ts), so the stdio .mcpb keeps its 24-tool surface.
//
// `id` is typed as `<kind>:<key>` (item:<dre_id>, pub:<pub_id>, video:<o_id>,
// podcast:<o_id>) so fetch can route back to the right record.
import { z } from "zod";
import { ensureStore, UNIVERSITY_LABELS } from "../data.js";
import type { DataStore } from "../data.js";
import { annotate, capText, containsCI, refLabels, textResult, yearLabel, type Server } from "./_shared.js";
import { itemUrl } from "../urls.js";

const SEARCH_LIMIT = 20;

interface Hit {
  id: string;
  title: string;
  url: string;
  score: number;
}

/** Drop null/undefined/empty-array entries so metadata stays compact. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v != null && !(Array.isArray(v) && v.length === 0)),
  );
}

/** Join non-empty lines into one text body. */
function joinLines(...xs: (string | null | undefined | false)[]): string {
  return xs.filter((x): x is string => typeof x === "string" && x.length > 0).join("\n");
}

/** The topmost ancestor (country) of a place, for compact place labels. */
function placeWithCountry(store: DataStore, label: string, oId: number | null): string {
  const ancestors = store.locationAncestors(oId);
  const country = ancestors[ancestors.length - 1];
  return country && country !== label ? `${label} (${country})` : label;
}

/** Rank the readable corpora (items, publications, videos, podcasts) for a query. */
function runSearch(store: DataStore, query: string): Hit[] {
  const q = query.trim();
  if (!q) return [];
  const hits: Hit[] = [];

  for (const it of store.items) {
    let s = 0;
    if (containsCI(it.title, q)) s += 3;
    if (it.alt_titles.some((t) => containsCI(t, q))) s += 2;
    if (it.subjects.some((x) => containsCI(x.label, q))) s += 1;
    if (containsCI(it.abstract, q) || containsCI(it.description, q) || containsCI(it.toc, q)) s += 1;
    if (it.contributors.some((c) => containsCI(c.name, q))) s += 1;
    if (it.identifiers.some((d) => containsCI(d, q)) || it.dre_id.toLowerCase() === q.toLowerCase()) s += 2;
    if (s > 0) hits.push({ id: `item:${it.dre_id}`, title: it.title, url: itemUrl(it.o_id), score: s });
  }

  for (const p of store.publications) {
    let s = 0;
    if (containsCI(p.title, q)) s += 3;
    if (p.authors.some((a) => containsCI(a.label, q)) || p.editors.some((e) => containsCI(e.label, q))) s += 1;
    if (containsCI(p.abstract, q) || containsCI(p.venue, q)) s += 1;
    if (p.subjects.some((x) => containsCI(x.label, q))) s += 1;
    if (s > 0) hits.push({ id: `pub:${p.pub_id}`, title: p.title, url: p.doi ?? p.urls[0] ?? itemUrl(p.o_id), score: s });
  }

  for (const v of store.videos) {
    let s = 0;
    if (containsCI(v.title, q)) s += 3;
    if (containsCI(v.abstract, q)) s += 1;
    if (containsCI(v.transcript, q)) s += 2; // transcript hits are the point of video search
    if (v.speakers.some((c) => containsCI(c.name, q))) s += 1;
    if (s > 0) hits.push({ id: `video:${v.o_id}`, title: v.title, url: v.url ?? itemUrl(v.o_id), score: s });
  }

  for (const p of store.podcasts) {
    let s = 0;
    if (containsCI(p.title, q)) s += 3;
    if (containsCI(p.abstract, q)) s += 1;
    if (containsCI(p.transcript, q)) s += 2;
    if (p.people.some((c) => containsCI(c.name, q))) s += 1;
    if (s > 0) hits.push({ id: `podcast:${p.o_id}`, title: p.title, url: p.url ?? itemUrl(p.o_id), score: s });
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, SEARCH_LIMIT);
}

function fetchDoc(store: DataStore, id: string): Record<string, unknown> {
  const sep = id.indexOf(":");
  const kind = sep === -1 ? id : id.slice(0, sep);
  const key = sep === -1 ? "" : id.slice(sep + 1);
  const notFound = { error: `No record with id '${id}'. Use the search tool to obtain valid ids.` };

  if (kind === "item") {
    const it = store.getItem(key);
    if (!it) return notFound;
    const project = store.projectOf(it);
    const text = joinLines(
      `Title: ${it.title}`,
      it.alt_titles.length ? `Alternative titles: ${it.alt_titles.join("; ")}` : null,
      it.type ? `Type: ${it.type}` : null,
      `University: ${UNIVERSITY_LABELS[it.university]}`,
      project ? `Project: ${project.name}` : it.project ? `Project: ${it.project.label}` : null,
      it.contributors.length
        ? `Contributors: ${it.contributors.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}`
        : null,
      yearLabel(it) ? `Date: ${yearLabel(it)}` : null,
      it.subjects.length ? `Subjects: ${refLabels(it.subjects).join("; ")}` : null,
      it.places.length ? `Places: ${it.places.map((p) => placeWithCountry(store, p.label, p.o_id)).join("; ")}` : null,
      refLabels(it.languages).length ? `Languages: ${refLabels(it.languages).join("; ")}` : null,
      refLabels(it.formats).length ? `Formats: ${refLabels(it.formats).join("; ")}` : null,
      it.sponsors.length ? `Sponsors: ${it.sponsors.join("; ")}` : null,
      it.provenance.length ? `Provenance: ${it.provenance.join("; ")}` : null,
      it.abstract ? `\nAbstract:\n${it.abstract}` : null,
      it.description ? `\nDescription:\n${it.description}` : null,
      it.toc ? `\nTable of contents:\n${it.toc}` : null,
    );
    const { text: body, truncated } = capText(text);
    return {
      id,
      title: it.title,
      text: body,
      url: itemUrl(it.o_id),
      metadata: compact({
        kind: "research_item",
        dre_id: it.dre_id,
        type: it.type,
        university: UNIVERSITY_LABELS[it.university],
        project_id: project?.dre_id ?? null,
        date: yearLabel(it),
        subjects: refLabels(it.subjects),
        places: it.places.map((p) => p.label),
        has_media: it.has_media,
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "pub") {
    const p = store.getPublication(key);
    if (!p) return notFound;
    const cite = [p.volume && `Vol. ${p.volume}`, p.issue && `No. ${p.issue}`, p.pages && `pp. ${p.pages}`]
      .filter(Boolean)
      .join(", ");
    const text = joinLines(
      `Title: ${p.title}`,
      `Type: ${p.type}`,
      p.authors.length ? `Authors: ${refLabels(p.authors).join("; ")}` : null,
      p.editors.length ? `Editors: ${refLabels(p.editors).join("; ")}` : null,
      p.venue ? `Venue: ${p.venue}` : null,
      p.year ? `Year: ${p.year}` : null,
      cite || null,
      p.publisher ? `Publisher: ${p.publisher}` : null,
      p.doi ? `DOI: ${p.doi}` : null,
      p.abstract ? `\nAbstract:\n${p.abstract}` : null,
    );
    const { text: body, truncated } = capText(text);
    return {
      id,
      title: p.title,
      text: body,
      url: p.doi ?? p.urls[0] ?? itemUrl(p.o_id),
      metadata: compact({
        kind: "publication",
        pub_id: p.pub_id,
        type: p.type,
        year: p.year,
        authors: refLabels(p.authors),
        venue: p.venue,
        doi: p.doi,
        amira_url: itemUrl(p.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "video") {
    const v = store.getVideo(Number(key));
    if (!v) return notFound;
    const text = joinLines(
      `Title: ${v.title}`,
      v.date ? `Date: ${v.date}` : null,
      v.speakers.length ? `Speakers: ${v.speakers.map((c) => c.name).join("; ")}` : null,
      v.playlists.length ? `Playlists: ${refLabels(v.playlists).join("; ")}` : null,
      v.url ? `Watch: ${v.url}` : null,
      v.abstract ? `\nDescription:\n${v.abstract}` : null,
      v.transcript ? `\nTranscript:\n${v.transcript}` : null,
    );
    const { text: body, truncated } = capText(text);
    return {
      id,
      title: v.title,
      text: body,
      url: v.url ?? itemUrl(v.o_id),
      metadata: compact({
        kind: "youtube_video",
        date: v.date,
        playlists: refLabels(v.playlists),
        speakers: v.speakers.map((c) => c.name),
        has_transcript: !!v.transcript,
        amira_url: itemUrl(v.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  if (kind === "podcast") {
    const p = store.getPodcast(Number(key));
    if (!p) return notFound;
    const text = joinLines(
      `Title: ${p.title}`,
      p.series ? `Series: ${p.series.label}` : null,
      p.episode != null ? `Episode: ${p.episode}` : null,
      p.date ? `Date: ${p.date}` : null,
      p.people.length ? `People: ${p.people.map((c) => (c.role ? `${c.name} (${c.role})` : c.name)).join("; ")}` : null,
      p.url ? `Listen: ${p.url}` : null,
      p.abstract ? `\nDescription:\n${p.abstract}` : null,
      p.transcript ? `\nTranscript:\n${p.transcript}` : null,
    );
    const { text: body, truncated } = capText(text);
    return {
      id,
      title: p.title,
      text: body,
      url: p.url ?? itemUrl(p.o_id),
      metadata: compact({
        kind: "podcast",
        series: p.series?.label ?? null,
        episode: p.episode,
        date: p.date,
        has_transcript: !!p.transcript,
        amira_url: itemUrl(p.o_id),
        truncated: truncated || undefined,
      }),
    };
  }

  return notFound;
}

export function registerOpenAITools(server: Server): void {
  // === search ===============================================================
  server.registerTool(
    "search",
    {
      title: "Search the AMIRA collection",
      description:
        "Search the Africa Multiple (AMIRA) research collection and return matching records as a ranked " +
        "list. Covers research items (digitised artefacts), the cluster bibliography, and podcast + " +
        "YouTube-video records (keyword reaches INTO video/podcast transcripts). Returns " +
        "{ results: [{ id, title, url }] }; pass an `id` to the fetch tool for the full record text. " +
        "This is the ChatGPT/OpenAI-compatible entry point; richer filtered tools are also available.",
      annotations: annotate("Search the AMIRA collection"),
      inputSchema: { query: z.string().describe("Search terms, e.g. 'Yoruba architecture' or 'decoloniality'") },
    },
    async ({ query }) => {
      const store = await ensureStore();
      const results = runSearch(store, query).map((h) => ({ id: h.id, title: h.title, url: h.url }));
      return textResult({ results });
    },
  );

  // === fetch ================================================================
  server.registerTool(
    "fetch",
    {
      title: "Fetch one AMIRA record",
      description:
        "Retrieve the full text and metadata of one AMIRA record by the `id` returned from the search tool " +
        "(e.g. 'item:abg-99-0000', 'pub:eref-94882', 'video:39218', 'podcast:39121'). Returns " +
        "{ id, title, text, url, metadata } — `text` concatenates the record's descriptive fields (and the " +
        "full transcript for videos/podcasts), `url` is the citable public page, capped at 25,000 characters.",
      annotations: annotate("Fetch one AMIRA record"),
      inputSchema: { id: z.string().describe("A typed record id from search, e.g. 'item:abg-99-0000'") },
    },
    async ({ id }) => {
      const store = await ensureStore();
      return textResult(fetchDoc(store, id));
    },
  );
}
