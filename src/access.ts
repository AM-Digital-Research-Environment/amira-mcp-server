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
import * as path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { normalizeApiBase } from "./snapshotIdentity.js";
import { resolveToolProfile } from "./toolProfiles.js";

export interface OmekaKey {
  identity: string;
  credential: string;
}

/** A key part: printable ASCII without spaces (Omeka generates 32 alphanumerics). */
const KEY_PART = /^[\x21-\x7e]{1,256}$/;

/**
 * Parse a key file: `key_identity=…` and `key_credential=…` lines (`#` comment
 * lines, and a `# comment` after a value as in the tokens file; `:` works as
 * well as `=`), or a JSON object with the same two keys. A `#` with no space
 * before it stays part of the value. Error messages never quote the file.
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
      const value = line.replace(/\s+#.*$/, "");
      const m = /^(key_identity|key_credential)\s*[=:]\s*(.*)$/.exec(value);
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
export const KEY_TTL_MS = 60_000;
let keyCache: { key: OmekaKey; at: number } | null = null;
/** Since when the key file has been unreadable or malformed (null while it reads). */
let keyFailingSince: number | null = null;
/** Every key value ever loaded by this process, for redaction after a rotation. */
const seenSecrets = new Set<string>();

/**
 * The Omeka service key, or null outside curator mode. Public mode never reads
 * the file, even when one is configured (it refuses to start instead).
 *
 * A key file that cannot be read or parsed fails closed, but not at once: an
 * atomic rotation (write a new file, rename it over the old one) can leave a
 * reader a moment without one. The first failure is transient (`keyFile:
 * "transient"`: the refresh is skipped and retried soon). Once the file has
 * failed for longer than one re-read interval (KEY_TTL_MS), the error is
 * flagged `omekaAuth`, like a key Omeka refuses: the caller drops the private
 * data and wipes the curator cache (src/storeLifecycle.ts). A successful read resets it.
 */
export function omekaKey(): OmekaKey | null {
  if (config.access !== "curator" || !config.omekaKeyFile) return null;
  if (!keyCache || Date.now() - keyCache.at >= KEY_TTL_MS) {
    let key: OmekaKey;
    try {
      key = readOmekaKeyFile(config.omekaKeyFile);
    } catch (err) {
      const now = Date.now();
      keyFailingSince ??= now;
      keyCache = null;
      if (now - keyFailingSince > KEY_TTL_MS) {
        throw Object.assign(new Error(`${(err as Error).message} for more than ${KEY_TTL_MS / 1000} s; treating the key as not accepted`),
          { omekaAuth: true, keyFile: "failed" });
      }
      throw Object.assign(err as Error, { keyFile: "transient" });
    }
    keyFailingSince = null;
    seenSecrets.add(key.identity);
    seenSecrets.add(key.credential);
    keyCache = { key, at: Date.now() };
  }
  return keyCache.key;
}

/** Tests: forget the cached key (and any failure streak) so the next request re-reads the file. */
export function resetOmekaKeyCache(): void {
  keyCache = null;
  keyFailingSince = null;
}

/** The key for a request to the configured Omeka API, or null for anything else (GitHub, other hosts). */
export function omekaKeyFor(url: string): OmekaKey | null {
  if (config.access !== "curator") return null;
  // The fetch base, not the public one: a key must never be sent to the public
  // URL when the deployment fetches over the internal network. config.fetchBase
  // is normalised once (src/config.ts), and every request URL is built from it.
  return url.startsWith(`${config.fetchBase}/`) ? omekaKey() : null;
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

export interface ParsedTokens {
  tokens: CuratorToken[];
  /** Every line that grants nothing: malformed, or one of a repeated name or hash. */
  invalidLines: number[];
  /** Names given on more than one line, with those lines: none of them grants anything. */
  repeatedNames: { name: string; lines: number[] }[];
  /** Line groups that share one hash (one token for several lines): none of them grants anything. */
  repeatedHashes: number[][];
}

/**
 * Parse a tokens file: `name sha256hex` per line, `#` comments and blank lines
 * allowed. A malformed line grants nothing and is reported by line number,
 * never by content.
 *
 * A name given twice grants nothing at all, on any of its lines: a rotation
 * done by appending a new line (rather than replacing the old one) would
 * otherwise keep one of the two tokens valid, and the leaked one is as likely
 * to be first as last. The same holds for one hash on several lines. Both are
 * reported loudly (the name, never the hash), so the operator replaces the line.
 */
export function parseTokensFile(text: string): ParsedTokens {
  const rows: { line: number; name: string; hash: string }[] = [];
  const invalid = new Set<number>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = TOKEN_LINE.exec(line);
    const hash = m?.[2]?.toLowerCase();
    if (!m || !hash || !TOKEN_NAME.test(m[1]!)) invalid.add(i + 1);
    else rows.push({ line: i + 1, name: m[1]!, hash });
  }
  const group = (key: (r: (typeof rows)[number]) => string) => {
    const by = new Map<string, number[]>();
    for (const r of rows) by.set(key(r), [...(by.get(key(r)) ?? []), r.line]);
    return [...by].filter(([, lines]) => lines.length > 1);
  };
  const repeatedNames = group((r) => r.name).map(([name, lines]) => ({ name, lines }));
  const repeatedHashes = group((r) => r.hash).map(([, lines]) => lines);
  for (const lines of [...repeatedNames.map((r) => r.lines), ...repeatedHashes]) for (const l of lines) invalid.add(l);
  const tokens = rows.filter((r) => !invalid.has(r.line)).map((r) => ({ name: r.name, hash: Buffer.from(r.hash, "hex") }));
  return { tokens, invalidLines: [...invalid].sort((a, b) => a - b), repeatedNames, repeatedHashes };
}

