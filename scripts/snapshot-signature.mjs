import { createHash } from "node:crypto";
import { loadSnapshot } from "../server/lib.js";
// Include vocabulary-derived metadata, item sets and all transformed records.
const out = await loadSnapshot("data");
console.log(createHash("sha256").update(JSON.stringify(out.data)).digest("hex"));
