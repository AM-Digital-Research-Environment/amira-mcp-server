// What the view scripts in this directory may use besides the DOM and the
// helpers of ./_shared.js (a classic script, so its functions are globals the
// checker sees directly).
//
// Read by tsconfig.views.json only, never by the server's own typecheck. The
// bridge is not declared here: this import pulls in src/ui/bridge.ts, whose
// `declare global` types `window.amiraApp` as the real bridge object, so a
// member the views use and the bridge lacks fails the typecheck. The tools'
// payloads stay loose (ToolData): the check catches an undefined name, a typo
// in a bridge member or a wrong argument count, not the shape of a result.

/** The bridge the page exposes as window.amiraApp (src/ui/bridge.ts). */
type AmiraApp = import("../bridge.js").AmiraApp;

/**
 * A tool's JSON result, or one record of it, as the views read it: by field
 * name, unchecked. The list fields the views walk are typed, so their
 * callbacks get a record rather than an implicit any.
 */
interface ToolData {
  [field: string]: any;
  results?: ToolData[];
  nodes?: ToolData[];
  edges?: ToolData[];
  related_publications?: ToolData[];
}

// The views were written against the untyped DOM: an event target is read as
// the element it is, and a looked-up element as the input it is. These loose
// members keep that code checkable without a cast at every handler.
interface EventTarget {
  closest(selector: string): any;
  matches(selector: string): boolean;
  readonly dataset: DOMStringMap;
  value: any;
  checked: boolean;
}
interface Element { readonly dataset: DOMStringMap; focus(): void; value: any; disabled: boolean; checked: boolean }

/** An option of a picker: the submitted value, an optional label and alternate name. */
interface PickerOption { value: string; label?: string; alt?: string }
/** A filter control: a free-text suggestion box or a select. */
interface PickerSpec { name: string; kind: string; current?: unknown; any?: string; maxlength?: number; placeholder?: string }

/** Written by the page assembler (src/ui/page.ts viewsScript) for ./_router.js. */
declare var amiraViews: Record<string, { title: string; render: (payload: Record<string, unknown>) => void }>;
declare var amiraViewOfTool: Record<string, string>;
