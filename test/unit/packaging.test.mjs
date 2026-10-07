import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import YAML from "yaml";
import { packBundle, validateManifest } from "../../scripts/mcpb.mjs";
import { hermeticEnv, REPO_ROOT, tempDir } from "../helpers/env.mjs";

hermeticEnv();

function fixture(t) {
  const root = tempDir("packaging");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const filename = path.join(root, name);
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  };
  const manifest = {
    manifest_version: "0.3", name: "fixture", version: "1.0.0",
    description: "Packaging fixture", author: { name: "AMIRA" }, icon: "icon.png",
    server: { type: "node", entry_point: "server/index.js", mcp_config: { command: "node", args: ["${__dirname}/server/index.js"] } },
  };
  write("manifest.json", manifest);
  write("package.json", { version: "1.0.0", type: "module" });
  write("server/index.js", 'console.log("packaged server");\n');
  write("icon.png", readFileSync(new URL("../../icon.png", import.meta.url)));
  return { root, write, manifest, manifestFile: path.join(root, "manifest.json"), output: path.join(root, "fixture.mcpb") };
}

test("vendored MCPB schema retains the upstream bytes", () => {
  const schema = readFileSync(new URL("../../scripts/vendor/mcpb/manifest-v0.3.schema.json", import.meta.url));
  assert.equal(createHash("sha256").update(schema).digest("hex"), "3a0ac9d845711a1b9b17dfa5a52f8b60628239d6a86a9db417206a9efc78592d");
});

test("manifest validation enforces the official schema and explicit version", (t) => {
  const { write, manifest, manifestFile } = fixture(t);
  assert.deepEqual(validateManifest(manifestFile), manifest);
  for (const invalid of [
    { ...manifest, unknown_field: true },
    { ...manifest, author: {} },
    { ...manifest, homepage: "not a URL" },
    { ...manifest, manifest_version: undefined },
    { ...manifest, manifest_version: "0.4" },
    { ...manifest, tools: [{ name: 123 }] },
  ]) {
    write("manifest.json", invalid);
    assert.throws(() => validateManifest(manifestFile), /Invalid MCPB manifest|Expected manifest_version/);
  }
});

test("packer preserves bundle layout, binary assets and snapshot generations with gitignore semantics", (t) => {
  const { root, write, output } = fixture(t);
  const pointer = { generation: "fixture-generation" };
  write("data/active.json", pointer);
  write("data/generations/fixture-generation/metadata.json", { title: "Études africaines" });
  write(".claude/skills/amira-mcp/SKILL.md", "Companion skill");
  write("docs/kept.md", "kept");
  write("docs/omitted.md", "omitted");
  write("scripts/dev.mjs", "omitted");
  write(".mcpbignore", "scripts/\ndocs/*\n!docs/kept.md\n!.env\n!node_modules/\n");
  for (const name of ["node_modules/secret.js", ".git/config", ".env", "docs/.env.local", ".npmrc", "package-lock.json", "previous.mcpb"]) {
    write(name, "never ship");
  }
  const result = packBundle(root, output);
  const contents = unzipSync(readFileSync(output));
  assert.deepEqual(Object.keys(contents).sort(), [
    ".claude/skills/amira-mcp/SKILL.md", "data/active.json",
    "data/generations/fixture-generation/metadata.json", "docs/kept.md", "icon.png",
    "manifest.json", "package.json", "server/index.js",
  ]);
  assert.equal(result.files.length, 8);
  assert.deepEqual(Buffer.from(contents["icon.png"]), readFileSync(path.join(root, "icon.png")));
  assert.deepEqual(JSON.parse(Buffer.from(contents["data/active.json"]).toString()), pointer);
  assert.equal(JSON.parse(Buffer.from(contents["data/generations/fixture-generation/metadata.json"]).toString()).title, "Études africaines");
  // Existing archives are excluded; repeated builds of identical input match.
  const first = readFileSync(output);
  packBundle(root, output);
  assert.deepEqual(readFileSync(output), first);
});

test("validation rejects absent, unsafe and mismatched bundle files", (t) => {
  const { root, write, manifest, manifestFile } = fixture(t);
  for (const entry_point of ["../outside.js", "/absolute.js", "C:/outside.js", "server\\index.js", "server/../index.js"]) {
    write("manifest.json", { ...manifest, server: { ...manifest.server, entry_point } });
    assert.throws(() => validateManifest(manifestFile), /Unsafe bundle path/);
  }
  write("manifest.json", manifest);
  write("package.json", { version: "2.0.0" });
  assert.throws(() => validateManifest(manifestFile), /versions differ/);
  write("package.json", { version: "1.0.0" });
  write("icon.png", "not a PNG");
  assert.throws(() => validateManifest(manifestFile), /local PNG/);
  rmSync(path.join(root, "server/index.js"));
  assert.throws(() => validateManifest(manifestFile), /ENOENT/);
});

test("packing fails before replacing the previous artifact if a required file is excluded", (t) => {
  const { root, write, output } = fixture(t);
  for (const required of ["manifest.json", "package.json", "server/", "icon.png"]) {
    write(".mcpbignore", required);
    write("fixture.mcpb", "previous artifact");
    assert.throws(() => packBundle(root, output), /Required file excluded/);
    assert.equal(readFileSync(output, "utf8"), "previous artifact");
  }
  assert.throws(() => packBundle(root, path.join(root, "manifest.json")), /Output must end in .mcpb/);
});

