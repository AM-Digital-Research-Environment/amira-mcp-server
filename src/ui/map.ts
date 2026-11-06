import type { AppView } from "./shell.js";
import land from "./land.json";
// Natural Earth 1:110m land, public domain. Source and checksum: docs/apps.md.
// Drawn on the viewBox's 720×360 plate carrée (2 units per degree) as INTEGER
// RELATIVE moves. The map is shown 600-900 px wide, so a unit is about a pixel
// and rounding to it is invisible; the outline was the largest piece of the
// app's script, and this form is a third of the absolute 0.1-unit one (about
// 20 KB against 58 KB). Coordinates are rounded before differencing, so no
// error accumulates along a ring; rings that round to under three points
// (specks of islands) are dropped.
const outline = land.features.flatMap((feature) =>
  (feature.geometry.type === "Polygon" ? [feature.geometry.coordinates] : feature.geometry.coordinates) as number[][][][],
).flatMap((polygon) => polygon.map((ring) => {
  const points: [number, number][] = [];
  for (const [lon, lat] of ring) {
    const x = Math.round((lon! + 180) * 2), y = Math.round((90 - lat!) * 2), last = points.at(-1);
    if (!last || last[0] !== x || last[1] !== y) points.push([x, y]);
  }
  if (points.length < 3) return "";
  // One "l" command, then implicit repeats: a negative dx carries its own
  // separator, a positive one needs a space.
  return `M${points[0]![0]},${points[0]![1]}l` + points.slice(1).map(([x, y], i) => {
    const [px, py] = points[i]!, dx = x - px;
    return `${i && dx >= 0 ? " " : ""}${dx},${y - py}`;
  }).join("") + "z";
})).join("");
const CSS = String.raw`
.land { fill: var(--grid); stroke: var(--border); stroke-width: .5; }
.place { fill: var(--bar); stroke: var(--ink); stroke-width: .6; cursor: pointer; }
.place.root { fill: none; stroke: var(--bar); stroke-width: 2; stroke-dasharray: 3 2; }
.place:focus-visible { stroke: var(--ink-strong); stroke-width: 3; outline: none; }
.map { border: 1px solid var(--border); margin: 12px 0; }
.name-button { text-align: left; padding: 0; border: none; color: var(--bar); }
table { table-layout: fixed; }
th:nth-child(1) { width: 32%; } th:nth-child(2) { width: 30%; } th:nth-child(3) { width: 12%; } th:nth-child(4) { width: 26%; }
`;
export const MAP_VIEW: AppView = { name: "map", title: "AMIRA — research places", css: CSS, file: "map.js", prepare: (source) => source.replace("__OUTLINE__", outline) };
