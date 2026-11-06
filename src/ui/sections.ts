// MCP App view: the cluster's research sections as a funding-phase Gantt — the
// visual form of list_research_sections. Mirrors the "Gantt (project spans)"
// chart the DREVisualizations module renders on the AMIRA site.
//
// The chart exists to make ONE thing obvious that the JSON states but does not
// show: the cluster redefined its sections between AM 1.0 (2019–2025) and
// AM 2.0 (2026–2032), so a reader who treats the section list as one flat set
// mis-reads it — the AM 2.0 sections are seeded and hold ~0 items. Position on
// a shared time axis makes the two cohorts, and where "now" falls between them,
// legible at a glance.
//
// Single series: the phase is a row group with its own heading, so it needs no
// second hue and no legend.

import type { AppView } from "./shell.js";

const CSS = String.raw`
.chart { width: 100%; overflow-x: auto; }
.phase { fill: var(--ink-strong); font-size: 11px; font-weight: 650; }
.now { stroke: var(--ink-muted); stroke-width: 1; stroke-dasharray: 3 3; }
.nowlab { fill: var(--ink-muted); font-size: 9px; }
.rowname { fill: var(--ink); font-size: 11px; }
`;


export const SECTIONS_VIEW: AppView = { name: "sections", title: "AMIRA — research sections by funding phase", css: CSS, file: "sections.js" };
