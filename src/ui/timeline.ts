// MCP App view: the collection's coverage-over-time histogram — the visual form of
// list_years. Mirrors the "Timeline (bar by year)" chart the DREVisualizations
// module renders on the AMIRA site, so the chat and the site agree.
//
// Single series (one bar per year), so the accent carries no identity. Colours
// and shared helpers come from ./shell; ./page assembles the page.

import type { AppView } from "./shell.js";

const CSS = String.raw`
.chart { width: 100%; overflow-x: auto; }
`;


export const TIMELINE_VIEW: AppView = { name: "timeline", title: "AMIRA — coverage over time", css: CSS, file: "timeline.js" };
