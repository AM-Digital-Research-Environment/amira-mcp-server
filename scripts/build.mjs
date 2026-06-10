// Bundle the TypeScript server into self-contained ESM files under server/:
//   server/index.js     — the MCP server (entry of the .mcpb)
//   server/fetchCli.js  — the snapshot fetcher (build time + CI)
//
// No native bindings or optional cloud SDKs — the MCP SDK and zod inline
// cleanly, so nothing is required from node_modules at runtime. The package
// version is injected as __SERVER_VERSION__ (single source: package.json).
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await esbuild.build({
  entryPoints: ["src/index.ts", "src/fetchCli.ts", "src/lib.ts"],
  outdir: "server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Source entries start with `#!/usr/bin/env node`; esbuild hoists the
  // shebang to line 1 of each bundle.
  legalComments: "none",
  define: { __SERVER_VERSION__: JSON.stringify(pkg.version) },
  // esbuild emits `import { createRequire }`-style shims for the few CJS deps
  // the MCP SDK pulls in (express/hono/jose); this banner makes `require`,
  // `__dirname`, and `__filename` available inside the ESM bundles.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
  logLevel: "info",
});