/** What a parse grants and refuses, for the log: line numbers and names, never a hash. */
export function describeTokens(parsed: ParsedTokens): string {
  const parts = [`curator tokens: ${parsed.tokens.length} active`];
  for (const { name, lines } of parsed.repeatedNames) {
    parts.push(`name ${name} is on lines ${lines.join(", ")}: refusing every token for ${name} until one line remains ` +
      "(rotate by replacing the line, never by appending one)");
  }
  for (const lines of parsed.repeatedHashes) parts.push(`lines ${lines.join(", ")} hold the same token hash: refusing it on each`);
  const repeated = new Set([...parsed.repeatedNames.flatMap((r) => r.lines), ...parsed.repeatedHashes.flat()]);
  const malformed = parsed.invalidLines.filter((l) => !repeated.has(l));
  if (malformed.length) parts.push(`ignored malformed line(s) ${malformed.join(", ")}`);
  return parts.join("; ");
}

/** SHA-256 hex of a token: what the tokens file stores. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new personal token: 256 random bits, base64url, with a recognisable prefix for secret scanners. */
export function generateToken(): string {
  return `amira_cur_${randomBytes(32).toString("base64url")}`;
}

/** Personal token length bounds, shared by the server's header check and the relay's (src/relay.ts). */
export const MIN_TOKEN_LENGTH = 16;
export const MAX_TOKEN_LENGTH = 512;
/** A token as it can travel in a header: printable ASCII without spaces, within the length bounds. */
export const TOKEN_CHARS = new RegExp(`^[\\x21-\\x7e]{${MIN_TOKEN_LENGTH},${MAX_TOKEN_LENGTH}}$`);
/** `Authorization: Bearer <token>`; the token as sent, or null. */
const BEARER = new RegExp(`^Bearer +([\\x21-\\x7e]{${MIN_TOKEN_LENGTH},${MAX_TOKEN_LENGTH}})$`, "i");

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
    report(describeTokens(parsed));
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

// --- curator relay (src/relay.ts) -------------------------------------------------

/** Hosts allowed over plain http, for tests against a local curator server. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Why AMIRA_CURATOR_URL is refused, or null when it is acceptable: https, or
 * http to localhost / 127.0.0.1 / [::1] only, and no credentials in the URL.
 * The message quotes at most the origin.
 */
export function curatorUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "AMIRA_CURATOR_URL is not an absolute URL (expected https://…/curator/mcp)";
  }
  if (url.username || url.password) return "AMIRA_CURATOR_URL must not carry credentials; the token belongs in AMIRA_CURATOR_TOKEN";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return null;
  return `AMIRA_CURATOR_URL must use https:// (plain http:// is accepted for localhost, 127.0.0.1 and [::1] only); refusing ${JSON.stringify(url.origin)}`;
}

// --- startup checks -----------------------------------------------------------------

export type EntryPoint = "http" | "stdio" | "fetch";

/** Filesystems that keep their content in memory only. */
const MEMORY_FILESYSTEMS = new Set(["tmpfs", "ramfs"]);
/** The Docker image's cache path (Dockerfile: AMIRA_DEFAULT_CACHE_DIR). */
export const IMAGE_CACHE_DIR = "/tmp/amira-cache";

/** What the host checks read; injectable so tests can describe a Linux host from anywhere. */
export interface HostProbe {
  platform?: NodeJS.Platform;
  /** The mount table (/proc/mounts), or null when unreadable. */
  mounts?: () => string | null;
  /** The real path of an absolute path (symlinks resolved); default: that of its nearest existing ancestor. */
  realpath?: (dir: string) => string;
  /** A file's mode bits, or null when it cannot be read. */
  fileMode?: (file: string) => number | null;
}

