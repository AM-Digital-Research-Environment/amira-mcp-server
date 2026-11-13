// Curator mode (#26): its configuration, the Omeka service key and the personal
// tokens. Two layers, kept apart:
//
//   1. Client → this server: personal bearer tokens. AMIRA_MCP_TOKENS_FILE holds
//      one `name sha256hex` line per curator; only the hash is stored. The file
//      is re-read every few seconds, so deleting a line revokes that curator
//      without a restart. The name is what the audit log records.
//   2. This server → Omeka: one service key (AMIRA_OMEKA_KEY_FILE). Omeka reads
//      keys only from the query string, so the key is added to a request URL at
//      the last moment, inside the fetch (src/snapshot.ts), and never stored in
//      the API base, the manifest, an error, a log line or a returned URL.
//
// Curator mode fails closed: `accessConfigErrors` lists every reason to refuse
// to start, and the entry points exit when it is not empty. Public mode refuses
// a configured key, so a public process can never crawl private data.
import * as fs from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { normalizeApiBase } from "./snapshotIdentity.js";

export interface OmekaKey {
  identity: string;
  credential: string;
}

/** A key part: printable ASCII without spaces (Omeka generates 32 alphanumerics). */
const KEY_PART = /^[\x21-\x7e]{1,256}$/;

/**
 * Parse a key file: `key_identity=…` and `key_credential=…` lines (`#` comments
 * allowed; `:` works as well as `=`), or a JSON object with the same two keys.
 * Error messages never quote the file.
 */
export function parseOmekaKey(text: string): OmekaKey {
  const found: Record<string, string> = {};
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error("is not valid JSON");
    }
    for (const k of ["key_identity", "key_credential"]) {
      const v = (parsed as Record<string, unknown>)?.[k];
      if (typeof v === "string") found[k] = v.trim();
    }
  } else {
    for (const [i, raw] of trimmed.split(/\r?\n/).entries()) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = /^(key_identity|key_credential)\s*[=:]\s*(.*)$/.exec(line);
      if (!m) throw new Error(`line ${i + 1} is neither key_identity=… nor key_credential=…`);
      if (found[m[1]!] !== undefined) throw new Error(`${m[1]} is given twice`);
      found[m[1]!] = m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  }
  for (const k of ["key_identity", "key_credential"]) {
    if (!found[k]) throw new Error(`has no ${k}`);
    if (!KEY_PART.test(found[k]!)) throw new Error(`has a malformed ${k} (expected printable characters without spaces)`);
  }
  return { identity: found.key_identity!, credential: found.key_credential! };
}

