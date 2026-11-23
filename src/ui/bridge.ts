// The browser half of every AMIRA view: the official Apps SDK handshake plus
// the small API the views script (src/ui/page.ts) calls as window.amiraApp.
// Bundled once, gzip-compressed into the one ui://amira/app.html page.
import { App, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { ContextSync, type ContextSyncStatus } from "./contextSync.js";
import { askText, buildSelectionContext, selectionText, type SelectionContext } from "./selectionContext.js";
import { VIEW_CALLABLE_TOOLS } from "./viewContract.js";
import { instanceKey, snapshotOf, type SavedView, ViewStore } from "./viewState.js";
import { z } from "zod";
import {
  CAPTURE_DEFAULT_DIMENSION, CAPTURE_MAX_DIMENSION, CAPTURE_MIN_DIMENSION, CAPTURE_TARGETS, rasterize, standaloneSvg,
} from "./capture.js";

type Payload = Record<string, unknown>;
declare const __SERVER_VERSION__: string;
// Resizing is set up after connecting, by hand, so teardown can disconnect its observer (#51).
const app = new App({ name: "amira-mcp-app", version: __SERVER_VERSION__ }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: false });
let stopResize: (() => void) | undefined;
let render: ((payload: Payload) => void) | undefined;
let input: Payload = {};
// Saved view state (#32, src/ui/viewState.ts): the instance the host's result
// opened, what was saved for it (handed to its view once), and the newest
// snapshot id any restorable result named.
const views = new ViewStore();
let instance: { key: string; pending: SavedView | null; delivered: boolean } | undefined;
let snapshot: string | null = null;
let ready: Promise<void> | undefined;
let connected = false;
const lifecycle = new AbortController();
const tools = new Set<string>(VIEW_CALLABLE_TOOLS);

function status(message: string) {
  const element = document.getElementById("app-status");
  if (element) element.textContent = message;
}
function context(ctx?: Partial<McpUiHostContext>) {
  if (!ctx) return;
  // The host's theme picks the light or dark palette. Its style variables are
  // not applied: the views' stylesheet reads only its own tokens (src/ui/shell.ts),
  // tuned for contrast in both palettes, so they would set properties nothing reads (#59).
  if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.dataset.theme = ctx.theme;
  const dimensions = ctx.containerDimensions;
  if (dimensions) {
    const height = "height" in dimensions ? dimensions.height : dimensions.maxHeight;
    document.documentElement.style.maxHeight = height ? `${height}px` : "";
    document.documentElement.style.overflowY = "auto";
  }
  // Keep content clear of host chrome (notches, the full-screen header) on hosts that report it.
  const insets = ctx.safeAreaInsets;
  if (insets) document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}
function payload(result: CallToolResult): Payload {
  let value = result.structuredContent as Payload | undefined;
  if (!value) {
    const text = result.content?.find((c) => c.type === "text");
    if (text?.type === "text") { try { value = JSON.parse(text.text) as Payload; } catch { /* reported below */ } }
  }
  if (result.isError || value?.error) throw new Error(String((value?.error as Payload)?.message ?? "The request failed. Try again."));
  if (!value || typeof value !== "object") throw new Error("The host returned no usable data. Run the tool again.");
  return value;
}
app.onhostcontextchanged = context;
app.ontoolinput = (params) => { input = params.arguments ?? {}; };
app.ontoolresult = (result) => {
  const key = instanceKey(result, app.getHostContext()?.toolInfo?.id);
  instance = { key, pending: views.load(key), delivered: true };
  snapshot = snapshotOf(result) ?? snapshot;
  try { status(""); render?.(payload(result)); }
  catch (error) { status((error as Error).message); }
};
app.ontoolcancelled = () => status("Request cancelled. Run the tool again to continue.");
function shutDown(): void {
  connected = false;
  sync.stop();
  lifecycle.abort();
  stopResize?.();
  stopResize = undefined;
}
app.onteardown = async () => { shutDown(); return {}; };
window.addEventListener("pagehide", () => { shutDown(); void app.close(); }, { once: true });