/** `dir` with symlinks resolved, through its nearest existing ancestor (the cache dir may not exist yet). */
function realPathOfNearest(dir: string): string {
  const rest: string[] = [];
  let cur = path.posix.resolve(dir);
  for (;;) {
    try {
      return path.posix.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.posix.dirname(cur);
      if (parent === cur) return path.posix.resolve(dir);
      rest.push(path.posix.basename(cur));
      cur = parent;
    }
  }
}

/** The filesystem type a mount table (the /proc/mounts format) gives the absolute path `dir`, or null. */
export function filesystemOf(dir: string, mounts: string): string | null {
  let best: { point: string; type: string } | null = null;
  for (const line of mounts.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3) continue;
    // Spaces and other odd characters in mount points are octal-escaped (\040).
    const point = fields[1]!.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
    const within = point === "/" || dir === point || dir.startsWith(`${point}/`);
    // The longest mount point wins; among equal ones, the later mount (it hides the earlier).
    if (within && (!best || point.length >= best.point.length)) best = { point, type: fields[2]! };
  }
  return best?.type ?? null;
}

/**
 * Linux only: the filesystem the cache directory lives on ("tmpfs", "ext4",
 * "overlay", …; null when the mount table is unreadable). Undefined on other
 * platforms, where the explicit-setting rule is the only check.
 */
export function cacheDirFilesystem(dir: string, probe: HostProbe = {}): string | null | undefined {
  if ((probe.platform ?? process.platform) !== "linux") return undefined;
  const mounts = (probe.mounts ?? (() => {
    try {
      return fs.readFileSync("/proc/mounts", "utf8");
    } catch {
      return null;
    }
  }))();
  if (mounts === null) return null;
  return filesystemOf((probe.realpath ?? realPathOfNearest)(path.posix.resolve(dir)), mounts);
}

const underImageCacheDir = (dir: string): boolean => {
  const resolved = path.posix.resolve(dir);
  return resolved === IMAGE_CACHE_DIR || resolved.startsWith(`${IMAGE_CACHE_DIR}/`);
};

/**
 * Every reason this process must not start, as messages that quote no secret.
 * Curator mode needs the key, the tokens, an explicit (tmpfs) cache directory
 * and a refresh interval shorter than the maximum staleness; it runs over HTTP
 * only. Public mode refuses curator-only settings.
 *
 * The cache directory: AMIRA_CACHE_DIR must be set explicitly (the image's
 * AMIRA_DEFAULT_CACHE_DIR does not count), and on Linux the image's cache path
 * (/tmp/amira-cache) is accepted only when it really is a tmpfs mount, so a
 * container started without `--tmpfs` never writes private data to its
 * overlay layer. Any other non-tmpfs directory on Linux is a warning
 * (`accessConfigWarnings`), not a refusal.
 */