/** Read and parse a key file; the error names the variable, never the content. */
export function readOmekaKeyFile(file: string): OmekaKey {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`AMIRA_OMEKA_KEY_FILE is unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  try {
    return parseOmekaKey(text);
  } catch (err) {
    throw new Error(`AMIRA_OMEKA_KEY_FILE ${(err as Error).message}`);
  }
}

/** Re-read the key file at most this often, so a rotated key is picked up without a restart. */
const KEY_TTL_MS = 60_000;
let keyCache: { key: OmekaKey; at: number } | null = null;
/** Every key value ever loaded by this process, for redaction after a rotation. */
const seenSecrets = new Set<string>();

/**
 * The Omeka service key, or null outside curator mode. Public mode never reads
 * the file, even when one is configured (it refuses to start instead).
 */
export function omekaKey(): OmekaKey | null {
  if (config.access !== "curator" || !config.omekaKeyFile) return null;
  if (!keyCache || Date.now() - keyCache.at >= KEY_TTL_MS) {
    const key = readOmekaKeyFile(config.omekaKeyFile);
    seenSecrets.add(key.identity);
    seenSecrets.add(key.credential);
    keyCache = { key, at: Date.now() };
  }
  return keyCache.key;
}

/** Tests: forget the cached key so the next request re-reads the file. */
export function resetOmekaKeyCache(): void {
  keyCache = null;
}

/** The key for a request to the configured Omeka API, or null for anything else (GitHub, other hosts). */
export function omekaKeyFor(url: string): OmekaKey | null {
  if (config.access !== "curator") return null;
  // The fetch base, not the public one: a key must never be sent to the public
  // URL when the deployment fetches over the internal network.
  const prefix = `${normalizeApiBase(config.fetchBase)}/`;
  return url.startsWith(prefix) ? omekaKey() : null;
}

/** `url` with the key appended: built for the fetch call only, never returned or stored. */
export function withOmekaKey(url: string, key: OmekaKey): string {
  const u = new URL(url);
  u.searchParams.set("key_identity", key.identity);
  u.searchParams.set("key_credential", key.credential);
  return u.href;
}

/**
 * Remove Omeka key material from text bound for a log line or an error: the
 * query parameters by name, and any key value this process has loaded.
 */
export function redactSecrets(text: string): string {
  let out = text.replace(/(key_identity|key_credential)(=|%3D)[^&\s"'<>]*/gi, "$1$2[redacted]");
  for (const secret of seenSecrets) if (secret.length >= 4) out = out.split(secret).join("[redacted]");
  return out;
}

// --- personal tokens --------------------------------------------------------------

export interface CuratorToken {
  name: string;
  hash: Buffer;
}

/** A token name: what the audit log prints, so a conservative charset. */
const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const TOKEN_LINE = /^(\S+)\s+([0-9a-fA-F]{64})$/;

/**
 * Parse a tokens file: `name sha256hex` per line, `#` comments and blank lines
 * allowed. A malformed line, a repeated name or a repeated hash is skipped and
 * reported by line number, never by content: skipping fails closed, since a
 * line that cannot be read grants nothing.
 */
export function parseTokensFile(text: string): { tokens: CuratorToken[]; invalidLines: number[] } {
  const tokens: CuratorToken[] = [];
  const invalidLines: number[] = [];
  const names = new Set<string>();
  const hashes = new Set<string>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = TOKEN_LINE.exec(line);
    const hash = m?.[2]?.toLowerCase();
    if (!m || !hash || !TOKEN_NAME.test(m[1]!) || names.has(m[1]!) || hashes.has(hash)) {
      invalidLines.push(i + 1);
      continue;
    }
    names.add(m[1]!);
    hashes.add(hash);
    tokens.push({ name: m[1]!, hash: Buffer.from(hash, "hex") });
  }
  return { tokens, invalidLines };
}

/** SHA-256 hex of a token: what the tokens file stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new personal token: 256 random bits, base64url, with a recognisable prefix for secret scanners. */
export function generateToken(): string {
  return `amira_cur_${randomBytes(32).toString("base64url")}`;
}

/** `Authorization: Bearer <token>`; the token as sent, or null. */
const BEARER = /^Bearer +([\x21-\x7e]{16,512})$/i;

export interface TokenStore {
  /** The curator's name for a valid `Authorization` header, else null. */
  check(header: string | undefined): string | null;
  /** Active tokens after the last read (tests, startup check). */
  readonly size: number;
}

/**
 * The tokens file, re-read at most every `reloadMs` (default 2 s) on demand, so
 * deleting a line revokes that curator within seconds. A missing or unreadable
 * file grants nothing until it is readable again.
 */
export function createTokenStore(file: string, opts: { reloadMs?: number; log?: (msg: string) => void } = {}): TokenStore {
  const reloadMs = opts.reloadMs ?? 2000;
  const log = opts.log ?? ((msg: string) => console.error(`[amira] ${msg}`));
  let tokens: CuratorToken[] = [];
  let loadedAt = -Infinity;
  let lastReport = "";
  const report = (msg: string) => {
    if (msg !== lastReport) log(msg);
    lastReport = msg;
  };
  const load = () => {
    loadedAt = Date.now();
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (err) {
      tokens = [];
      report(`AMIRA_MCP_TOKENS_FILE is unreadable (${(err as NodeJS.ErrnoException).code ?? "error"}); refusing every token`);
      return;
    }
    const parsed = parseTokensFile(text);
    tokens = parsed.tokens;
    report(`curator tokens: ${tokens.length} active` +
      (parsed.invalidLines.length ? `; ignored malformed or repeated line(s) ${parsed.invalidLines.join(", ")}` : ""));
  };
  load();
  return {
    check(header) {
      const m = typeof header === "string" ? BEARER.exec(header.trim()) : null;
      if (!m) return null;
      if (Date.now() - loadedAt >= reloadMs) load();
      const digest = createHash("sha256").update(m[1]!, "utf8").digest();
      // Compare against every entry, in constant time each, so neither the
      // outcome nor the position of a match shows in the timing.
      let name: string | null = null;
      for (const t of tokens) if (timingSafeEqual(digest, t.hash) && name === null) name = t.name;
      return name;
    },
    get size() {
      if (Date.now() - loadedAt >= reloadMs) load();
      return tokens.length;
    },
  };
}

