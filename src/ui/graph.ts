// MCP App view: the one-hop entity graph. It borrows the co-occurrence hub's
// encoding (src/ui/related.ts) rather than inventing a second one: entity
// types own angular sectors, spoke length is a distinct-record count, and
// labels sit on a common ring, rotated along their spoke, so neighbours never
// collide. A graph has up to fifteen entity types and no validated palette
// separates that many, so identity is carried by position and a heading, not
// by hue, and the figure survives greyscale and print.
//
// Selecting a spoke opens that neighbour's links and the records behind its
// strongest one directly under the diagram; re-centring is a separate action,
// so reading the evidence for a link never throws the view away. Type chips
// call the tool again with `types`, which the server applies before its
// bounds: a client-side filter would come too late, after languages and
// formats had spent the node budget.
import type { AppView } from "./shell.js";
const CSS = String.raw`
.graph { max-width: 720px; margin: 0 auto; }
.graph .spoke { stroke: var(--bar); stroke-width: 5; stroke-linecap: round; }
.graph .spoke.derived { stroke-dasharray: 6 4; stroke-linecap: butt; }
.graph .hit { stroke: transparent; stroke-width: 16; }
.graph .leader { stroke: var(--border); stroke-width: 1; }
.graph .label { fill: var(--ink); font-size: 10.5px; }
.graph .sector { fill: var(--ink-muted); font-size: 9.5px; font-weight: 650; letter-spacing: 0.04em; }
.graph .seed { fill: var(--bar); }
.graph .seedlab { fill: #fff; font-size: 11px; font-weight: 650; }
.graph .seedsub { fill: rgba(255, 255, 255, 0.85); font-size: 9px; }
.node-link { cursor: pointer; outline: none; }
.node-link:hover .spoke, .node-link.picked .spoke { stroke: var(--ink-strong); }
.node-link.picked .label { fill: var(--ink-strong); font-weight: 700; }
.node-link:focus-visible .label { text-decoration: underline; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.chips button { min-height: 30px; padding: 4px 10px; border-radius: 999px; font-size: 12px; }
.chips button[aria-pressed="true"] { background: var(--bar); border-color: var(--bar); color: #fff; }
.pick { margin-top: 14px; }
.pick ul { margin: 6px 0 10px; padding-left: 18px; }
.pick li { margin: 3px 0; }
.row-button { text-align: left; border: 0; padding: 0; min-height: 0; color: var(--bar); }
th:last-child { width: 100px; }
button[data-edge] { white-space: nowrap; }
@media (max-width: 480px) { .graph { overflow-x: auto; } .graph svg { min-width: 560px; } }
`;
export const GRAPH_VIEW: AppView = { name: "graph", title: "AMIRA — entity graph", css: CSS, file: "graph.js" };