test("packing rejects linked directories including a linked required entry point", (t) => {
  const { root, write, manifest, manifestFile, output } = fixture(t);
  // Junctions work without Windows developer mode; Unix uses a directory symlink.
  symlinkSync(path.join(root, "server"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => packBundle(root, output), /Symlinks are not supported/);
  write("manifest.json", { ...manifest, server: { ...manifest.server, entry_point: "linked/index.js" } });
  assert.throws(() => validateManifest(manifestFile), /Symlinks are not supported/);
});

// --- the REAL artifact --------------------------------------------------------
// The fixture tests above prove the packer honours .mcpbignore; this one proves
// .mcpbignore itself is right, by packing the actual repository and checking
// every entry against what the extension needs at runtime. The entry point is
// server/index.js (manifest `server.entry_point`): server/http.js, lib.js and
// fetchCli.js are dead weight there, as are docs/ and the container files.

const ALLOWED_ENTRIES = [
  /^manifest\.json$/,
  /^package\.json$/,
  /^icon\.png$/,
  /^CITATION\.cff$/,
  /^LICENSE$/,
  /^README\.md$/,
  /^ROADMAP\.md$/,
  /^server\/index\.js$/,
  /^data\/[^/]+\.json$/, // flat snapshot layout (writeSnapshot)
  /^data\/generations\/[^/]+\/[^/]+\.json$/, // generational layout (`npm run fetch-data`)
  /^\.claude\/skills\/amira-mcp\/.+$/, // companion skill
];
const REQUIRED_ENTRIES = [
  "manifest.json", "package.json", "icon.png", "CITATION.cff", "LICENSE", "README.md", "ROADMAP.md",
  "server/index.js", ".claude/skills/amira-mcp/SKILL.md",
];

/** Entry names of a ZIP archive without inflating any of them. */
function archiveEntries(file, read = () => false) {
  const names = [];
  const files = unzipSync(readFileSync(file), { filter(entry) { names.push(entry.name); return read(entry.name); } });
  return { names: names.sort(), files };
}

test("the real repository packs to an allowlisted .mcpb", { timeout: 120_000 }, (t) => {
  if (!existsSync(path.join(REPO_ROOT, "data"))) {
    t.skip("data/ is absent: run `npm run fetch-data` (or `node scripts/fixture-snapshot.mjs`) to check the real artifact");
    return;
  }
  if (!existsSync(path.join(REPO_ROOT, "server", "index.js"))) {
    t.skip("server/ is not built: run `npm run build` to check the real artifact");
    return;
  }
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.server.entry_point, "server/index.js", "the allowlist assumes this entry point");
  const icons = new Set([manifest.icon, ...(manifest.icons ?? []).map((icon) => icon.src)].filter(Boolean));

  const output = path.join(tempDir("packaging-real"), "real.mcpb");
  packBundle(REPO_ROOT, output);
  const { names, files } = archiveEntries(output, (name) => name === "data/active.json");

  const unexpected = names.filter((name) => !icons.has(name) && !ALLOWED_ENTRIES.some((re) => re.test(name)));
  assert.deepEqual(unexpected, [], `entries outside the allowlist — add them to .mcpbignore:\n  ${unexpected.join("\n  ")}`);
  const missing = [...REQUIRED_ENTRIES, ...icons].filter((name) => !names.includes(name));
  assert.deepEqual(missing, [], "required runtime files missing from the archive");

  // The snapshot manifest: data/manifest.json in the flat layout, or the
  // active generation's manifest when data/active.json points at one.
  const pointer = files["data/active.json"] && JSON.parse(Buffer.from(files["data/active.json"]).toString("utf8"));
  const snapshotManifest = pointer ? `data/generations/${pointer.current}/manifest.json` : "data/manifest.json";
  assert.ok(names.includes(snapshotManifest), `${snapshotManifest} is in the archive`);
});

test("author, email and version agree across package.json, manifest.json and CITATION.cff", () => {
  const text = Object.fromEntries(["package.json", "manifest.json", "CITATION.cff"].map(
    (name) => [name, readFileSync(path.join(REPO_ROOT, name), "utf8")],
  ));
  // UTF-8 read back as Latin-1 (é → Ã©, non-breaking space → Â ) is how
  // v1.18.0 shipped `FrÃ©dÃ©rick` in package.json.
  for (const [name, body] of Object.entries(text)) assert.doesNotMatch(body, /Ã.|Â./, `${name}: mojibake`);

  const pkg = JSON.parse(text["package.json"]);
  const manifest = JSON.parse(text["manifest.json"]);
  const [cffAuthor] = YAML.parse(text["CITATION.cff"]).authors;
  const cffName = `${cffAuthor["given-names"]} ${cffAuthor["family-names"]}`;
  assert.equal(pkg.author.name, manifest.author.name, "package.json vs manifest.json author name");
  assert.equal(manifest.author.name, cffName, "manifest.json vs CITATION.cff author name");
  assert.equal(pkg.author.email, manifest.author.email, "package.json vs manifest.json author email");
  assert.equal(manifest.author.email, cffAuthor.email, "manifest.json vs CITATION.cff author email");
  assert.equal(manifest.version, pkg.version, "manifest.json vs package.json version");
});
