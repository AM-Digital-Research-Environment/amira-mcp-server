// Bundle the TypeScript server into self-contained ESM files under server/:
//   server/index.js     — the MCP server, stdio transport (entry of the .mcpb)
//   server/http.js      — the MCP server, remote Streamable HTTP transport
//   server/fetchCli.js  — the snapshot fetcher (build time + CI)
//
// No native bindings or optional cloud SDKs — the MCP SDK and zod inline
// cleanly, so nothing is required from node_modules at runtime. The package
// version is injected as __SERVER_VERSION__ (single source: package.json).
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { buildSkillsSnapshot } from "./skills.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// SEP-2640 skill catalog, validated and hashed here so the runtime needs no
// filesystem and no YAML parser. `--strict` (prepack-mcpb, CI) fails the build
// on an invalid skill; a plain `npm run build` drops it with a warning and
// ships the rest — see scripts/skills.mjs.
const strictSkills = process.argv.includes("--strict");
const skills = await buildSkillsSnapshot({ strict: strictSkills });
for (const warning of skills.warnings) console.warn(`⚠ ${warning}`);
for (const error of skills.errors) console.error(`✖ skills: ${error} — omitted from the catalog`);
console.log(
  `skills: ${skills.snapshot.skills.length} skill(s), ${skills.snapshot.resources.length} file(s)` +
    `${strictSkills ? " [strict]" : ""}`,
);

await esbuild.build({
  entryPoints: ["./src/index.ts", "./src/http.ts", "./src/fetchCli.ts", "./src/lib.ts"],
  outdir: "server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // Source entries start with `#!/usr/bin/env node`; esbuild hoists the
  // shebang to line 1 of each bundle.
  legalComments: "none",
  define: {
    __SERVER_VERSION__: JSON.stringify(pkg.version),
    // Double-encoded on purpose: `define` substitutes SOURCE TEXT, so the outer
    // stringify emits a string literal whose contents the runtime JSON.parses.
    __SKILLS_SNAPSHOT__: JSON.stringify(JSON.stringify(skills.snapshot)),
  },
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
