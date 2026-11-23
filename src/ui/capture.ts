// A bounded PNG of the map or entity graph on screen (#31), for the
// `get-screenshot` app tool the bridge registers (src/ui/bridge.ts). The
// assistant sees what the reader sees (filters, the selected place or
// neighbour, the theme) instead of reconstructing it from a fresh query.
//
// HOW. Both views draw inline SVG styled by the page's stylesheet, which an
// SVG drawn as an image cannot read. The capture clones the SVG, writes every
// computed paint and text property onto the clone (so CSS variables, the theme
// and :hover/.picked states are baked in), adds a background in the page's
// surface colour, and draws it on a canvas from a `data:` URL: no network, no
// external asset, nothing the sandbox's default CSP refuses. A `data:` SVG
// without foreignObject does not taint the canvas in current engines; where an
// engine still does, `toDataURL` throws and the tool says capture failed.
//
// BOUNDS. Width and height are scaled so the longer side is at most
// `maxDimension` (64–2048, default 1024); a PNG over MAX_PNG_BYTES is retried
// at half size, then refused.

/** Default and limits of the longer side, in pixels (as the ext-apps map example). */
export const CAPTURE_DEFAULT_DIMENSION = 1024;
export const CAPTURE_MIN_DIMENSION = 64;
export const CAPTURE_MAX_DIMENSION = 2048;
/** Largest PNG returned, in bytes of the decoded image. */
export const MAX_PNG_BYTES = 1_500_000;

/** The views that can be captured, and where their SVG is. */
export const CAPTURE_TARGETS = { map: ".map svg", graph: ".graph svg" } as const;

/** Paint and text properties that carry meaning in the two diagrams. */
const PROPERTIES = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-opacity",
  "opacity", "font-family", "font-size", "font-weight", "letter-spacing", "text-decoration", "visibility", "display",
] as const;

/**
 * A standalone SVG document of `svg` as it is drawn now: computed styles
 * inlined, explicit size, a background rectangle. Interactive attributes go;
 * titles stay (they name each mark).
 */
export function standaloneSvg(svg: SVGSVGElement, background: string): { text: string; width: number; height: number } {
  const box = svg.viewBox?.baseVal;
  const width = box?.width || svg.clientWidth || 720;
  const height = box?.height || svg.clientHeight || 360;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const source = [svg, ...svg.querySelectorAll("*")];
  const target = [clone, ...clone.querySelectorAll("*")];
  source.forEach((element, i) => {
    const copy = target[i] as Element | undefined;
    if (!copy) return;
    const style = getComputedStyle(element);
    const inline = PROPERTIES.map((p) => [p, style.getPropertyValue(p)] as const).filter(([, v]) => v !== "" && v !== "normal")
      .map(([p, v]) => `${p}:${v}`).join(";");
    if (inline) copy.setAttribute("style", inline);
    for (const attribute of ["class", "tabindex", "role", "data-pick", "data-place", "data-place-id", "aria-label"]) copy.removeAttribute(attribute);
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  if (!clone.getAttribute("viewBox")) clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const x = box?.x ?? 0, y = box?.y ?? 0;
  const backdrop = clone.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
  for (const [k, v] of [["x", x], ["y", y], ["width", width], ["height", height]] as const) backdrop.setAttribute(k, String(v));
  backdrop.setAttribute("fill", background || "#ffffff");
  clone.insertBefore(backdrop, clone.firstChild);
  return { text: new XMLSerializer().serializeToString(clone), width, height };
}

/** The size to draw at: the longer side at most `maxDimension`, never upscaled past 2×. */
export function captureSize(width: number, height: number, maxDimension: number): { width: number; height: number } {
  const limit = Math.min(CAPTURE_MAX_DIMENSION, Math.max(CAPTURE_MIN_DIMENSION, Math.floor(maxDimension)));
  const scale = Math.min(limit / Math.max(width, height), 2);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Draw a standalone SVG on a canvas and return its PNG as base64, bounded in bytes. */
export async function rasterize(svgText: string, width: number, height: number, maxDimension: number):
  Promise<{ data: string; width: number; height: number }> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The view could not be drawn as an image."));
  });
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  await loaded;
  for (let dimension = maxDimension; dimension >= CAPTURE_MIN_DIMENSION; dimension = Math.floor(dimension / 2)) {
    const size = captureSize(width, height, dimension);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This host's browser cannot draw images.");
    context.drawImage(image, 0, 0, size.width, size.height);
    const data = canvas.toDataURL("image/png").split(",")[1] ?? "";
    if (!data) throw new Error("The view could not be encoded as PNG.");
    if (Math.floor((data.length * 3) / 4) <= MAX_PNG_BYTES) return { data, ...size };
  }
  throw new Error(`The image would exceed ${MAX_PNG_BYTES} bytes; ask for a smaller maxDimension.`);
}
