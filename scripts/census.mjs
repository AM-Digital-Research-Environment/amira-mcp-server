// Property census of the public Omeka S API (ROADMAP §2.2).
//
// Crawls every resource template / item set the server cares about, then reports
// per-property fill counts, value-type distributions, multiplicity and a sample —
// the evidence base for the field mapping in ROADMAP §2.4. Raw pages are cached
// under .census-cache/ so reruns are offline; pass --fresh to refetch.
//
//   node scripts/census.mjs [--fresh]
//
// Output: scripts/census-report.json (committed — rerun and diff after
// instance-side template changes) + a console summary.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CACHE = path.join(ROOT, ".census-cache");
const REPORT = path.join(__dirname, "census-report.json");

const SITE_BASE = (process.env.AMIRA_SITE_BASE || "https://data.africamultiple.uni-bayreuth.de").replace(/\/+$/, "");
const API = `${SITE_BASE}/api`;
const FRESH = process.argv.includes("--fresh");
const PER_PAGE = 100;
const CONCURRENCY = 4;

/** What to crawl. `rt` = resource_template_id, `set` = item_set_id. */
const TARGETS = [
  { key: "organisation", rt: 2 },
  { key: "location", rt: 3 },
  { key: "person", rt: 4 },
  { key: "project", rt: 5 },
  { key: "research_section", rt: 7 },
  { key: "research_item", rt: 10 },
  { key: "publications_set", set: 29918 },
  { key: "podcast", rt: 21 },
  { key: "video", rt: 22 },
  { key: "playlists_set", set: 39193 },
  { key: "languages_set", set: 19 },
  { key: "genres_set", set: 21 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, { withHeaders = false } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "amira-mcp-census/1.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!withHeaders) return body;
      return { body, total: Number(res.headers.get("omeka-s-total-results") ?? "0") };
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url}: ${err.message}`);
      await sleep(500 * attempt * attempt);
    }
  }
}

async function cached(name, fetcher) {
  const file = path.join(CACHE, `${name}.json`);
  if (!FRESH) {
    try {
      return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      /* miss */
    }
  }
  const data = await fetcher();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data));
  return data;
}

/** Crawl all pages of one target, with light concurrency across pages. */
async function crawl(target) {
  const query = target.rt != null ? `resource_template_id=${target.rt}` : `item_set_id=${target.set}`;
  const first = await cached(`${target.key}-meta`, async () => {
    const { body, total } = await fetchJSON(`${API}/items?${query}&per_page=${PER_PAGE}&page=1`, { withHeaders: true });
    return { total, page1: body };
  });
  const pages = Math.max(1, Math.ceil(first.total / PER_PAGE));
  const items = [...first.page1];
  const remaining = [];
  for (let p = 2; p <= pages; p++) remaining.push(p);

  let idx = 0;
  async function worker() {
    while (idx < remaining.length) {
      const p = remaining[idx++];
      const body = await cached(`${target.key}-p${p}`, async () => {
        await sleep(120);
        return fetchJSON(`${API}/items?${query}&per_page=${PER_PAGE}&page=${p}`);
      });
      items.push(...body);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, remaining.length || 1) }, worker));
  return { total: first.total, items };
}

/** All vocabulary properties (term -> label), for marcrel role labels etc. */
async function fetchPropertyLabels() {
  return cached("properties", async () => {
    const out = {};
    for (let p = 1; ; p++) {
      const body = await fetchJSON(`${API}/properties?per_page=${PER_PAGE}&page=${p}`);
      for (const prop of body) out[prop["o:term"]] = prop["o:label"];
      if (body.length < PER_PAGE) break;
      await sleep(120);
    }
    return out;
  });
}

function sampleOf(v) {
  const s =
    v["@value"] ?? v["display_title"] ?? v["o:label"] ?? v["@id"] ?? JSON.stringify(v);
  return String(s).slice(0, 90);
}

function censusOf(items) {
  const props = {};
  let withMedia = 0;
  let withThumb = 0;
  const itemSets = {};
  const classes = {};
  for (const it of items) {
    if ((it["o:media"] ?? []).length > 0) withMedia++;
    if (it["thumbnail_display_urls"]?.large) withThumb++;
    for (const s of it["o:item_set"] ?? []) itemSets[s["o:id"]] = (itemSets[s["o:id"]] ?? 0) + 1;
    const cls = it["o:resource_class"]?.["o:id"];
    if (cls != null) classes[cls] = (classes[cls] ?? 0) + 1;
    for (const [k, v] of Object.entries(it)) {
      if (k.startsWith("@") || k.startsWith("o:") || k === "thumbnail_display_urls") continue;
      if (!Array.isArray(v) || v.length === 0) continue;
      const rec = (props[k] ??= { n: 0, maxValues: 0, types: {}, sample: null });
      rec.n++;
      rec.maxValues = Math.max(rec.maxValues, v.length);
      for (const val of v) {
        const t = val.type ?? "?";
        rec.types[t] = (rec.types[t] ?? 0) + 1;
      }
      rec.sample ??= sampleOf(v[0]);
    }
  }
  const sorted = Object.fromEntries(Object.entries(props).sort((a, b) => b[1].n - a[1].n));
  return { properties: sorted, withMedia, withThumb, itemSets, classes };
}

async function resolveClassTerms(classIds) {
  const out = {};
  for (const id of classIds) {
    try {
      const cls = await cached(`class-${id}`, async () => fetchJSON(`${API}/resource_classes/${id}`));
      out[id] = cls["o:term"];
    } catch {
      out[id] = `class:${id}`;
    }
  }
  return out;
}

const report = { apiBase: API, generatedAt: new Date().toISOString(), targets: {} };
const allClassIds = new Set();

for (const target of TARGETS) {
  const { total, items } = await crawl(target);
  const c = censusOf(items);
  for (const id of Object.keys(c.classes)) allClassIds.add(Number(id));
  // template distribution inside set-based targets (e.g. publications 11-20)
  const templates = {};
  for (const it of items) {
    const t = it["o:resource_template"]?.["o:id"];
    if (t != null) templates[t] = (templates[t] ?? 0) + 1;
  }
  report.targets[target.key] = {
    query: target.rt != null ? `resource_template_id=${target.rt}` : `item_set_id=${target.set}`,
    total,
    fetched: items.length,
    templates,
    with_media: c.withMedia,
    with_thumbnail: c.withThumb,
    item_sets_top: Object.fromEntries(Object.entries(c.itemSets).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    classes: c.classes,
    properties: c.properties,
  };
  console.error(`[census] ${target.key}: ${items.length}/${total} items, ${Object.keys(c.properties).length} properties`);
}

report.classTerms = await resolveClassTerms([...allClassIds]);
report.propertyLabels = await fetchPropertyLabels();

await fs.writeFile(REPORT, JSON.stringify(report, null, 1));
console.error(`[census] report written to ${REPORT}`);

// Console digest: the questions ROADMAP §2.2 asks.
const ri = report.targets.research_item;
const dateProps = Object.keys(ri.properties).filter((k) => /date|created|issued|temporal|copyright/i.test(k));
console.log(JSON.stringify({
  research_item_total: ri.total,
  date_properties: Object.fromEntries(dateProps.map((k) => [k, ri.properties[k].n])),
  dre_id_coverage: ri.properties["dre:id"]?.n ?? 0,
  organisation_classes: report.targets.organisation.classes,
  class_terms: report.classTerms,
}, null, 1));
