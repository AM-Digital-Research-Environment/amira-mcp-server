// In-memory data store for the Africa Multiple research data.
//
// The whole queryable core is ~16 MB of JSON, so — unlike the IWAC server's
// DuckDB/parquet approach — we simply load it into memory and build a handful of
// indexes. Two data planes keep this offline-safe for wide public distribution:
//
//   1. A JSON snapshot is BUNDLED in the .mcpb (config.bundledDataDir). The
//      server is fully usable from this alone, with no network and no backend database.
//   2. When config.liveRefresh is on, a background task compares the bundled/
//      cached snapshot's `generatedAt` against the PUBLIC dashboard JSON and,
//      if newer, downloads it into config.cacheDir and hot-swaps the store.
//
// This server contacts no backend database; it reads only the bundled snapshot
// and the dashboard's public JSON.

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { transformMongoJSON, normaliseItemLocation } from "./mongoJSON.js";
import type {
  CollectionItem,
  DataManifest,
  GeoLocation,
  Group,
  Institution,
  Person,
  Project,
  Publication,
  ResearchSection,
  University,
} from "./types.js";

// --- External collections (virtual projects, mirrors dashboard external.ts) ---

const EXTERNAL_SECTION = "External";

const EXTERNAL_PROJECTS: Project[] = [
  {
    _id: "Ext_BayGlo2025",
    id: "Ext_BayGlo2025",
    idShort: "BayGlo2025",
    locale: "Bayreuth",
    localeCode: 0,
    researchSection: [EXTERNAL_SECTION],
    name: "Bayreuth Global / Bayreuth Postkolonial",
    pi: [],
    members: [],
    emails: [],
    description:
      "External collection contributed by the Bayreuth Global / Bayreuth Postkolonial project at the University of Bayreuth.",
    date: { start: "2025-01-01T00:00:00.000Z", end: "2025-12-31T00:00:00.000Z" },
    createdAt: null,
    updatedAt: "",
    updatedBy: "",
    institutions: ["University of Bayreuth"],
    university: "external",
  },
  {
    _id: "Ext_ILAM",
    id: "Ext_ILAM",
    idShort: "ILAM",
    locale: "Makhanda",
    localeCode: 0,
    researchSection: [EXTERNAL_SECTION],
    name: "International Library of African Music (ILAM)",
    pi: [],
    members: [],
    emails: [],
    description:
      "External collection sourced from the International Library of African Music (ILAM) at Rhodes University.",
    date: { start: "1954-01-01T00:00:00.000Z", end: null },
    createdAt: null,
    updatedAt: "",
    updatedBy: "",
    institutions: ["Rhodes University"],
    university: "external",
  },
];

const EXTERNAL_COLLECTION_TO_PROJECT: Record<string, Project> = {
  BayGlo2025: EXTERNAL_PROJECTS[0]!,
  ILAM: EXTERNAL_PROJECTS[1]!,
};

// --- Fixed dev/ file set the server actually needs (drops wisski_urls etc.) ---

const DEV_FILES = [
  "dev.persons.json",
  "dev.institutions.json",
  "dev.groups.json",
  "dev.researchSections.json",
  "dev.geo.json",
  "dev.projectsData.json",
] as const;

export function uniFromProjectId(id: string): University {
  if (id.startsWith("UBT_")) return "ubt";
  if (id.startsWith("ULG_")) return "unilag";
  if (id.startsWith("UJKZ_")) return "ujkz";
  if (id.startsWith("UFB_")) return "ufba";
  return "external";
}

export const UNIVERSITY_LABELS: Record<University, string> = {
  ubt: "University of Bayreuth",
  unilag: "University of Lagos",
  ujkz: "Université Joseph Ki-Zerbo",
  ufba: "Federal University of Bahia",
  external: "External collection",
};

interface RawGeo {
  countries: Record<string, [number, number]>;
  regions: Record<string, [number, number]>;
  cities: Record<string, [number, number]>;
}

// -----------------------------------------------------------------------------
// DataStore
// -----------------------------------------------------------------------------

export class DataStore {
  readonly source: "bundled" | "cache";
  readonly generatedAt: string;
  readonly persons: Person[];
  readonly institutions: Institution[];
  readonly groups: Group[];
  readonly projects: Project[];
  readonly researchSections: ResearchSection[];
  readonly items: CollectionItem[];
  readonly publications: Publication[];
  private readonly geo: RawGeo;

  private readonly itemByDreId = new Map<string, CollectionItem>();
  private readonly itemsByProjectId = new Map<string, CollectionItem[]>();
  private readonly projectById = new Map<string, Project>();
  private readonly personByName = new Map<string, Person>();
  private readonly institutionByName = new Map<string, Institution>();
  private readonly groupByName = new Map<string, Group>();
  private readonly sectionByName = new Map<string, ResearchSection>();

