// AMIRA's unsigned MCPB bundles are standard ZIP archives. Keep packaging
// independent of the upstream CLI's interactive editor and signing stack.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { unzipSync, zipSync } from "fflate";
import ignore from "ignore";

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const schema = JSON.parse(readFileSync(new URL("./vendor/mcpb/manifest-v0.3.schema.json", import.meta.url), "utf8"));
const validate = ajv.compile(schema);
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
// These exclusions cannot be undone by .mcpbignore negations. Runtime bundles
// are self-contained; development dependencies and local credentials never ship.
const alwaysExcluded = ignore().add([
  ".git", ".agents", ".codex", ".aws", "node_modules", ".env*", ".npmrc", ".yarnrc",
  "*.mcpb", "*.log", ".mcpbignore", "package-lock.json", "yarn.lock",
]);

function bundlePath(name) {
  if (typeof name !== "string" || /[\\:\x00]/.test(name)
    || name.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe bundle path: ${name}`);
  }
  return name;
}

function readBundleFile(root, name) {
  const parts = bundlePath(name).split("/");
  let filename = root;
  for (const part of parts) {
    filename = path.join(filename, part);
    if (lstatSync(filename).isSymbolicLink()) throw new Error(`Symlinks are not supported: ${name}`);
  }
  if (!lstatSync(filename).isFile()) throw new Error(`Not a regular bundle file: ${name}`);
  return readFileSync(filename);
}

export function validateManifest(filename) {
  const root = path.dirname(path.resolve(filename));
  const manifest = JSON.parse(readBundleFile(root, path.basename(filename)).toString("utf8"));
  if (!validate(manifest)) throw new Error(`Invalid MCPB manifest: ${ajv.errorsText(validate.errors)}`);
  // Upstream's Zod refinement requiring a version is not expressed in its JSON
  // schema. This packer supports the explicit 0.3 manifest used by this project.
  if (manifest.manifest_version !== "0.3") throw new Error("Expected manifest_version 0.3");
  if (manifest.server.type !== "node") throw new Error("AMIRA packaging requires a node server");
  readBundleFile(root, manifest.server.entry_point);
  if (manifest.icon && !readBundleFile(root, manifest.icon).subarray(0, 8).equals(pngSignature)) {
    throw new Error("Manifest icon must be a local PNG file");
  }
  // icons[] (manifest 0.3): each entry must be a local PNG whose IHDR
  // dimensions match the declared `size`, so the directory never shows a
  // mislabelled or missing image.
  for (const { src, size } of manifest.icons ?? []) {
    const png = readBundleFile(root, src);
    if (!png.subarray(0, 8).equals(pngSignature)) throw new Error(`Manifest icons entry must be a local PNG file: ${src}`);
    const actual = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
    if (actual !== size) throw new Error(`Manifest icons entry ${src} is ${actual}, not ${size}`);
  }
  const pkg = JSON.parse(readBundleFile(root, "package.json").toString("utf8"));
  if (pkg.version !== manifest.version) throw new Error("Package and manifest versions differ");
  return manifest;
}

export function packBundle(directory, output) {
  const root = path.resolve(directory);
  const destination = path.resolve(output);
  if (!destination.endsWith(".mcpb")) throw new Error("Output must end in .mcpb");
  const manifest = validateManifest(path.join(root, "manifest.json"));
  const exclusions = ignore();
  if (existsSync(path.join(root, ".mcpbignore"))) {
    exclusions.add(readBundleFile(root, ".mcpbignore").toString("utf8"));
  }
  const files = Object.create(null);
  function visit(relative = "") {
    const entries = readdirSync(path.join(root, relative), { withFileTypes: true })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const candidate = name + (entry.isDirectory() ? "/" : "");
      if (alwaysExcluded.ignores(candidate) || exclusions.ignores(candidate)) continue;
      bundlePath(name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported: ${name}`);
      if (entry.isDirectory()) { visit(name); continue; }
      if (!entry.isFile()) throw new Error(`Not a regular bundle file: ${name}`);
      const mode = lstatSync(path.join(root, name)).mode;
      files[name] = [readBundleFile(root, name), {
        // Stable timestamp and Unix attributes produce repeatable archives while
        // retaining executable bits on Unix. ZIP paths always use forward slashes.
        mtime: new Date(2000, 0, 1), os: 3, attrs: (mode & 0o777) << 16,
      }];
    }
  }
  visit();
  const iconSources = (manifest.icons ?? []).map((icon) => icon.src);
  for (const name of ["manifest.json", "package.json", manifest.server.entry_point, manifest.icon, ...iconSources].filter(Boolean)) {
    if (!Object.hasOwn(files, name)) throw new Error(`Required file excluded from bundle: ${name}`);
  }
  const archive = zipSync(files, { level: 9 });
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.mcpb`;
  try {
    writeFileSync(temporary, archive, { flag: "wx" });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
  return { files: Object.keys(files), bytes: archive.length };
}

// Entry names of a packed archive, sorted, without inflating any of them. CI
// uses this to check the real artifact rather than what .mcpbignore implies.
export function listBundle(filename) {
  const names = [];
  unzipSync(readFileSync(path.resolve(filename)), {
    filter(file) { names.push(file.name); return false; },
  });
  return names.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, input, output] = process.argv.slice(2);
    if (command === "validate" && input && !output) {
      validateManifest(input);
      console.log("MCPB manifest, bundle files and version validated");
    } else if (command === "pack" && input && output && process.argv.length === 5) {
      const result = packBundle(input, output);
      console.log(`Packed ${result.files.length} files (${result.bytes.toLocaleString("en-US")} bytes) into ${output}`);
    } else if (command === "list" && input && !output) {
      for (const name of listBundle(input)) console.log(name);
    } else {
      throw new Error("Usage: node scripts/mcpb.mjs validate manifest.json | pack DIRECTORY OUTPUT.mcpb | list BUNDLE.mcpb");
    }
  } catch (error) {
    console.error(`mcpb: ${error.message}`);
    process.exitCode = 1;
  }
}
