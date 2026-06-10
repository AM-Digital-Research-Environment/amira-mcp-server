// Follow-up probes over the cached census pages (no network) — answers the
// value-shape questions the summary stats can't: org type split, format
// resource/literal split, provenance, accessRights, temporal format, etc.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, "..", ".census-cache");

async function load(key) {
  const meta = JSON.parse(await fs.readFile(path.join(CACHE, `${key}-meta.json`), "utf8"));
  const items = [...meta.page1];
  for (let p = 2; ; p++) {
    try {
      items.push(...JSON.parse(await fs.readFile(path.join(CACHE, `${key}-p${p}.json`), "utf8")));
    } catch {
      break;
    }
  }
  return items;
}

const out = {};
const texts = (it, term) => (Array.isArray(it[term]) ? it[term].map((v) => String(v["@value"] ?? v.display_title ?? v["o:label"] ?? v["@id"] ?? "")) : []);

// 1. Organisation dcterms:type values (institution vs group?)
const orgs = await load("organisation");
const orgTypes = {};
for (const o of orgs) for (const t of texts(o, "dcterms:type")) orgTypes[t] = (orgTypes[t] ?? 0) + 1;
out.organisation_types = orgTypes;

// 2. Research items: dcterms:format split by value type; top labels each kind
const items = await load("research_item");
const fmtRes = {}, fmtLit = {};
let provSamples = new Set(), arSamples = new Set();
const typeLabels = {};
for (const it of items) {
  for (const v of it["dcterms:format"] ?? []) {
    const label = String(v["@value"] ?? v.display_title ?? "");
    if (!label) continue;
    if (v.value_resource_id != null) fmtRes[label] = (fmtRes[label] ?? 0) + 1;
    else fmtLit[label] = (fmtLit[label] ?? 0) + 1;
  }
  for (const v of it["dcterms:provenance"] ?? []) if (provSamples.size < 8) provSamples.add(String(v.display_title ?? v["@value"] ?? "").slice(0, 70));
  for (const v of it["dcterms:accessRights"] ?? []) if (arSamples.size < 8) arSamples.add(String(v.display_title ?? v["@value"] ?? "").slice(0, 70));
  for (const t of texts(it, "dcterms:type")) typeLabels[t] = (typeLabels[t] ?? 0) + 1;
}
const top = (o, n = 12) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));
out.format_resource_top = top(fmtRes);
out.format_literal_top = top(fmtLit);
out.provenance_samples = [...provSamples];
out.access_rights_samples = [...arSamples];
out.type_of_resource = top(typeLabels, 15);

// 3. one research item's date values raw (created interval example) + language value
for (const it of items) {
  const c = it["dcterms:created"]?.[0];
  if (c && it["dcterms:created"].length) {
    out.created_value_sample = it["dcterms:created"].map((v) => ({ type: v.type, value: v["@value"] }))[0];
    break;
  }
}
out.language_value_sample = items.find((i) => i["dcterms:language"])?.["dcterms:language"]?.slice(0, 2).map((v) => ({ type: v.type, rid: v.value_resource_id, label: v.display_title }));
out.spatial_value_sample = items.find((i) => i["dcterms:spatial"])?.["dcterms:spatial"]?.slice(0, 3).map((v) => ({ type: v.type, rid: v.value_resource_id, label: v.display_title ?? v["@value"] }));
out.subject_value_sample = items.find((i) => i["dcterms:subject"])?.["dcterms:subject"]?.slice(0, 2).map((v) => ({ type: v.type, rid: v.value_resource_id, label: v.display_title }));
out.replaces_sample = items.find((i) => i["dcterms:replaces"])?.["dcterms:replaces"]?.slice(0, 2).map((v) => ({ type: v.type, rid: v.value_resource_id, label: v.display_title }));

// 4. Projects: dre:id, temporal, creator samples; any institutions property?
const projects = await load("project");
out.project_sample = (() => {
  const p = projects.find((x) => texts(x, "dre:id")[0]?.startsWith("UBT_"));
  return {
    dre_id: texts(p, "dre:id")[0],
    temporal: p["dcterms:temporal"]?.map((v) => ({ type: v.type, value: v["@value"] })),
    creator: p["dcterms:creator"]?.slice(0, 2).map((v) => v.display_title),
    isPartOf: p["dcterms:isPartOf"]?.map((v) => v.display_title),
    fundedBy: p["frapo:isFundedBy"]?.map((v) => v.display_title),
    alternative: texts(p, "dcterms:alternative"),
  };
})();
out.project_ext = projects.filter((p) => texts(p, "dre:id")[0]?.startsWith("Ext_")).map((p) => ({ dre_id: texts(p, "dre:id")[0], title: p["o:title"], sections: p["dcterms:isPartOf"]?.map((v) => v.display_title) ?? [] }));

// 5. Publications: bibo:uri labels/order; identifier sample; authorList literal share
const pubs = await load("publications_set");
out.publication_sample = (() => {
  const p = pubs.find((x) => (x["bibo:uri"] ?? []).length > 1) ?? pubs[0];
  return {
    identifier: texts(p, "dcterms:identifier"),
    uris: (p["bibo:uri"] ?? []).map((v) => ({ id: v["@id"], label: v["o:label"] })),
    doi: (p["bibo:doi"] ?? []).map((v) => v["@id"]),
    isPartOf: texts(p, "dcterms:isPartOf"),
    authors: (p["bibo:authorList"] ?? []).slice(0, 3).map((v) => ({ type: v.type, rid: v.value_resource_id ?? null, label: v.display_title ?? v["@value"] })),
    date: p["dcterms:date"]?.map((v) => v["@value"]),
  };
})();

// 6. Languages set: title + alternative shapes
const langs = await load("languages_set");
out.languages = langs.map((l) => ({ o_id: l["o:id"], title: l["o:title"], alt: texts(l, "dcterms:alternative") })).slice(0, 30);

// 7. Sections: member literal vs resource; url
const secs = await load("research_section");
out.section_sample = secs.slice(0, 2).map((s) => ({
  title: s["o:title"],
  temporal: s["dcterms:temporal"]?.map((v) => v["@value"]),
  url: (s["fabio:hasURL"] ?? []).map((v) => v["@id"]),
  members_mixed: (s["foaf:member"] ?? []).slice(0, 3).map((v) => ({ type: v.type, label: v.display_title ?? v["@value"] })),
}));

// 8. Persons: isPartOf affiliation sample
const persons = await load("person");
out.person_sample = (() => {
  const p = persons.find((x) => x["dcterms:isPartOf"]);
  return { title: p["o:title"], affl: p["dcterms:isPartOf"].slice(0, 3).map((v) => ({ rid: v.value_resource_id, label: v.display_title })) };
})();

// 9. marcrel property labels actually used on research items
const report = JSON.parse(await fs.readFile(path.join(__dirname, "census-report.json"), "utf8"));
const used = Object.keys(report.targets.research_item.properties).filter((k) => k.startsWith("marcrel:"));
out.marcrel_labels = Object.fromEntries(used.map((t) => [t, report.propertyLabels[t] ?? "?"]));

console.log(JSON.stringify(out, null, 1));
