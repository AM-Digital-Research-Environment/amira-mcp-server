// Read-only release preflight, ported from the IWAC server. A tag whose
// version already exists on GitHub or the MCP Registry is refused before
// anything is built or published: released bytes are never replaced, so a
// broken release is fixed with a new version, never by moving its tag (as
// happened to v1.26.0). Run before any GitHub, GHCR or Registry mutation.
//
//   TAG=v1.31.0 GITHUB_REPOSITORY=owner/repo GH_TOKEN=… node scripts/release-guard.mjs
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const TIMEOUT_MS = 20_000;
const REGISTRY_NAME = "io.github.AM-Digital-Research-Environment/amira-mcp-server";

/**
 * One lookup, retried while its answer says nothing about the version: a
 * timeout, a network error, a 5xx or a 429. Only a definite 404 lets the
 * release proceed; any other answer fails closed, by name, once the attempts
 * run out, and a 403 or other 4xx fails at once.
 */
async function assertAbsent(check, { fetchImpl, attempts, retryDelayMs, sleep }) {
  let reason = "no attempt made";
  let made = 0;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    made = attempt;
    if (attempt > 1) await sleep(retryDelayMs * 2 ** (attempt - 2));
    let response;
    try {
      response = await fetchImpl(check.url, { headers: check.headers, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
    } catch (err) {
      reason = err?.name === "TimeoutError" ? `timed out after ${TIMEOUT_MS / 1000}s` : String(err?.message ?? err);
      continue;
    }
    if (response.status === 404) return;
    if (response.ok) throw new Error(`${check.name} already exists; publish a new version instead of replacing released assets`);
    reason = `HTTP ${response.status}`;
    if (response.status !== 429 && response.status < 500) break;
  }
  throw new Error(`${check.name} preflight failed (${reason}, ${made} attempt${made === 1 ? "" : "s"}); refusing publication`);
}

export async function assertUnpublished({
  tag, repository, version, manifestVersion, token, fetchImpl = fetch,
  attempts = 4, retryDelayMs = 5_000, sleep = delay,
}) {
  if (!/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag ?? "") || tag !== `v${version}` || version !== manifestVersion) {
    throw new Error("Release tag, package.json and manifest.json versions must match");
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) throw new Error("Invalid GitHub repository");
  const checks = [
    {
      name: `GitHub release ${tag}`,
      url: `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
      headers: { Accept: "application/vnd.github+json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    },
    {
      name: `MCP Registry version ${version}`,
      url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(REGISTRY_NAME)}/versions/${encodeURIComponent(version)}?include_deleted=true`,
      headers: {},
    },
  ];
  for (const check of checks) await assertAbsent(check, { fetchImpl, attempts, retryDelayMs, sleep });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  await assertUnpublished({
    tag: process.env.TAG, repository: process.env.GITHUB_REPOSITORY,
    version: pkg.version, manifestVersion: manifest.version, token: process.env.GH_TOKEN,
  });
  console.log(`Release preflight passed for ${process.env.TAG}`);
}
