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
import { loadSnapshot } from "../server/lib.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const out = await loadSnapshot("data");
console.log(
  createHash("sha256")
    .update(`amira-mcp-server@${version}\n`)
    .update(JSON.stringify(out.data))
    .digest("hex"),
);
