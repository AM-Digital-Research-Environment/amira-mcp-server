// Wait for an HTTP server's /healthz to answer 2xx. The CI container job, the
// conformance job and the release image check each had their own curl loop;
// this is the one they share.
//
//   node scripts/wait-healthz.mjs [URL] [ATTEMPTS]
//
// URL defaults to http://127.0.0.1:8787/healthz, ATTEMPTS to 30, one second
// apart, each probe bounded to 2 s so a server that accepts the connection and
// hangs cannot stall the job. Exits 0 on the first healthy answer, 1 when the
// attempts run out (the caller prints the server's log).
import { setTimeout as sleep } from "node:timers/promises";

const url = process.argv[2] ?? "http://127.0.0.1:8787/healthz";
const attempts = Number(process.argv[3] ?? 30);
if (!Number.isInteger(attempts) || attempts < 1) throw new Error(`ATTEMPTS must be a positive integer, not ${process.argv[3]}`);

let last = "no attempt made";
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (response.ok) {
      console.log(`${url} healthy after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${await response.text()}`);
      process.exit(0);
    }
    last = `HTTP ${response.status}`;
  } catch (err) {
    last = err?.name === "TimeoutError" ? "timed out after 2 s" : String(err?.cause?.code ?? err?.message ?? err);
  }
  if (attempt < attempts) await sleep(1_000);
}
console.error(`${url} not healthy after ${attempts} attempts (last: ${last})`);
process.exit(1);
