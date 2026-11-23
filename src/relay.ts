// Curator relay (#26): how the .mcpb reaches the curator server for clients
// that cannot send a header, such as Claude Desktop, whose custom connectors
// offer OAuth or nothing. With AMIRA_CURATOR_TOKEN set, the stdio process loads
// no snapshot and holds no private data: it is a stdio MCP server on one side
// and a Streamable HTTP client of the curator endpoint on the other, and it
// forwards every JSON-RPC message both ways, unchanged.
//
// A message-level proxy rather than a Client wired to a Server: re-serving the
// remote's tools, resources, prompts and completions through local handlers
// would have to re-declare each method and capability, and would hide whatever
// the remote adds later. Forwarding raw messages keeps the remote's
// capabilities, instructions, serverInfo, protocol era, progress, logging and
// list_changed notifications exactly as the curator server sends them. The two
// SDK transports still own the framing: newline-delimited JSON on stdio, and
// the POST/SSE exchange, the protocol-version headers and the session id (none:
// the curator endpoint is stateless) on HTTP.
//
// It fails closed. A rejected token (401/403) or an unreachable server answers
// each request with a JSON-RPC error that says so; nothing falls back to the
// public dataset. The token is sent only in the Authorization header and is
// redacted from every line this module logs or returns.
import type { Readable, Writable } from "node:stream";
import {
  isJSONRPCErrorResponse,
  isJSONRPCNotification,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { TOKEN_CHARS } from "./access.js";

/**
 * The personal token as it goes into the header. A pasted `Bearer ` prefix is
 * dropped; anything that could not be a header value, or that the curator
 * server would refuse by its length, is refused without being quoted.
 */
export function normalizeCuratorToken(raw: string): string {
  const token = raw.trim().replace(/^bearer\s+/i, "");
  if (!TOKEN_CHARS.test(token)) {
    throw new Error("AMIRA_CURATOR_TOKEN is malformed: paste the personal token exactly as issued (printable characters, no spaces)");
  }
  return token;
}

/** `text` with the token, and any bearer credential, replaced by `[redacted]`. */
export function redactToken(text: string, token: string): string {
  const out = token ? text.split(token).join("[redacted]") : text;
  return out.replace(/(bearer\s+)[\x21-\x7e]+/gi, "$1[redacted]");
}

export type RelayFailure = "unauthorized" | "unreachable" | "http_error" | "no_answer" | "not_mcp" | "timeout";

/** The text of a failure for a log line: one line, at most `max` characters (the SDK quotes response bodies). */
export function truncateForLog(text: string, max = 300): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}… [${line.length - max} more characters]` : line;
}

/** A failure as the client sees it: a reason code and a message that quotes no secret. */
export function describeRelayError(err: unknown, url: URL): { reason: RelayFailure; message: string } {
  const where = `${url.origin}${url.pathname}`;
  const noFallback = "No public data is served in its place.";
  const e = err as { name?: string; status?: unknown; cause?: { code?: unknown }; code?: unknown; message?: unknown; timeoutSeconds?: unknown };
  if (e?.name === "RelayTimeout") {
    return {
      reason: "timeout",
      message: `AMIRA curator relay: the curator server at ${where} did not answer within ${String(e.timeoutSeconds)} s ` +
        `(AMIRA_CURATOR_RELAY_TIMEOUT_SECONDS). ${noFallback}`,
    };
  }
  const status = typeof e?.status === "number" ? e.status : undefined;
  if (status === 401 || status === 403 || e?.name === "UnauthorizedError") {
    return {
      reason: "unauthorized",
      message: `AMIRA curator relay: curator token rejected or revoked${status ? ` (HTTP ${status})` : ""}. ` +
        `Check the token in the extension settings, or clear it for the public dataset. ${noFallback}`,
    };
  }
  if (status !== undefined) {
    const hint = status >= 300 && status < 400 ? "it redirected; check the curator URL" : "try again later";
    return {
      reason: "http_error",
      message: `AMIRA curator relay: the curator server at ${where} answered HTTP ${status} (${hint}). ${noFallback}`,
    };
  }
  if (e?.name === "StreamClosedError") {
    return { reason: "no_answer", message: `AMIRA curator relay: the curator server at ${where} closed the response without answering. ${noFallback}` };
  }
  // An answer that is not MCP at all: a non-MCP content type, a body that is
  // not JSON, or JSON that is not a JSON-RPC message. Typically a captive
  // portal or a proxy's HTML page answering in the server's place.
  if (e?.code === "CLIENT_HTTP_UNEXPECTED_CONTENT" || e?.name === "SyntaxError" || e?.name === "ZodError" || e?.name === "$ZodError") {
    return {
      reason: "not_mcp",
      message: `AMIRA curator relay: something at ${where} answered, but not with an MCP response (a captive portal, ` +
        `a proxy page or a wrong curator URL?). Sign in to the network or check the curator URL. ${noFallback}`,
    };
  }
  const code = [e?.cause?.code, e?.code].find((c) => typeof c === "string" && /^[A-Z_]{3,40}$/.test(c));
  return {
    reason: "unreachable",
    message: `AMIRA curator relay: cannot reach the curator server at ${where}${code ? ` (${code})` : ""}. ` +
      `Check your connection, or clear the curator token in the extension settings for the public dataset. ${noFallback}`,
  };
}

/** JSON-RPC internal error: the relay could not get an answer from the curator server. */
const RELAY_ERROR_CODE = -32603;

export interface RelayOptions {
  /** The curator endpoint (already checked with curatorUrlError). */
  url: URL;
  /** The personal token (already normalised). */
  token: string;
  stdin?: Readable;
  stdout?: Writable;
  /** Where log lines go (stderr by default); every line is redacted first. */
  log?: (line: string) => void;
  /** Answer a request with a relay error when the curator server has not answered it within this long (default 300 s). */
  timeoutMs?: number;
}

export interface RelayHandle {
  /** Resolves when the stdio side has closed and the relay has shut down. */
  closed: Promise<void>;
  close(): Promise<void>;
}

/** Pending requests are keyed by type as well as value: id 1 and id "1" are different requests. */
const keyOf = (id: RequestId): string => `${typeof id}:${String(id)}`;

/**
 * Start relaying: stdio in, Streamable HTTP out. Nothing is loaded or written
 * locally; the remote's answers are passed through as they arrive.
 */
export async function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const { url, token } = opts;
  const sink = opts.log ?? ((line: string) => console.error(line));
  const log = (line: string) => sink(redactToken(line, token));

  const local = new StdioServerTransport(opts.stdin, opts.stdout);
  const remote = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });

  const timeoutMs = opts.timeoutMs ?? 300_000;
  /** Requests forwarded and not yet answered, so a failure can answer them and a cancellation can abort them. */
  const pending = new Map<string, { id: RequestId; method: string; controller: AbortController; timer: ReturnType<typeof setTimeout> }>();
  /** Take a request out of `pending` (answered, failed, cancelled or timed out); its entry, if it was still there. */
  const settle = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return undefined;
    pending.delete(key);
    clearTimeout(entry.timer);
    return entry;
  };
  /**
   * Errors already logged and answered by a send's own failure handler. The SDK
   * reports a failed POST twice, to `onerror` and as the send's rejection, with
   * the same error object; `onerror` defers its line and skips these.
   */
  const handled = new WeakSet<object>();

  const toClient = (message: JSONRPCMessage) =>
    local.send(message).catch((err) => log(`[amira] relay: could not write to stdout: ${truncateForLog((err as Error).message)}`));

  const answerWithError = (key: string, err: unknown) => {
    const entry = settle(key);
    if (!entry) return;
    const { reason, message } = describeRelayError(err, url);
    log(`[amira] relay: ${entry.method} failed: ${message}`);
    void toClient({ jsonrpc: "2.0", id: entry.id, error: { code: RELAY_ERROR_CODE, message, data: { reason } } });
  };

  local.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      const key = keyOf(message.id);
      const controller = new AbortController();
      // Whether the pending entry for this id is still this request's: a client
      // reusing an id in flight hands it to the newer request (#55).
      const ours = () => pending.get(key)?.controller === controller;
      // The relay's own deadline: without it, a request whose answer never
      // comes (a hung server that keeps the stream open) would wait forever.
      const timer = setTimeout(() => {
        if (!ours()) return;
        answerWithError(key, Object.assign(new Error("relay timeout"), { name: "RelayTimeout", timeoutSeconds: Math.round(timeoutMs / 1000) }));
        controller.abort();
      }, timeoutMs);
      timer.unref?.();
      // A client reusing an id in flight: the newer request owns it, and the older exchange is aborted.
      settle(key)?.controller.abort();
      pending.set(key, { id: message.id, method: message.method, controller, timer });
      remote
        .send(message, {
          requestSignal: controller.signal,
          // The response stream ended (after any reconnection attempts) without an answer.
          onRequestStreamEnd: () => {
            if (!controller.signal.aborted && ours()) {
              answerWithError(key, Object.assign(new Error("no answer"), { name: "StreamClosedError" }));
            }
          },
        })
        .catch((err) => {
          if (err && typeof err === "object") handled.add(err);
          if (controller.signal.aborted) {
            if (ours()) settle(key);
          } else if (ours()) answerWithError(key, err);
        });
      return;
    }
    if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      // Abort the request's own HTTP exchange (the stateless server's
      // cancellation signal), then forward the notification as well.
      const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      const entry = requestId === undefined ? undefined : pending.get(keyOf(requestId));
      if (entry) {
        settle(keyOf(entry.id));
        entry.controller.abort();
      }
    }
    // Notifications, and the client's answers to server-initiated requests.
    // The curator endpoint is stateless: an answer posted back arrives as a new
    // HTTP request the server cannot correlate with the stream that asked, so
    // server-initiated requests (sampling, elicitation, roots) do not work
    // through the relay. The curator server sends none; the answers are still
    // forwarded so a future stateful server would see them.
    const what = isJSONRPCNotification(message) ? message.method : "a response";
    remote.send(message).catch((err) => {
      if (err && typeof err === "object") handled.add(err);
      log(`[amira] relay: could not forward ${what}: ${describeRelayError(err, url).message}`);
    });
  };

  remote.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const key = message.id === undefined || message.id === null ? null : keyOf(message.id);
      const entry = key === null ? undefined : pending.get(key);
      if (entry && key !== null) {
        settle(key);
        // A 2025-era handshake: later requests carry the negotiated version as
        // a header. (2026-era requests carry it in their own _meta envelope.)
        const version = isJSONRPCResultResponse(message) ? (message.result as { protocolVersion?: unknown }).protocolVersion : undefined;
        if (entry.method === "initialize" && typeof version === "string") remote.setProtocolVersion(version);
      }
    }
    void toClient(message);
  };

  // The transport reports every failure here, send failures included, which are
  // answered and logged above. Log only the others (the SSE GET stream, …):
  // a tick later, so a send's rejection can mark its error handled first;
  // once, redacted, and truncated, since the SDK's message quotes the body.
  remote.onerror = (err) => {
    setImmediate(() => {
      if (!handled.has(err)) log(`[amira] relay: ${truncateForLog(err.message)}`);
    });
  };
  local.onerror = (err) => log(`[amira] relay: stdio error: ${truncateForLog(err.message)}`);

  let closing: Promise<void> | null = null;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.controller.abort();
      }
      pending.clear();
      try {
        await remote.close();
      } finally {
        await local.close().catch(() => {});
        markClosed();
      }
    })();
    return closing;
  };
  local.onclose = () => void close();

  await remote.start();
  await local.start();
  return { closed, close };
}
