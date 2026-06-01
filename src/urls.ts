// Builders for citable amira dashboard URLs. These mirror the dashboard's own
// `src/lib/utils/urls.ts` so every link resolves to the exact page a human can
// open. They are the canonical citation for any entity the tools return.
import { DASHBOARD_BASE } from "./config.js";

const enc = encodeURIComponent;

export function personUrl(name: string): string {
  return `${DASHBOARD_BASE}/people?name=${enc(name)}`;
}

export function projectUrl(id: string): string {
  return `${DASHBOARD_BASE}/projects?id=${enc(id)}`;
}

export function researchSectionUrl(sectionName?: string): string {
  return sectionName
    ? `${DASHBOARD_BASE}/research-sections?section=${enc(sectionName)}`
    : `${DASHBOARD_BASE}/research-sections`;
}

export function researchItemUrl(dreId: string): string {
  return `${DASHBOARD_BASE}/research-items?id=${enc(dreId)}`;
}

export function institutionUrl(name: string): string {
  return `${DASHBOARD_BASE}/institutions?name=${enc(name)}`;
}

export function groupUrl(name: string): string {
  return `${DASHBOARD_BASE}/groups?name=${enc(name)}`;
}

export function locationUrl(name: string): string {
  return `${DASHBOARD_BASE}/locations?name=${enc(name)}`;
}

export function languageUrl(code: string): string {
  return `${DASHBOARD_BASE}/languages?code=${enc(code)}`;
}

export function subjectUrl(name: string): string {
  return `${DASHBOARD_BASE}/subjects?name=${enc(name)}&view=subjects`;
}

export function tagUrl(name: string): string {
  return `${DASHBOARD_BASE}/subjects?name=${enc(name)}&view=tags`;
}

export function resourceTypeUrl(type: string): string {
  return `${DASHBOARD_BASE}/resource-types?type=${enc(type)}`;
}

export function genreUrl(genre: string): string {
  return `${DASHBOARD_BASE}/genres?genre=${enc(genre)}`;
}

export function publicationsUrl(): string {
  return `${DASHBOARD_BASE}/publications`;
}
