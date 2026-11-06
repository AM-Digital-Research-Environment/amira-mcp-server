// Freshness signature for the rolling `data-latest` release
// (.github/workflows/refresh-data.yml). The workflow republishes only when this
// value differs from the signature attached to the previous rolling release.
//
// It covers the transformed snapshot (vocabulary-derived metadata, item sets
// and every record) AND the code version from package.json. Hashing data alone
// meant a code release never refreshed the rolling .mcpb: it kept serving the
// old bundle until the Omeka data happened to change.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSnapshot } from "../server/lib.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Resolved from this file, like every other script, not from the working directory.
const out = await loadSnapshot(fileURLToPath(new URL("../data", import.meta.url)));
console.log(
  createHash("sha256")
    .update(`amira-mcp-server@${version}\n`)
    .update(JSON.stringify(out.data))
    // A new corpus-vector build changes the neighbours the bundle serves.
    .update(JSON.stringify(out.semantic?.source ?? null))
    .digest("hex"),
);
