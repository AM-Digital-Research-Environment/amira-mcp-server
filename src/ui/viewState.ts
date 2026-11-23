// Saved view state (#32): what the bibliography, map and graph views need to
// come back as the reader left them when a host re-delivers the same tool
// result (reopening a conversation, a refreshed page, a recreated iframe).
//
// IDENTITY. One tool result is one view instance. The server stamps each
// result of a restorable tool with a fresh `viewUUID` in `_meta` (the ext-apps
// PDF viewer's convention); a replay of that result carries the same one, a new
// call a new one. Some hosts drop `_meta` on replay, so the fallbacks are the
// host's id for the originating tools/call (toolInfo.id), then a hash of the
// result's content. Only the last can confuse two instances: two calls whose
// results are byte-identical, on a host that sends neither, share their state.
//
// STORAGE. The page's own localStorage, which a sandboxed iframe may refuse:
// every access is guarded, and a refusal, a corrupt entry or an entry of
// another version yields "nothing saved", never an error. Entries are small
// (filters, ids, offsets; no transcripts, full text or exports), capped in
// size, and the oldest are evicted past a fixed count.

/** Bumped when the saved shape changes; other versions are ignored. */
export const VIEW_STATE_VERSION = 1;
/** Largest entry kept, in UTF-16 code units of its JSON. */
export const VIEW_STATE_MAX_CHARS = 16_000;
/** Instances remembered; the least recently saved are evicted. */
export const VIEW_STATE_MAX_ENTRIES = 40;

const PREFIX = "amira-view:";
const INDEX = `${PREFIX}index`;

/** The `_meta` keys the server stamps on restorable results (src/tools/policy.ts). */
export const VIEW_UUID_META = "viewUUID";
export const SNAPSHOT_META = "amira/snapshot";

export interface SavedView {
  v: typeof VIEW_STATE_VERSION;
  view: string;
  /** The snapshot the saved ids and offsets refer to, when the server named it. */
  snapshot: string | null;
  saved_at: number;
  state: Record<string, unknown>;
}

type ResultLike = { _meta?: Record<string, unknown> | null; content?: unknown; structuredContent?: unknown };

/** FNV-1a over UTF-16 code units: stable, dependency-free, enough to tell results apart. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The instance a host-delivered result belongs to: its viewUUID, else the call id, else its content. */
export function instanceKey(result: ResultLike, callId?: unknown): string {
  const uuid = result._meta?.[VIEW_UUID_META];
  if (typeof uuid === "string" && uuid) return `uuid:${uuid}`;
  if ((typeof callId === "string" && callId) || typeof callId === "number") return `call:${callId}`;
  return `hash:${fnv1a(JSON.stringify(result.structuredContent ?? result.content ?? null))}`;
}

/** The snapshot a result was computed on, when the server stamped it. */
export function snapshotOf(result: ResultLike): string | null {
  const id = result._meta?.[SNAPSHOT_META];
  return typeof id === "string" && id ? id : null;
}

/** localStorage, or null where the sandbox refuses it. */
function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Saved states by instance key, over a Storage that may fail at any call. */
export class ViewStore {
  constructor(private readonly storage: () => Storage | null = defaultStorage) {}

  private get(name: string): string | null {
    try {
      return this.storage()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  }

  private index(): string[] {
    try {
      const list = JSON.parse(this.get(INDEX) ?? "[]");
      return Array.isArray(list) ? list.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  /** The state saved for `key`, or null when there is none or it is unusable. */
  load(key: string): SavedView | null {
    const raw = this.get(PREFIX + key);
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as Partial<SavedView>;
      if (saved?.v !== VIEW_STATE_VERSION || typeof saved.view !== "string" || !saved.state || typeof saved.state !== "object"
        || Array.isArray(saved.state)) return null;
      return { v: VIEW_STATE_VERSION, view: saved.view, snapshot: typeof saved.snapshot === "string" ? saved.snapshot : null,
        saved_at: typeof saved.saved_at === "number" ? saved.saved_at : 0, state: saved.state as Record<string, unknown> };
    } catch {
      return null;
    }
  }

  /** Save `state` for `key`; false when it is too large or the storage refused it. */
  save(key: string, view: string, snapshot: string | null, state: Record<string, unknown>): boolean {
    const entry: SavedView = { v: VIEW_STATE_VERSION, view, snapshot, saved_at: Date.now(), state };
    const json = JSON.stringify(entry);
    if (json.length > VIEW_STATE_MAX_CHARS) return false;
    try {
      const storage = this.storage();
      if (!storage) return false;
      storage.setItem(PREFIX + key, json);
      const keys = [...this.index().filter((k) => k !== key), key];
      for (const old of keys.splice(0, Math.max(0, keys.length - VIEW_STATE_MAX_ENTRIES))) storage.removeItem(PREFIX + old);
      storage.setItem(INDEX, JSON.stringify(keys));
      return true;
    } catch {
      return false;
    }
  }

  /** Drop what is saved for `key`. */
  forget(key: string): void {
    try {
      const storage = this.storage();
      if (!storage) return;
      storage.removeItem(PREFIX + key);
      storage.setItem(INDEX, JSON.stringify(this.index().filter((k) => k !== key)));
    } catch {
      /* nothing to drop */
    }
  }
}
