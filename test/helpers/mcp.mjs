// Shared MCP plumbing for tests: an in-process client/server pair, tool-result
// parsing, a PORT=0 HTTP child, and the tool surface manifest.json promises.
// Importing this module does NOT import server/lib.js — pass the lib in, after
// hermeticEnv() has run (see ./env.mjs).
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { REPO_ROOT, SERVER_HTTP, childEnv } from "./env.mjs";

/**
 * Parse a tool result's compact-JSON text body (the first content block, as
 * the existing tests always did). `isError` rides along as a NON-enumerable
 * property, so `body.isError` works while deepEqual/JSON.stringify of the
 * body are unaffected.
 */
export function parseToolResult(result, name = "tool") {
  const text = result?.content?.[0]?.text ?? "{}";
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${name}: response is not JSON: ${text.slice(0, 200)}`);
  }
  if (body !== null && typeof body === "object" && !Object.hasOwn(body, "isError")) {
    Object.defineProperty(body, "isError", { value: result.isError, enumerable: false });
  }
  return body;
}

/**
 * Connect an in-process client to `lib.createAmiraServer(opts)` over a linked
 * InMemoryTransport pair. Returns:
 *   client, server       the connected SDK objects
 *   raw(name, args)      the untouched CallToolResult
 *   call(name, args)     the parsed JSON body (+ non-enumerable isError)
 *   close()              closes both ends
 */
export async function connectInMemory(lib, opts = {}, { name = "amira-test" } = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = lib.createAmiraServer(opts);
  const client = new Client({ name, version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const raw = (tool, args = {}) => client.callTool({ name: tool, arguments: args });
  return {
    client,
    server,
    raw,
    call: async (tool, args = {}) => parseToolResult(await raw(tool, args), tool),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Parsed repo manifest.json (the .mcpb contract). */
export function readManifest() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
}

/**
 * The tool names a transport must expose: manifest.json's `tools` for stdio,
 * plus ChatGPT's `search`/`fetch` pair over HTTP (`{ http: true }`).
 */
export function expectedToolNames({ http = false } = {}) {
  const names = readManifest().tools.map((tool) => tool.name);
  return http ? [...names, "search", "fetch"] : names;
}

const LISTENING = /\bon (http:\/\/\S+?:\d+)\/mcp\b/;

/**
 * Spawn server/http.js on an OS-chosen port (PORT=0) with a sanitized child
 * env, and resolve once it logs its bound address. `env` is merged over
 * childEnv(); `forwardStderr` mirrors the child's log to ours.
 *
 * Returns { child, base, logs(), waitForLog(re, ms), alive(), exited, stop() }.
 * `exited` resolves to { code, signal }; stop() sends SIGTERM (SIGKILL after
 * 10 s) and resolves to the same.
 */
export async function spawnHttpServer({ env = {}, forwardStderr = false, readyTimeoutMs = 15_000 } = {}) {
  const child = spawn(process.execPath, [SERVER_HTTP], {
    env: childEnv({ PORT: "0", HOST: "127.0.0.1", ...env }),
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let logs = "";
  const waiters = new Set();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    logs += chunk;
    if (forwardStderr) process.stderr.write(chunk);
    for (const w of waiters) w();
  });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const alive = () => child.exitCode === null && child.signalCode === null;

  function waitForLog(pattern, timeoutMs = readyTimeoutMs) {
    return new Promise((resolve, reject) => {
      const done = (fn, value) => {
        waiters.delete(check);
        clearTimeout(timer);
        fn(value);
      };
      const check = () => {
        const match = logs.match(pattern);
        if (match) done(resolve, match);
        else if (!alive()) done(reject, new Error(`server exited before logging ${pattern}:\n${logs}`));
      };
      const timer = setTimeout(() => done(reject, new Error(`no ${pattern} after ${timeoutMs} ms:\n${logs}`)), timeoutMs);
      waiters.add(check);
      exited.then(check);
      check();
    });
  }

  async function stop() {
    if (alive()) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => alive() && child.kill("SIGKILL"), 10_000);
      try {
        return await exited;
      } finally {
        clearTimeout(timer);
      }
    }
    return exited;
  }

  try {
    const [, base] = await waitForLog(LISTENING);
    return { child, base, logs: () => logs, waitForLog, alive, exited, stop };
  } catch (err) {
    await stop();
    throw err;
  }
}

/**
 * True when a stopped server child ended the way a shutdown should: exit
 * code 0, or terminated by the SIGTERM we sent (Windows has no signal
 * handlers, so the kill is the exit). Anything else is a crash.
 */
export const exitedCleanly = ({ code, signal }) => code === 0 || (code === null && signal === "SIGTERM");