export function accessConfigErrors(entry: EntryPoint, cfg: typeof config = config, probe: HostProbe = {}): string[] {
  const errors: string[] = [];
  if (cfg.accessSetting !== "public" && cfg.accessSetting !== "curator") {
    return [`AMIRA_ACCESS must be "public" or "curator" (got ${JSON.stringify(cfg.accessSetting.slice(0, 40))})`];
  }
  if (entry === "http" && !(Number.isInteger(cfg.httpPort) && cfg.httpPort >= 0 && cfg.httpPort <= 65535)) {
    errors.push(`PORT / AMIRA_HTTP_PORT must be an integer from 0 to 65535 (got ${JSON.stringify(String(cfg.httpPortSetting).slice(0, 40))})`);
  }
  // A typo would otherwise keep /healthz at 200 while every request fails (#55).
  try {
    resolveToolProfile(cfg.toolProfileSetting);
  } catch (err) {
    errors.push((err as Error).message);
  }
  if (cfg.apiBaseSetting !== null) {
    try {
      normalizeApiBase(cfg.apiBaseSetting);
    } catch {
      errors.push("AMIRA_API_BASE must be an absolute http(s) URL without credentials, query or fragment, such as http://web/api");
    }
  }
  if (cfg.curatorRelay) {
    // The relay forwards to a curator server; it never serves HTTP, never
    // crawls, and never holds an Omeka key itself.
    if (entry !== "stdio") {
      errors.push("AMIRA_CURATOR_TOKEN (the curator relay) is for the stdio server and the .mcpb only; remove it from this environment");
    }
    if (cfg.access === "curator") {
      errors.push("AMIRA_CURATOR_TOKEN and AMIRA_ACCESS=curator exclude each other: the relay forwards to a curator server and never crawls Omeka itself");
    }
    const urlError = curatorUrlError(cfg.curatorUrl);
    if (urlError) errors.push(urlError);
  }
  if (cfg.access === "public") {
    if (cfg.omekaKeyFile) errors.push("AMIRA_OMEKA_KEY_FILE is set but AMIRA_ACCESS is public: a public server never holds an Omeka key");
    if (cfg.tokensFile) errors.push("AMIRA_MCP_TOKENS_FILE is a curator-mode setting; set AMIRA_ACCESS=curator or remove it");
    // A configured guard must not vanish: a wrong mount path would otherwise
    // serve /mcp and /metrics without the token the operator asked for.
    if (entry === "http" && cfg.bearerTokenFileConfigured && !cfg.bearerToken) {
      errors.push("AMIRA_MCP_TOKEN_FILE is set but no token was read from it (unreadable or empty), and AMIRA_MCP_BEARER_TOKEN is unset");
    }
    return errors;
  }
  if (entry === "stdio") {
    errors.push("curator mode serves over HTTP only (server/http.js); the stdio server and the .mcpb are public, or relay to a curator server with AMIRA_CURATOR_TOKEN");
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
  // A list endpoint: the probe must return a non-empty array, which a single
  // resource (`items/123`) never does, so such a setting would block forever.
  if (!/^[a-z_]+(\?[^\s#]*)?$/.test(cfg.curatorAuthProbe) || /key_(identity|credential)/i.test(cfg.curatorAuthProbe)) {
    errors.push("AMIRA_CURATOR_AUTH_PROBE must be an API list path relative to the API base, such as items?is_public=0&per_page=1, " +
      "without a resource id or key parameters");
  }
  if (!cfg.cacheDirConfigured) {
    errors.push("curator mode needs AMIRA_CACHE_DIR set explicitly, on tmpfs (private data is cached there); " +
      "the Docker image's default cache path does not count");
  } else if (underImageCacheDir(cfg.cacheDir)) {
    const fsType = cacheDirFilesystem(cfg.cacheDir, probe);
    if (fsType !== undefined && !MEMORY_FILESYSTEMS.has(fsType ?? "")) {
      errors.push(`AMIRA_CACHE_DIR ${IMAGE_CACHE_DIR} (the image's cache path) is on ${fsType ?? "an unknown filesystem"}, not tmpfs: ` +
        `start the container with --tmpfs ${IMAGE_CACHE_DIR} (Compose: tmpfs), or private data would be written to its disk layer`);
    }
  }
  if (!(cfg.curatorMaxStaleHours > 0)) errors.push("AMIRA_CURATOR_MAX_STALE_HOURS must be greater than 0");
  else if (cfg.liveRefresh && !(cfg.refreshIntervalHours > 0 && cfg.refreshIntervalHours < cfg.curatorMaxStaleHours)) {
    errors.push("AMIRA_REFRESH_INTERVAL_HOURS must be greater than 0 and less than AMIRA_CURATOR_MAX_STALE_HOURS in curator mode");
  }
  return errors;
}

/**
 * Curator mode, Linux: what is accepted but unwise, logged at startup without
 * refusing. A cache directory not on tmpfs (private data reaches a disk), and a
 * key or tokens file readable by its group or by others.
 */
export function accessConfigWarnings(cfg: typeof config = config, probe: HostProbe = {}): string[] {
  if (cfg.access !== "curator" || (probe.platform ?? process.platform) !== "linux") return [];
  const warnings: string[] = [];
  if (cfg.cacheDirConfigured && !underImageCacheDir(cfg.cacheDir)) {
    const fsType = cacheDirFilesystem(cfg.cacheDir, probe);
    if (fsType !== undefined && !MEMORY_FILESYSTEMS.has(fsType ?? "")) {
      warnings.push(`AMIRA_CACHE_DIR is on ${fsType ?? "an unknown filesystem"}, not tmpfs: the private snapshot is written to disk`);
    }
  }
  const mode = probe.fileMode ?? ((file: string) => {
    try {
      return fs.statSync(file).mode;
    } catch {
      return null;
    }
  });
  for (const [name, file] of [["AMIRA_OMEKA_KEY_FILE", cfg.omekaKeyFile], ["AMIRA_MCP_TOKENS_FILE", cfg.tokensFile]] as const) {
    const bits = file ? mode(file) : null;
    if (bits !== null && bits & 0o044) {
      warnings.push(`${name} is readable by its group or by others (mode ${(bits & 0o777).toString(8).padStart(3, "0")}); ` +
        "restrict it to the server's user (chmod 600)");
    }
  }
  return warnings;
}

/** Exit the process with every reason when the configuration is refused; log the warnings otherwise. */
export function refuseMisconfiguration(entry: EntryPoint): void {
  const errors = accessConfigErrors(entry);
  if (!errors.length) {
    for (const w of accessConfigWarnings()) console.error(`[amira] warning: ${w}`);
    return;
  }
  for (const e of errors) console.error(`[amira] refusing to start: ${e}`);
  process.exit(1);
}
