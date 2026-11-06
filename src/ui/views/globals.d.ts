// What the view scripts in this directory may use besides the DOM: the bridge
// (`window.amiraApp`, src/ui/bridge.ts) and the helpers src/ui/shell.ts
// defines once for every view (PICKER_JS, BAR_CHART_JS, SELECTION_JS).
//
// Read by tsconfig.views.json only, never by the server's own typecheck. The
// types are loose on purpose: the check catches an undefined name, a typo in a
// bridge member or a wrong argument count, not the shape of the payloads the
// tools return. test/unit/apps-render.test.mjs keeps AmiraApp's member list
// equal to the real bridge's.

/** The bridge the page exposes as window.amiraApp. */
interface AmiraApp {
  esc(value: unknown): string;
  onResult(callback: (payload: any) => void): void;
  input(): Record<string, any>;
  toolName(): string | undefined;
  shareSelection(selection: unknown): void;
  canShare(): boolean;
  canAsk(): boolean;
  ask(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>, options?: { quiet?: boolean }): Promise<any>;
  openLink(url: string): Promise<void>;
  download(text: string, extension: "bib" | "ris" | "json"): Promise<"saved" | "shown">;
  status(message: string): void;
}
interface Window { amiraApp: AmiraApp }

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
interface PickerSpec { name: string; kind: string; current?: unknown; any?: string; maxlength?: number }

/** The "Ask about this selection" controls, or "" when the host takes neither. */
declare function selectionControls(): string;
/** Load (once per key) a picker's options from a tool's results. */
declare function pickerLoad(key: string, tool: string, args: Record<string, unknown>,
  pick: (row: any) => PickerOption | null, order?: (a: PickerOption, b: PickerOption) => number): Promise<PickerOption[] | null>;
/** A picker's options when already loaded, else null. */
declare function pickerNow(key: string): PickerOption[] | null;
/** A picker's markup. */
declare function pickerField(p: PickerSpec, list: PickerOption[] | null): string;
/** Fill a rendered picker once its options arrive. */
declare function pickerMount(p: PickerSpec, load: Promise<PickerOption[] | null>, shown?: PickerOption[] | null): void;
/** A record's title as a citation link to its amira_url. */
declare function citationLink(r: { amira_url: string; title: string }): string;
/** Render a page of records into `target`, with "Next records" calling `onMore(next_offset)`. */
declare function evidenceList(target: Element, heading: string, data: any, item: (r: any) => string, moreId: string,
  onMore: (offset: number) => void): void;
/** A horizontal bar chart's markup. */
declare function barChart(rows: any[], opts?: Record<string, any>): string;
