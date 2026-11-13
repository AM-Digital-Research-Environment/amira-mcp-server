// A node:http stand-in for the Omeka S REST API with private content, for the
// curator-mode tests (#26). It serves raw JSON-LD the way Omeka does:
//
//   - anonymous requests never see a private resource (`o:is_public: false`) or
//     a private value (`is_public: false`, also inside value annotations);
//   - a request carrying the right key_identity/key_credential sees everything;
//   - a wrong, revoked or mistyped key is NOT an error: like real Omeka, it gets
//     the anonymous data with HTTP 200 (checked against production, Nov 2026);
//   - `is_public=0` on /items filters to private items, so it returns `[]` to
//     anyone who cannot see them: the curator server's authentication probe.
//
// Like Omeka, it builds the URLs it returns (`@id`, `o:original_url`,
// thumbnails) from the request's Host, so a server fetching it over an internal
// base sees internal URLs and must rewrite them to its public site.
//
// `state` changes that: `keyAccepted: false` treats even the right key as
// unknown (revoked mid-life); `viewAll: false` lets the right key see only
// public data (a user without view-all); mode "leak" serves private content to
// anonymous requests too (the public server must still drop it: defence in
// depth); mode "deny" answers every keyed request with `state.denyStatus`
// (401 by default), for proxies or future Omeka versions that do refuse.
//
// The fixtures are the ones the issue's validation plan asks for: one private
// research item, and one public item with a private `dre:security` value, a
// private description and a private `bibo:content` (the ILAM OCR case). A
// private publication, a public publication with a private full text, a
// private person credited on the public item, a private item set and a private
// media file cover exports, references and collections.
import { createServer } from "node:http";

export const KEY = { identity: "stubKeyIdentity0123456789abcdef", credential: "stubKeyCredential9876543210fedcba" };

/** Distinctive strings, each only in private content. A public server must never return any of them. */
export const PRIVATE = {
  itemTitle: "Secret Art Worlds Interview",
  itemToken: "quokka-private-item-token",
  description: "zebra-private-description-token",
  security: "DSL4",
  mongoId: "665f00aa11bb22cc33dd44ee",
  bitstream: "bitstream-private-0001.tif",
  fulltext: "okapi-private-fulltext-token",
  generatedBy: "Private OCR Engine",
  personName: "Hidden, Person",
  pubTitle: "Private Working Paper",
  pubText: "pangolin-private-pubtext-token",
  setTitle: "Of Art Worlds (private set)",
  mediaUrl: "private-scan.tif",
};

export const IDS = { privateItem: 7101, publicItem: 7102, plainItem: 7103, project: 7001, privatePerson: 7401, publicPerson: 7402,
  privatePub: 7201, publicPub: 7202, privateSet: 6259, publicSet: 8001, privateMedia: 9901, publicMedia: 9902 };

const MODIFIED = "2026-11-01T00:00:00+00:00";
const lit = (v, extra = {}) => ({ type: "literal", "@value": v, is_public: true, ...extra });
/** Replaced by `http://<request Host>` when served, as Omeka builds its URLs from the request. */
const BASE = "{{BASE}}";
const res = (id, title, extra = {}) => ({ type: "resource:item", "@id": `${BASE}/api/items/${id}`, value_resource_id: id,
  display_title: title, is_public: true, ...extra });
const stamp = { "o:created": { "@value": "2026-10-01T00:00:00+00:00" }, "o:modified": { "@value": MODIFIED } };

