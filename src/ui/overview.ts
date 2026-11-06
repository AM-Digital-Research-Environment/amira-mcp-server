// MCP App view: the collection at a glance — the visual form of
// get_collection_overview, the tool everyone calls first.
//
// Form follows the data's job (dataviz procedure step 1): the headline counts
// are single values, so they are STAT TILES, not a chart; the four breakdowns
// are magnitude-by-category, so they are ranked horizontal bars, as small
// multiples. Every chart is single-series — the category sits on the axis
// label — so one validated accent is correct and no legend is needed.
//
// Degrades by exposure level: under AMIRA_EXPOSURE below `structured` the
// relational breakdowns are absent from the payload, so the app renders the
// tiles and whatever survives rather than erroring.

import type { AppView } from "./shell.js";

const CSS = String.raw`
.tiles { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 14px; }
.tile {
  flex: 1 1 96px; min-width: 96px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 6px;
}
.tile .n {
  display: block; font-size: 19px; font-weight: 650; line-height: 1.15;
  color: var(--ink-strong); font-variant-numeric: tabular-nums;
}
.tile .k { display: block; font-size: 11px; color: var(--ink-muted); margin-top: 1px; }
.tile .sub2 { display: block; font-size: 10px; color: var(--ink-muted); margin-top: 2px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px 20px; }
.panel { min-width: 0; }
`;


export const OVERVIEW_VIEW: AppView = { name: "overview", title: "AMIRA — collection at a glance", css: CSS, file: "overview.js" };
