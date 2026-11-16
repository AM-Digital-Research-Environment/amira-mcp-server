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


/**
 * The personal token as it goes into the header. A pasted `Bearer ` prefix is
 * dropped; anything that could not be a header value is refused without being
 * quoted.
 */
export function normalizeCuratorToken(raw: string): string {
  const token = raw.trim().replace(/^bearer\s+/i, "");
  if (!/^[\x21-\x7e]{16,1024}$/.test(token)) {
    throw new Error("AMIRA_CURATOR_TOKEN is malformed: paste the personal token exactly as issued (printable characters, no spaces)");
  }
  return token;
}

/** `text` with the token, and any bearer credential, replaced by `[redacted]`. */
export function redactToken(text: string, token: string): string {
  const out = token ? text.split(token).join("[redacted]") : text;
  return out.replace(/(bearer\s+)[\x21-\x7e]+/gi, "$1[redacted]");
}

export type RelayFailure = "unauthorized" | "unreachable" | "http_error" | "no_answer";

/** A failure as the client sees it: a reason code and a message that quotes no secret. */
export function describeRelayError(err: unknown, url: URL): { reason: RelayFailure; message: string } {
  const where = `${url.origin}${url.pathname}`;
  const noFallback = "No public data is served in its place.";
  const e = err as { name?: string; status?: unknown; cause?: { code?: unknown }; code?: unknown; message?: unknown };
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

  /** Requests forwarded and not yet answered, so a failure can answer them and a cancellation can abort them. */
  const pending = new Map<string, { id: RequestId; method: string; controller: AbortController }>();

  const toClient = (message: JSONRPCMessage) =>
    local.send(message).catch((err) => log(`[amira] relay: could not write to stdout: ${(err as Error).message}`));

  const answerWithError = (key: string, err: unknown) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    const { reason, message } = describeRelayError(err, url);
    log(`[amira] relay: ${entry.method} failed: ${message}`);
    void toClient({ jsonrpc: "2.0", id: entry.id, error: { code: RELAY_ERROR_CODE, message, data: { reason } } });
  };

  local.onmessage = (message) => {
    if (isJSONRPCRequest(message)) {
      const key = keyOf(message.id);
      const controller = new AbortController();
      pending.set(key, { id: message.id, method: message.method, controller });
      remote
        .send(message, {
          requestSignal: controller.signal,
          // The response stream ended (after any reconnection attempts) without an answer.
          onRequestStreamEnd: () => {
            if (!controller.signal.aborted && pending.has(key)) {
              answerWithError(key, Object.assign(new Error("no answer"), { name: "StreamClosedError" }));
            }
          },
        })
        .catch((err) => {
          if (controller.signal.aborted) pending.delete(key);
          else answerWithError(key, err);
        });
      return;
    }
    if (isJSONRPCNotification(message) && message.method === "notifications/cancelled") {
      // Abort the request's own HTTP exchange (the stateless server's
      // cancellation signal), then forward the notification as well.
      const requestId = (message.params as { requestId?: RequestId } | undefined)?.requestId;
      const entry = requestId === undefined ? undefined : pending.get(keyOf(requestId));
      if (entry) {
        pending.delete(keyOf(entry.id));
        entry.controller.abort();
      }
    }
    // Notifications, and the client's answers to server-initiated requests.
    const what = isJSONRPCNotification(message) ? message.method : "a response";
    remote.send(message).catch((err) => log(`[amira] relay: could not forward ${what}: ${describeRelayError(err, url).message}`));
  };

  remote.onmessage = (message) => {
    if (isJSONRPCResultResponse(message) || isJSONRPCErrorResponse(message)) {
      const key = message.id === undefined || message.id === null ? null : keyOf(message.id);
      const entry = key === null ? undefined : pending.get(key);
      if (entry && key !== null) {
        pending.delete(key);
        // A 2025-era handshake: later requests carry the negotiated version as
        // a header. (2026-era requests carry it in their own _meta envelope.)
        const version = isJSONRPCResultResponse(message) ? (message.result as { protocolVersion?: unknown }).protocolVersion : undefined;
        if (entry.method === "initialize" && typeof version === "string") remote.setProtocolVersion(version);
      }
    }
    void toClient(message);
  };

  // The transport reports every failure here as well (send failures are also
  // answered above); log them once, redacted.
  remote.onerror = (err) => log(`[amira] relay: ${err.message}`);
  local.onerror = (err) => log(`[amira] relay: stdio error: ${err.message}`);

  let closing: Promise<void> | null = null;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => (markClosed = resolve));
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const entry of pending.values()) entry.controller.abort();
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