// --- the selection, shared with the model ------------------------------------
// Interactive views report their current selection (bibliography filters and
// selected records, the map's place, the graph's type filter and spoke) through
// shareSelection. It is bounded by selectionContext.ts and sent only to hosts
// that advertise ui/update-model-context, serialised and latest-wins
// (contextSync.ts). An update never starts a turn: the host attaches it to the
// next message. "Ask about this selection" is the explicit form, a ui/message
// carrying the same bounded snapshot inline, offered only to hosts that accept
// app messages.
let latest: SelectionContext | undefined;
let syncState: ContextSyncStatus | undefined;
const sync = new ContextSync<SelectionContext>(async (snapshot, signal) => {
  const caps = app.getHostCapabilities()?.updateModelContext;
  // Only the modalities the host negotiated: a text-only host gets the data as
  // JSON inside the text block, a richer host gets it once, structured.
  await app.updateModelContext({
    ...(caps?.text ? { content: caps.structuredContent ? snapshot.content : [{ type: "text" as const, text: selectionText(snapshot) }] } : {}),
    ...(caps?.structuredContent ? { structuredContent: snapshot.structuredContent } : {}),
  }, { timeout: 10_000, signal });
}, (state) => { syncState = state; selectionStatus(); });
function canShare(): boolean {
  const caps = app.getHostCapabilities()?.updateModelContext;
  return connected && Boolean(caps?.text || caps?.structuredContent);
}
/** The view's status line under its selection controls, when it has one. */
function selectionStatus(): void {
  const element = document.getElementById("selection-status");
  if (!element || !canShare()) return;
  element.textContent = syncState === "shared" ? "Selection shared with the assistant."
    : syncState === "failed" ? "Could not share the selection with the assistant." : "Sharing the selection with the assistant…";
}

const bridge = {
  esc: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
  onResult(callback: (value: Payload) => void) {
    render = callback;
    ready ??= app.connect(undefined, { timeout: 10_000, signal: lifecycle.signal }).then(() => {
      connected = true;
      if (!lifecycle.signal.aborted) stopResize = app.setupSizeChangedNotifications();
      context(app.getHostContext());
    });
    void ready.catch(() => status("The app could not connect. Reopen it in an MCP Apps host to use its controls."));
  },
  input: () => ({ ...input }),
  /** The tool whose result opened this app, when the host's toolInfo names it. */
  toolName: (): string | undefined => app.getHostContext()?.toolInfo?.tool?.name,
  /**
   * Asked by a view as it renders. `undefined`: the result came from the app's
   * own call, not from the host. Otherwise the host delivered it, once: what
   * `view` saved for that instance, or null when nothing usable is saved.
   */
  restoreState(view: string): SavedView | null | undefined {
    if (!instance?.delivered) return undefined;
    const pending = instance.pending;
    instance.delivered = false;
    instance.pending = null;
    return pending && pending.view === view ? pending : null;
  },
  /** Save `view`'s state for the instance on screen (bounded; see src/ui/viewState.ts). */
  saveState(view: string, state: Record<string, unknown>): void {
    if (instance) views.save(instance.key, view, snapshot, state);
  },
  /** The newest snapshot id a restorable result named, or null. */
  snapshot: (): string | null => snapshot,
  /** Report the view's current selection; see the section above. */
  shareSelection(selection: unknown) {
    const snapshot = buildSelectionContext(selection);
    latest = snapshot;
    void ready?.then(() => {
      if (!canShare()) return;
      sync.publish(snapshot);
      selectionStatus(); // a re-rendered view has a fresh, empty status line
    }, () => {});
  },
  /** Whether the host takes automatic context updates from the app. */
  canShare,
  /** Whether the host takes an explicit message from the app. */
  canAsk: () => connected && Boolean(app.getHostCapabilities()?.message?.text),
  /** Send "Ask about this selection" with the selection as it is now. */
  async ask() {
    const snapshot = latest;
    if (!snapshot) throw new Error("Nothing is selected yet.");
    if (!bridge.canAsk()) throw new Error("This host cannot take questions from the app. Ask in the conversation instead.");
    const reply = await app.sendMessage({ role: "user", content: [{ type: "text", text: askText(snapshot) }] },
      { timeout: 10_000, signal: lifecycle.signal });
    if (reply.isError) throw new Error("The host declined to send the question.");
  },
  /** `quiet` calls (background option lists) leave the status line alone. The
   * result is the tool's structured content; `T` is the shape the caller reads. */
  async callTool<T = Payload>(name: string, args: Payload, options: { quiet?: boolean } = {}): Promise<T> {
    if (!tools.has(name)) throw new Error("This tool is not available in the app.");
    await ready;
    const say = options.quiet ? () => {} : status;
    say("Loading…");
    try {
      const raw = await app.callServerTool({ name, arguments: args }, { timeout: 15_000, signal: lifecycle.signal });
      snapshot = snapshotOf(raw) ?? snapshot;
      const result = payload(raw);
      say(""); return result as T;
    } catch (error) { say((error as Error).message); throw error; }
  },
  async openLink(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    await ready;
    const result = await app.openLink({ url }, { timeout: 10_000, signal: lifecycle.signal });
    // A host that refuses the link says so in the result, not by throwing.
    if (result.isError) throw new Error("The host did not open the link.");
  },
  /**
   * Save a file through the host, or show the text to copy when the host cannot.
   * File downloads are a draft-spec MCP Apps capability, so they are only
   * requested from hosts that advertise `downloadFile`.
   */
  async download(text: string, extension: "bib" | "ris" | "json"): Promise<"saved" | "shown"> {
    await ready;
    if (!app.getHostCapabilities()?.downloadFile) {
      showForCopy(text);
      return "shown";
    }
    const result = await app.downloadFile({ contents: [{ type: "resource", resource: {
      uri: `file:///amira-bibliography.${extension}`, mimeType: extension === "json" ? "application/json" : "text/plain", text,
    } }] }, { timeout: 30_000, signal: lifecycle.signal });
    if (result.isError) throw new Error("Download was cancelled or declined by the host.");
    return "saved";
  },
  status,
};
/** Fallback for hosts without file downloads: a read-only text box to copy from. */
function showForCopy(text: string): void {
  let box = document.getElementById("amira-export") as HTMLTextAreaElement | null;
  if (!box) {
    box = document.createElement("textarea");
    box.id = "amira-export";
    box.readOnly = true;
    box.rows = 12;
    box.setAttribute("aria-label", "Exported citations");
    box.style.width = "100%";
    box.style.marginTop = "12px";
    document.getElementById("root")?.appendChild(box);
  }
  box.value = text;
  box.focus();
  box.select();
}
/** The bridge's API, window.amiraApp. The views' typecheck (tsconfig.views.json)
 * reads this declaration itself, so the views are checked against the real bridge. */
