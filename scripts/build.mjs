// Bundle the TypeScript server into self-contained ESM files under server/:
//   server/index.js     — the MCP server, stdio transport (entry of the .mcpb)
//   server/http.js      — the MCP server, remote Streamable HTTP transport
//   server/fetchCli.js  — the snapshot fetcher (build time + CI)
//   server/lib.js       — the test library (src/lib.ts)
//
// No native bindings or optional cloud SDKs — the MCP SDK and zod inline
// cleanly, so nothing is required from node_modules at runtime. The package
// version is injected as __SERVER_VERSION__ (single source: package.json).
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { buildSkillsSnapshot } from "./skills.mjs";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

// --- zod locale stubbing (browser bundle only) --------------------------------
// From the IWAC server (mcpb/scripts/bundle.mjs). zod's `v4/locales/index.js`
// re-exports 50+ error-message catalogues and `v4/classic/external.js`
// re-exports that index as `z.locales`, so every catalogue lands in every
// bundle that touches zod: 258 KB of the bridge's 652 KB, for strings that can
// never fire. Only `en.js` is live (external.js imports it directly for the
// default error map) and nothing here calls `z.config(z.locales.<x>())`.
//
// Two details are load-bearing: the onLoad filter must match the RESOLVED
// absolute path (a specifier-shaped filter silently matches nothing), and the
// `index.js` barrel must not be stubbed, or `z.locales` itself disappears. The
// stub throws rather than exporting undefined, so a future caller of a
// non-English catalogue gets a message naming this plugin. All the stubs
// re-export one virtual module, so the diagnostic is paid once.
const STUB_MODULE = "amira-virtual:zod-locale-stub";
const stubZodLocales = {
  name: "stub-zod-locales",
  setup(build) {
    build.onResolve({ filter: /^amira-virtual:zod-locale-stub$/ }, (args) => ({ path: args.path, namespace: "amira-stub" }));
    build.onLoad({ filter: /.*/, namespace: "amira-stub" }, () => ({
      contents: "export default function stubbedZodLocale(){throw new Error(" +
        "\"The AMIRA app ships only zod's English locale; scripts/build.mjs stubs out the others.\")}",
      loader: "js",
    }));
    build.onLoad({ filter: /locales/ }, (args) => {
      const path = args.path.replaceAll("\\", "/");
      if (!path.includes("/zod/") || !path.includes("/locales/") || /\/(?:en|index)\.js$/.test(path)) return null;
      return { contents: `export { default } from ${JSON.stringify(STUB_MODULE)};`, loader: "js" };
    });
  },
};

// --- the MCP App page -----------------------------------------------------------
// Stage 1 bundles the browser bridge (Apps SDK + zod) to one IIFE. Stage 2
// bundles the page assembler for node and runs it from memory: it scopes the
// view CSS, appends the seven views and their router to the bridge, and
// gzip-compresses the result into ui://amira/app.html (src/ui/page.ts). The
// finished page reaches the servers as one string define, so they carry
// neither the views' source nor the Natural Earth outline nor the uncompressed
// bridge.
const bridge = await esbuild.build({ entryPoints: ["./src/ui/bridge.ts"], bundle: true,
  platform: "browser", format: "iife", target: "es2022", minify: true, write: false, legalComments: "none",
  plugins: [stubZodLocales], define: { __SERVER_VERSION__: JSON.stringify(pkg.version) } });
const bridgeJs = bridge.outputFiles[0].text;
const assembler = await esbuild.build({ entryPoints: ["./src/ui/page.ts"], bundle: true,
  platform: "node", format: "esm", target: "node22", write: false, legalComments: "none" });
const { appPage } = await import(`data:text/javascript;base64,${Buffer.from(assembler.outputFiles[0].text).toString("base64")}`);
const app = appPage(bridgeJs, (js) =>
  esbuild.transformSync(js, { minifyWhitespace: true, minifySyntax: true, legalComments: "none", target: "es2022" }).code);
// The page rides in the server bundles as a string, so esbuild's summary below
// hides it; print it, as the one artefact a new view can quietly grow.
// test/unit/apps.test.mjs enforces the budgets.
const kb = (n) => (n / 1024).toFixed(1);
console.log(`app: ui://amira/app.html ${kb(Buffer.byteLength(app.html))} KB; ` +
  `script ${kb(Buffer.byteLength(app.script))} KB decoded, ${kb(app.gzipBytes)} KB gzip`);

// SEP-2640 skill files, validated here through the SDK's own catalog loader so
// the runtime needs no filesystem. `--strict` (prepack-mcpb, CI) fails the
// build on an invalid skill; a plain `npm run build` drops it with a warning
// and ships the rest — see scripts/skills.mjs.
const strictSkills = process.argv.includes("--strict");
const skills = await buildSkillsSnapshot({ strict: strictSkills });
for (const warning of skills.warnings) console.warn(`⚠ ${warning}`);
for (const error of skills.errors) console.error(`✖ skills: ${error} — omitted from the catalog`);
console.log(
  `skills: ${skills.skills.length} skill(s), ` +
    `${Object.keys(skills.snapshot.text).length + Object.keys(skills.snapshot.base64).length} file(s)` +
    `${strictSkills ? " [strict]" : ""}`,
);

await esbuild.build({
  entryPoints: ["./src/index.ts", "./src/http.ts", "./src/fetchCli.ts", "./src/lib.ts"],
  outdir: "server",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Source entries start with `#!/usr/bin/env node`; esbuild hoists the
  // shebang to line 1 of each bundle.
  legalComments: "none",
  define: {
    __SERVER_VERSION__: JSON.stringify(pkg.version),
    __APP_HTML__: JSON.stringify(app.html),
    // Only src/lib.ts (the test library) references this one.
    __APP_BRIDGE__: JSON.stringify(bridgeJs),
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