// --- startup checks -----------------------------------------------------------------

export type EntryPoint = "http" | "stdio" | "fetch";

/**
 * Every reason this process must not start, as messages that quote no secret.
 * Curator mode needs the key, the tokens, an explicit (tmpfs) cache directory
 * and a refresh interval shorter than the maximum staleness; it runs over HTTP
 * only. Public mode refuses curator-only settings.
 */
export function accessConfigErrors(entry: EntryPoint, cfg: typeof config = config): string[] {
  const errors: string[] = [];
  if (cfg.accessSetting !== "public" && cfg.accessSetting !== "curator") {
    return [`AMIRA_ACCESS must be "public" or "curator" (got ${JSON.stringify(cfg.accessSetting.slice(0, 40))})`];
  }
  if (cfg.apiBaseSetting !== null) {
    try {
      normalizeApiBase(cfg.apiBaseSetting);
    } catch {
      errors.push("AMIRA_API_BASE must be an absolute http(s) URL without credentials, query or fragment, such as http://web/api");
    }
  }
  if (cfg.access === "public") {
    if (cfg.omekaKeyFile) errors.push("AMIRA_OMEKA_KEY_FILE is set but AMIRA_ACCESS is public: a public server never holds an Omeka key");
    if (cfg.tokensFile) errors.push("AMIRA_MCP_TOKENS_FILE is a curator-mode setting; set AMIRA_ACCESS=curator or remove it");
    return errors;
  }
  if (entry === "stdio") {
    errors.push("curator mode serves over HTTP only (server/http.js); the stdio server and the .mcpb are public");
  }
  if (entry === "fetch") {
    errors.push("fetch-data builds the public bundled snapshot and never runs in curator mode");
  }
  if (!cfg.omekaKeyFile) errors.push("curator mode needs AMIRA_OMEKA_KEY_FILE (a file with key_identity and key_credential)");
  else {
    try {
      readOmekaKeyFile(cfg.omekaKeyFile);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (entry === "http") {
    if (!cfg.tokensFile) errors.push("curator mode needs AMIRA_MCP_TOKENS_FILE (one `name sha256hex` line per curator)");
    else {
      let text: string | null = null;
      try {
        text = fs.readFileSync(cfg.tokensFile, "utf8");
      } catch (err) {
        errors.push(`AMIRA_MCP_TOKENS_FILE is unreadable (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      }
      if (text !== null && !parseTokensFile(text).tokens.length) errors.push("AMIRA_MCP_TOKENS_FILE holds no valid token");
    }
    if (cfg.bearerTokenConfigured) {
      errors.push("AMIRA_MCP_TOKEN_FILE / AMIRA_MCP_BEARER_TOKEN (one shared token) are refused in curator mode; use AMIRA_MCP_TOKENS_FILE");
    }
  }
  if (!/^[a-z_]+(\/\d+)?(\?[^\s#]*)?$/.test(cfg.curatorAuthProbe) || /key_(identity|credential)/i.test(cfg.curatorAuthProbe)) {
    errors.push("AMIRA_CURATOR_AUTH_PROBE must be an API path relative to the API base, such as items?is_public=0&per_page=1, without key parameters");
  }
  if (!cfg.cacheDirConfigured) errors.push("curator mode needs AMIRA_CACHE_DIR set explicitly, on tmpfs (private data is cached there)");
  if (!(cfg.curatorMaxStaleHours > 0)) errors.push("AMIRA_CURATOR_MAX_STALE_HOURS must be greater than 0");
  else if (cfg.liveRefresh && !(cfg.refreshIntervalHours > 0 && cfg.refreshIntervalHours < cfg.curatorMaxStaleHours)) {
    errors.push("AMIRA_REFRESH_INTERVAL_HOURS must be greater than 0 and less than AMIRA_CURATOR_MAX_STALE_HOURS in curator mode");
  }
  return errors;
}

/** Exit the process with every reason when the configuration is refused. */
export function refuseMisconfiguration(entry: EntryPoint): void {
  const errors = accessConfigErrors(entry);
  if (!errors.length) return;
  for (const e of errors) console.error(`[amira] refusing to start: ${e}`);
  process.exit(1);
}