  constructor(opts: {
    source: "bundled" | "cache";
    generatedAt: string;
    persons: Person[];
    institutions: Institution[];
    groups: Group[];
    projects: Project[];
    researchSections: ResearchSection[];
    items: CollectionItem[];
    publications: Publication[];
    geo: RawGeo;
  }) {
    this.source = opts.source;
    this.generatedAt = opts.generatedAt;
    this.persons = opts.persons;
    this.institutions = opts.institutions;
    this.groups = opts.groups;
    this.projects = opts.projects;
    this.researchSections = opts.researchSections;
    this.items = opts.items;
    this.publications = opts.publications;
    this.geo = opts.geo;

    for (const it of this.items) {
      if (it.dre_id) this.itemByDreId.set(it.dre_id, it);
      const pid = it.project?.id;
      if (pid) {
        const list = this.itemsByProjectId.get(pid);
        if (list) list.push(it);
        else this.itemsByProjectId.set(pid, [it]);
      }
    }
    for (const p of this.projects) this.projectById.set(p.id, p);
    for (const p of this.persons) this.personByName.set(p.name.toLowerCase(), p);
    for (const i of this.institutions) this.institutionByName.set(i.name.toLowerCase(), i);
    for (const g of this.groups) this.groupByName.set(g.name.toLowerCase(), g);
    for (const s of this.researchSections) this.sectionByName.set(s.name.toLowerCase(), s);
  }

  getItem(dreId: string): CollectionItem | undefined {
    return this.itemByDreId.get(dreId);
  }
  getProject(id: string): Project | undefined {
    return this.projectById.get(id);
  }
  getPerson(name: string): Person | undefined {
    return this.personByName.get(name.toLowerCase());
  }
  getInstitution(name: string): Institution | undefined {
    return this.institutionByName.get(name.toLowerCase());
  }
  getGroup(name: string): Group | undefined {
    return this.groupByName.get(name.toLowerCase());
  }
  getSection(name: string): ResearchSection | undefined {
    return this.sectionByName.get(name.toLowerCase());
  }
  itemsForProject(id: string): CollectionItem[] {
    return this.itemsByProjectId.get(id) ?? [];
  }

  /** Coordinates for a place, matched against the slim geo lookup. */
  coordsFor(name: string, level: "country" | "region" | "city", country?: string): GeoLocation | null {
    const table =
      level === "country" ? this.geo.countries : level === "region" ? this.geo.regions : this.geo.cities;
    const key = level === "country" ? name : country ? `${name}|${country}` : name;
    const hit = table[key] ?? (level !== "country" ? table[name] : undefined);
    if (!hit) return null;
    return { name, latitude: hit[0] ?? null, longitude: hit[1] ?? null };
  }
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

async function readJSON<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, "utf8");
  return JSON.parse(raw) as T;
}

/** Relative paths (POSIX) of every data file implied by a manifest. */
function dataFileList(manifest: DataManifest): string[] {
  const files: string[] = ["manifest.json", "publications.json"];
  for (const f of DEV_FILES) files.push(`dev/${f}`);
  for (const [uni, ids] of Object.entries(manifest.universities ?? {})) {
    const folder = `projects_metadata_${uni}`;
    for (const id of ids) files.push(`${folder}/${folder}.${id}.json`);
  }
  for (const [folder, names] of Object.entries(manifest.external ?? {})) {
    for (const name of names) files.push(`${folder}/${folder}.${name}.json`);
  }
  return files;
}