/** [corpus query, raw item]. */
const ITEMS = [
  ["resource_template_id=5", { "o:id": IDS.project, "o:is_public": true, "o:title": "Curator Fixture Project", ...stamp,
    "dcterms:title": [lit("Curator Fixture Project")], "dre:id": [lit("UBT_CuratorFixture2019")] }],
  ["resource_template_id=4", { "o:id": IDS.privatePerson, "o:is_public": false, "o:title": PRIVATE.personName, ...stamp,
    "dcterms:title": [lit(PRIVATE.personName)] }],
  ["resource_template_id=4", { "o:id": IDS.publicPerson, "o:is_public": true, "o:title": "Visible, Person", ...stamp,
    "dcterms:title": [lit("Visible, Person")] }],
  ["resource_template_id=10", { "o:id": IDS.privateItem, "o:is_public": false, "o:title": PRIVATE.itemTitle, ...stamp,
    "o:item_set": [{ "o:id": IDS.privateSet }],
    "dcterms:title": [lit(PRIVATE.itemTitle)], "dcterms:type": [lit("Text")],
    "dcterms:description": [lit(`A private item: ${PRIVATE.itemToken}.`)],
    "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")], "dre:id": [lit("UBT_CuratorFixture2019_0001")],
    "dcterms:created": [lit("1975")] }],
  ["resource_template_id=10", { "o:id": IDS.publicItem, "o:is_public": true, "o:title": "Public Field Recording", ...stamp,
    "o:item_set": [{ "o:id": IDS.publicSet }],
    "o:media": [{ "o:id": IDS.publicMedia }, { "o:id": IDS.privateMedia }],
    thumbnail_display_urls: { large: `${BASE}/files/large/public-recording.jpg` },
    "dcterms:title": [lit("Public Field Recording")], "dcterms:type": [lit("Audio")],
    "dcterms:description": [lit("A public description of the recording."), lit(`Curator note: ${PRIVATE.description}.`, { is_public: false })],
    "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")], "dre:id": [lit("UBT_CuratorFixture2019_0002")],
    "marcrel:col": [res(IDS.publicPerson, "Visible, Person"), res(IDS.privatePerson, PRIVATE.personName)],
    "dcterms:created": [lit("1981")],
    "dre:security": [lit(PRIVATE.security, { is_public: false })],
    "dre:mongoId": [lit(PRIVATE.mongoId, { is_public: false })],
    "dre:bitstream": [lit(PRIVATE.bitstream, { is_public: false })],
    "bibo:content": [lit(`Page 1. The ${PRIVATE.fulltext} appears in the OCR text of this article.`, {
      is_public: false, "@annotation": { "dre:generatedBy": [{ type: "literal", "@value": PRIVATE.generatedBy, is_public: false }] },
    })] }],
  ["resource_template_id=10", { "o:id": IDS.plainItem, "o:is_public": true, "o:title": "Plain Public Item", ...stamp,
    "dcterms:title": [lit("Plain Public Item")], "dcterms:type": [lit("Image")],
    "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")], "dcterms:created": [lit("1990")] }],
  ["item_set_id=29918", { "o:id": IDS.privatePub, "o:is_public": false, "o:title": PRIVATE.pubTitle, ...stamp,
    "o:resource_class": { "o:id": 1 },
    "dcterms:title": [lit(PRIVATE.pubTitle)], "dcterms:identifier": [lit("eref-990001")], "dcterms:date": [lit("2025")],
    "bibo:authorList": [res(IDS.publicPerson, "Visible, Person")] }],
  ["item_set_id=29918", { "o:id": IDS.publicPub, "o:is_public": true, "o:title": "Public Article", ...stamp,
    "o:resource_class": { "o:id": 1 },
    "dcterms:title": [lit("Public Article")], "dcterms:identifier": [lit("eref-990002")], "dcterms:date": [lit("2024")],
    "bibo:content": [lit(`Full text: ${PRIVATE.pubText} in a private extraction.`, { is_public: false })] }],
];

const ITEM_SETS = [
  { "o:id": IDS.publicSet, "o:is_public": true, "o:title": "Curator Fixture Collection", ...stamp,
    "dcterms:title": [lit("Curator Fixture Collection")], "dcterms:isPartOf": [res(IDS.project, "Curator Fixture Project")] },
  { "o:id": IDS.privateSet, "o:is_public": false, "o:title": PRIVATE.setTitle, ...stamp, "dcterms:title": [lit(PRIVATE.setTitle)] },
];

const MEDIA = [
  { "o:id": IDS.publicMedia, "o:is_public": true, "o:item": { "o:id": IDS.publicItem }, "o:media_type": "audio/mpeg",
    "o:original_url": `${BASE}/files/original/public-recording.mp3`, "o:source": "recording.mp3", "o:size": 1000 },
  { "o:id": IDS.privateMedia, "o:is_public": false, "o:item": { "o:id": IDS.publicItem }, "o:media_type": "image/tiff",
    "o:original_url": `${BASE}/files/original/${PRIVATE.mediaUrl}`, "o:source": "private-scan.tif", "o:size": 2000 },
];

