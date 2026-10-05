import { App, applyHostStyleVariables, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/client";

type Payload = Record<string, unknown>;
declare const __SERVER_VERSION__: string;
const app = new App({ name: "amira-mcp-app", version: __SERVER_VERSION__ }, { availableDisplayModes: ["inline", "fullscreen"] }, { autoResize: true });
let render: ((payload: Payload) => void) | undefined;
let input: Payload = {};
let ready: Promise<void> | undefined;
const lifecycle = new AbortController();
const tools = new Set(["get_entity_graph", "resolve_entity", "list_locations", "search_research_items", "list_years", "search_publications", "get_publication", "list_publication_facets"]);

function status(message: string) {
  const element = document.getElementById("app-status");
  if (element) element.textContent = message;
}
function context(ctx?: Partial<McpUiHostContext>) {
  if (!ctx) return;
  if (ctx.theme === "dark" || ctx.theme === "light") document.documentElement.dataset.theme = ctx.theme;
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  const dimensions = ctx.containerDimensions;
  if (dimensions) {
    const height = "height" in dimensions ? dimensions.height : dimensions.maxHeight;
    document.documentElement.style.maxHeight = height ? `${height}px` : "";
    document.documentElement.style.overflowY = "auto";
  }
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
  try { status(""); render?.(payload(result)); }
  catch (error) { status((error as Error).message); }
};
app.ontoolcancelled = () => status("Request cancelled. Run the tool again to continue.");
app.onteardown = async () => { lifecycle.abort(); return {}; };
window.addEventListener("pagehide", () => { lifecycle.abort(); void app.close(); }, { once: true });

const bridge = {
  esc: (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
  onResult(callback: (value: Payload) => void) {
    render = callback;
    ready ??= app.connect(undefined, { timeout: 10_000, signal: lifecycle.signal }).then(() => context(app.getHostContext()));
    void ready.catch(() => status("The app could not connect. Reopen it in an MCP Apps host to use its controls."));
  },
  input: () => ({ ...input }),
  async callTool(name: string, args: Payload) {
    if (!tools.has(name)) throw new Error("This tool is not available in the app.");
    await ready;
    status("Loading…");
    try {
      const result = payload(await app.callServerTool({ name, arguments: args }, { timeout: 15_000, signal: lifecycle.signal }));
      status(""); return result;
    } catch (error) { status((error as Error).message); throw error; }
  },
  async openLink(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    await ready;
    await app.openLink({ url }, { timeout: 10_000, signal: lifecycle.signal });
  },
  async download(text: string, extension: "bib" | "ris" | "json") {
    await ready;
    const result = await app.downloadFile({ contents: [{ type: "resource", resource: {
      uri: `file:///amira-bibliography.${extension}`, mimeType: extension === "json" ? "application/json" : "text/plain", text,
    } }] }, { timeout: 30_000, signal: lifecycle.signal });
    if (result.isError) throw new Error("Download was cancelled or declined by the host.");
  },
  status,
};
declare global { interface Window { amiraApp: typeof bridge } }
window.amiraApp = bridge;

// Route citations through the host. Data is escaped by renderers; only HTTP(S) links are opened.
document.addEventListener("click", (event) => {
  const link = (event.target as Element)?.closest<HTMLAnchorElement>("a[data-citation]");
  if (!link) return;
  event.preventDefault();
  void bridge.openLink(link.href).catch((error: Error) => status(error.message));
});