/** Build a DataStore from a directory containing the snapshot. */
export async function loadFromDir(dir: string, source: "bundled" | "cache"): Promise<DataStore> {
  const manifest = await readJSON<DataManifest>(path.join(dir, "manifest.json"));

  const persons = transformMongoJSON<Person[]>(await readJSON(path.join(dir, "dev", "dev.persons.json")));
  const institutions = transformMongoJSON<Institution[]>(
    await readJSON(path.join(dir, "dev", "dev.institutions.json")),
  );
  const groups = transformMongoJSON<Group[]>(await readJSON(path.join(dir, "dev", "dev.groups.json")));
  const researchSections = transformMongoJSON<ResearchSection[]>(
    await readJSON(path.join(dir, "dev", "dev.researchSections.json")),
  );
  const geo = await readJSON<RawGeo>(path.join(dir, "dev", "dev.geo.json"));

  const rawProjects = transformMongoJSON<Omit<Project, "university">[]>(
    await readJSON(path.join(dir, "dev", "dev.projectsData.json")),
  );
  const projects: Project[] = rawProjects.map((p) => ({ ...p, university: uniFromProjectId(p.id) }));

  const items: CollectionItem[] = [];

  // University project collections.
  for (const [uni, ids] of Object.entries(manifest.universities ?? {})) {
    const folder = `projects_metadata_${uni}`;
    const university = uni as University;
    for (const id of ids) {
      const file = path.join(dir, folder, `${folder}.${id}.json`);
      try {
        const raw = await readJSON<unknown[]>(file);
        for (const r of raw) {
          const it = transformMongoJSON<Record<string, unknown>>(r);
          normaliseItemLocation(it);
          (it as unknown as CollectionItem).university = university;
          items.push(it as unknown as CollectionItem);
        }
      } catch (err) {
        console.error(`[amira] skipping ${folder}.${id}: ${(err as Error).message}`);
      }
    }
  }

  // External collections -> reconciled to virtual projects.
  for (const [folder, names] of Object.entries(manifest.external ?? {})) {
    for (const name of names) {
      const file = path.join(dir, folder, `${folder}.${name}.json`);
      const virtual = EXTERNAL_COLLECTION_TO_PROJECT[name];
      try {
        const raw = await readJSON<unknown[]>(file);
        for (const r of raw) {
          const it = transformMongoJSON<Record<string, unknown>>(r);
          normaliseItemLocation(it);
          const item = it as unknown as CollectionItem;
          item.university = "external";
          if (virtual) item.project = { id: virtual.id, name: virtual.name };
          items.push(item);
        }
      } catch (err) {
        console.error(`[amira] skipping external ${name}: ${(err as Error).message}`);
      }
    }
  }

  for (const ep of EXTERNAL_PROJECTS) if (!projects.some((p) => p.id === ep.id)) projects.push(ep);

  // Publications are a separate pipeline and may be absent.
  let publications: Publication[] = [];
  try {
    const payload = await readJSON<{ publications?: Publication[] }>(path.join(dir, "publications.json"));
    publications = payload.publications ?? [];
  } catch {
    /* optional */
  }

  return new DataStore({
    source,
    generatedAt: manifest.generatedAt ?? "",
    persons,
    institutions,
    groups,
    projects,
    researchSections,
    items,
    publications,
    geo,
  });
}

/** True if `dir` looks like a usable snapshot (has a manifest). */
async function hasSnapshot(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, "manifest.json"));
    return true;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Singleton + background refresh
// -----------------------------------------------------------------------------

let current: DataStore | null = null;
let loading: Promise<DataStore> | null = null;

async function loadInitial(): Promise<DataStore> {
  // Prefer a previously refreshed cache; otherwise the bundled snapshot.
  if (await hasSnapshot(config.cacheDir)) {
    try {
      return await loadFromDir(config.cacheDir, "cache");
    } catch (err) {
      console.error(`[amira] cache load failed, using bundled snapshot: ${(err as Error).message}`);
    }
  }
  return loadFromDir(config.bundledDataDir, "bundled");
}

export async function ensureStore(): Promise<DataStore> {
  if (current) return current;
  if (!loading) {
    loading = loadInitial().then((store) => {
      current = store;
      if (config.liveRefresh) void backgroundRefresh();
      return store;
    });
  }
  return loading;
}

/** Currently-loaded store, or null before the first ensureStore(). */
export function peekStore(): DataStore | null {
  return current;
}

async function fetchJSON<T>(url: string, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function downloadTo(url: string, dest: string, timeoutMs = 30000): Promise<void> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.partial`;
    await fs.writeFile(tmp, buf);
    await fs.rename(tmp, dest);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * If the public dashboard has a newer snapshot, download it into the cache and
 * swap the in-memory store. All failures are non-fatal — the bundled/cached
 * data keeps serving.
 */
async function backgroundRefresh(): Promise<void> {
  try {
    const remote = await fetchJSON<DataManifest>(`${config.dataBaseUrl}/manifest.json`);
    const localGen = current?.generatedAt ?? "";
    if (remote.generatedAt && localGen && remote.generatedAt <= localGen) {
      return; // already current
    }

    const files = dataFileList(remote);
    let ok = 0;
    for (const rel of files) {
      try {
        await downloadTo(`${config.dataBaseUrl}/${rel}`, path.join(config.cacheDir, rel));
        ok++;
      } catch (err) {
        // publications.json is optional; other misses just leave the bundled copy.
        if (!rel.endsWith("publications.json")) {
          console.error(`[amira] refresh: ${rel} failed: ${(err as Error).message}`);
        }
      }
    }
    if (ok === 0) return;

    const refreshed = await loadFromDir(config.cacheDir, "cache");
    current = refreshed;
    console.error(
      `[amira] refreshed snapshot from dashboard (generatedAt=${refreshed.generatedAt}, ${refreshed.items.length} items)`,
    );
  } catch (err) {
    console.error(`[amira] live refresh skipped: ${(err as Error).message}`);
  }
}
