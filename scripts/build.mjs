// Bundle the TypeScript server into a single ESM file at server/index.js.
//
// Unlike the IWAC server, there are no native bindings or optional cloud SDKs to
// keep external — the MCP SDK and zod inline cleanly, so the packed bundle is a
// single self-contained server/index.js plus the read-only JSON snapshot in
// data/. Nothing is required from node_modules at runtime.
import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // src/index.ts starts with `#!/usr/bin/env node`; esbuild hoists that shebang
  // to line 1 of the bundle.
  legalComments: "none",
  // esbuild emits `import { createRequire }`-style shims for the few CJS deps
  // the MCP SDK pulls in (express/hono/jose); this banner makes `require`,
  // `__dirname`, and `__filename` available inside the ESM bundle.
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