export type AmiraApp = typeof bridge;
declare global { interface Window { amiraApp: AmiraApp } }
window.amiraApp = bridge;

// --- the view as an image, for the host to request (#31) ----------------------
// An app tool, registered before connecting so the app declares it: a host that
// lists and calls a view's tools can ask for a PNG of the map or entity graph on
// screen. Other hosts never call it and keep the JSON, citations and selection.
const SCREENSHOT_NOTE =
  "The image shows the current results as the reader sees them; it is not additional evidence. " +
  "Cite records by their amira_url from the tool results or the selection below.";
const screenshotInput = z.object({
  maxDimension: z.number().int().min(CAPTURE_MIN_DIMENSION).max(CAPTURE_MAX_DIMENSION).optional()
    .describe(`Longest side in pixels (default ${CAPTURE_DEFAULT_DIMENSION}); larger images cost more tokens`),
});
app.registerTool("get-screenshot", {
  title: "Screenshot of the AMIRA view",
  description: "A PNG of the research-places map or entity graph on screen in this AMIRA view, with its filters and " +
    "selection, plus that selection as text. Other views have no image.",
  inputSchema: screenshotInput,
  annotations: { readOnlyHint: true },
// The handler returns a plain CallToolResult (text and image); ext-apps types the
// result against its own copy of the SDK types, hence the cast.
}, (async (args: z.infer<typeof screenshotInput>): Promise<CallToolResult> => {
  const view = document.getElementById("root")?.dataset.view ?? "";
  const selector = (CAPTURE_TARGETS as Record<string, string>)[view];
  const svg = selector ? document.querySelector<SVGSVGElement>(selector) : null;
  if (!svg) {
    return { isError: true, content: [{ type: "text" as const,
      text: "No research-places map or entity graph is on screen in this view, so there is nothing to capture." }] };
  }
  try {
    const surface = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
    const page = standaloneSvg(svg, surface || getComputedStyle(document.body).backgroundColor);
    const shot = await rasterize(page.text, page.width, page.height, args.maxDimension ?? CAPTURE_DEFAULT_DIMENSION);
    const what = view === "map" ? "Research-places map" : "Entity graph";
    return { content: [
      { type: "text" as const, text: `${what} as shown in the AMIRA app, ${shot.width}×${shot.height} px. ${SCREENSHOT_NOTE}` +
        (latest ? `\n\n${selectionText(latest)}` : "") },
      { type: "image" as const, data: shot.data, mimeType: "image/png" },
    ] };
  } catch (error) {
    return { isError: true, content: [{ type: "text" as const, text: (error as Error).message }] };
  }
}) as never);

// Route citations, and a private record's admin page (curator mode), through the
// host. Data is escaped by renderers; only HTTP(S) links are opened.
document.addEventListener("click", (event) => {
  const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[data-citation], a[data-admin]");
  if (!link) return;
  event.preventDefault();
  void bridge.openLink(link.href).catch((error: Error) => status(error.message));
});
