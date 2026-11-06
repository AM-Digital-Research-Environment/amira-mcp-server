// MCP App view: the co-occurrence hub — the visual form of find_related, and the
// one chart that shows the cluster's core analytic rather than describing it.
// "Relationality" means an entity is constituted by what it connects to; a hub
// puts the seed at the centre and radiates its connections, which a stack of
// ranked lists cannot do.
//
// COLOUR: find_related returns SIX relation types, and six CVD-separable hues
// do not exist in the Africa Multiple brand set — validated, not assumed: the
// best five-hue candidates failed all-pairs CVD separation (worst pair ΔE 2.4
// deutan) and the normal-vision floor. Per the rule that you cut or facet
// rather than invent hues, identity here is carried SPATIALLY: each relation
// type owns a labelled angular sector, and every spoke uses the one validated
// accent. Spoke length encodes co-occurrence count. No legend is needed, and
// the encoding survives greyscale, print and forced-colors.

import type { AppView } from "./shell.js";

const CSS = String.raw`
.hub { width: 100%; max-width: 620px; margin: 0 auto; }
.seed { fill: var(--bar); }
.seedlab { fill: #fff; font-size: 11px; font-weight: 650; }
.seedsub { fill: rgba(255, 255, 255, 0.82); font-size: 9px; }
.spoke { stroke: var(--bar); stroke-width: 5; stroke-linecap: round; }
.spoke:hover { stroke: var(--bar-hi); }
.node { fill: var(--ink); font-size: 9.5px; }
.sector { fill: var(--ink-muted); font-size: 10px; font-weight: 650; letter-spacing: 0.02em; }
.sectordiv { stroke: var(--grid); stroke-width: 1; }
.leader { stroke: var(--grid); stroke-width: 1; }
`;


export const RELATED_VIEW: AppView = { name: "related", title: "AMIRA — co-occurrence hub", css: CSS, file: "related.js" };