// Every resource carries its own API URL, as Omeka's JSON-LD does.
for (const [, item] of ITEMS) item["@id"] = `${BASE}/api/items/${item["o:id"]}`;
for (const set of ITEM_SETS) set["@id"] = `${BASE}/api/item_sets/${set["o:id"]}`;
for (const m of MEDIA) m["@id"] = `${BASE}/api/media/${m["o:id"]}`;

/** A resource as an anonymous visitor sees it: private values (and private annotation values) removed. */
function anonymous(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (!Array.isArray(value) || key.startsWith("o:")) {
      out[key] = value;
      continue;
    }
    const kept = value.filter((v) => v?.is_public !== false).map((v) => {
      if (!v?.["@annotation"]) return v;
      const ann = Object.fromEntries(Object.entries(v["@annotation"])
        .map(([t, list]) => [t, list.filter((a) => a?.is_public !== false)]).filter(([, list]) => list.length));
      const { "@annotation": _drop, ...rest } = v;
      return Object.keys(ann).length ? { ...rest, "@annotation": ann } : rest;
    });
    if (kept.length) out[key] = kept;
  }
  return out;
}

/**
 * Start the stub. `state`: { mode: "auth" | "leak" | "deny" | "down", denyStatus }.
 * Returns { base, api, state, requests, close() }; `requests` holds every
 * request target exactly as received (path and query).
 */
export async function startOmekaStub(state = {}) {
  state.mode ??= "auth";
  state.denyStatus ??= 401;
  state.keyAccepted ??= true;
  state.viewAll ??= true;
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const url = new URL(req.url, "http://stub");
    const keyed = url.searchParams.has("key_identity") || url.searchParams.has("key_credential");
    const reply = (status, body, total) => {
      res.writeHead(status, { "Content-Type": "application/json", Connection: "close",
        ...(total !== undefined ? { "Omeka-S-Total-Results": String(total) } : {}) });
      res.end(JSON.stringify(body).replaceAll(BASE, `http://${req.headers.host}`));
    };
    if (!url.pathname.startsWith("/api/")) return reply(404, {});
    // Omeka (or the proxy in front of it) briefly down: every API request fails.
    if (state.mode === "down") return reply(502, { error: "Bad Gateway" });
    if (keyed && state.mode === "deny") return reply(state.denyStatus, { errors: { error: "Invalid API key" } });
    // An unknown key is silently ignored, as Omeka does: the request is served as anonymous.
    const validKey = state.keyAccepted && url.searchParams.get("key_identity") === KEY.identity &&
      url.searchParams.get("key_credential") === KEY.credential;
    const sees = (validKey && state.viewAll) || state.mode === "leak";
    const show = (list) => (sees ? list : list.filter((r) => r["o:is_public"] !== false).map(anonymous));
    const page = Number(url.searchParams.get("page") ?? 1);
    const probe = url.searchParams.get("sort_by") === "modified";
    switch (url.pathname) {
      case "/api/items": {
        if (probe) {
          const all = show(ITEMS.map(([, item]) => item));
          return reply(200, all.slice(0, 1), all.length);
        }
        const corpusKeys = ["resource_template_id", "item_set_id"].filter((k) => url.searchParams.has(k));
        let matching = show(ITEMS.filter(([query]) => {
          if (!corpusKeys.length) return true;
          const [k, v] = query.split("=");
          return url.searchParams.get(k) === v;
        }).map(([, item]) => item));
        const isPublic = url.searchParams.get("is_public");
        if (isPublic === "0") matching = matching.filter((r) => r["o:is_public"] === false);
        if (isPublic === "1") matching = matching.filter((r) => r["o:is_public"] !== false);
        const perPage = Number(url.searchParams.get("per_page") ?? 100);
        return reply(200, page === 1 ? matching.slice(0, perPage) : [], matching.length);
      }
      case "/api/item_sets": {
        const sets = show(ITEM_SETS);
        return reply(200, probe ? sets.slice(0, 1) : page === 1 ? sets : [], sets.length);
      }
      case "/api/media":
        return reply(200, page === 1 ? show(MEDIA) : []);
      case "/api/properties":
        return reply(200, page === 1 ? [{ "o:term": "marcrel:col", "o:label": "Collector" }] : []);
      case "/api/resource_classes/1":
        return reply(200, { "o:id": 1, "o:term": "fabio:WorkingPaper" });
      default:
        return reply(404, {});
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, api: `${base}/api`, state, requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}
