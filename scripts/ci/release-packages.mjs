import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PUBLISHED_PACKAGES = ["shared", "core", "core-testing"];
export const SOURCE_REPOSITORY = "https://github.com/octogee-ai/octogee-cloud";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const VERSION_TAG = /^v(\d+\.\d+\.\d+)$/;
const LOCAL_SPEC = /^(?:file:|link:|workspace:|\.{0,2}\/)/;
const DEPENDENCY_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];
const UNPUBLISHED_FIELDS = ["private", "scripts", "devDependencies", "overrides", "publishConfig"];
const MANIFEST = "package.json";
const PACKED_EXTRAS = new Set([MANIFEST, "README.md", "LICENSE"]);
const NPM = "npm";

export function releaseVersion(tag) {
  const match = VERSION_TAG.exec(tag ?? "");
  if (!match) throw new Error(`A release tag looks like v0.1.0, not ${tag}`);
  return match[1];
}

function exportEntries(manifest) {
  const exports = manifest.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    throw new Error(`${manifest.name} has no exports map`);
  }
  return Object.entries(exports).map(([subpath, target]) => {
    if (!target || typeof target !== "object" || typeof target.types !== "string" || typeof target.default !== "string") {
      throw new Error(`${manifest.name} export ${subpath} must name both types and default`);
    }
    for (const file of [target.types, target.default]) {
      if (!file.startsWith("./dist/")) throw new Error(`${manifest.name} export ${subpath} points outside dist: ${file}`);
    }
    return { subpath, types: target.types.slice(2), default: target.default.slice(2) };
  });
}

export function exportSpecifiers(manifest) {
  return exportEntries(manifest).map(({ subpath }) => (subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`));
}

export function exportFiles(manifest) {
  return exportEntries(manifest).flatMap(entry => [entry.types, entry.default]);
}

function pinnedDependencies(manifest, section, version, publishedNames) {
  const dependencies = manifest[section];
  if (!dependencies) return undefined;
  return Object.fromEntries(Object.entries(dependencies).map(([name, spec]) => {
    if (publishedNames.includes(name)) return [name, version];
    if (name.startsWith("@octogee/")) throw new Error(`${manifest.name} ${section} names ${name}, which is not in the published set`);
    if (LOCAL_SPEC.test(spec)) throw new Error(`${manifest.name} ${section} names ${name} at ${spec}, which only resolves inside this repository`);
    return [name, spec];
  }));
}

export function publishedManifest(manifest, { version, directory, publishedNames }) {
  if (!manifest.license) throw new Error(`${manifest.name} names no license`);
  if (!Array.isArray(manifest.files) || manifest.files.length !== 1 || manifest.files[0] !== "dist") {
    throw new Error(`${manifest.name} must publish exactly its dist directory ("files": ["dist"])`);
  }
  exportEntries(manifest);
  const published = { ...manifest, version };
  for (const field of UNPUBLISHED_FIELDS) delete published[field];
  for (const section of DEPENDENCY_SECTIONS) {
    const dependencies = pinnedDependencies(manifest, section, version, publishedNames);
    if (dependencies) published[section] = dependencies;
  }
  published.repository = { type: "git", url: `git+${SOURCE_REPOSITORY}.git`, directory };
  published.homepage = `${SOURCE_REPOSITORY}/tree/main/${directory}#readme`;
  return published;
}

export function unexpectedPackedFiles(manifest, packedPaths) {
  const packed = new Set(packedPaths);
  const missing = exportFiles(manifest).filter(file => !packed.has(file));
  const stray = packedPaths.filter(path => !PACKED_EXTRAS.has(path) && (!path.startsWith("dist/") || /\.(?:spec|test)\.[cm]?[jt]s$/.test(path)));
  return [...missing.map(file => `missing ${file}`), ...stray.map(file => `unexpected ${file}`)];
}

const MODULE_SPECIFIER = /(?:(?<=[\s}*])from|\bimport\(|^import) ?["']([^"']+)["']/gm;

const packageOf = specifier => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");

export function undeclaredImports(manifest, modules) {
  const declared = new Set([manifest.name, ...DEPENDENCY_SECTIONS.flatMap(section => Object.keys(manifest[section] ?? {}))]);
  const undeclared = new Set();
  for (const { path, source } of modules) {
    for (const [, specifier] of source.matchAll(MODULE_SPECIFIER)) {
      if (specifier.startsWith(".") || specifier.startsWith("node:") || builtinModules.includes(specifier.split("/")[0])) continue;
      if (!declared.has(packageOf(specifier))) undeclared.add(`${path} imports ${specifier}`);
    }
  }
  return [...undeclared].sort();
}

const readJson = path => JSON.parse(readFileSync(path, "utf8"));

function runtimeModules(directory, prefix = "") {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return runtimeModules(directory, path);
    return /\.[cm]?js$/.test(entry.name) ? [{ path, source: readFileSync(join(directory, path), "utf8") }] : [];
  });
}
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });

function packOne({ root, directory, version, publishedNames, out }) {
  const source = join(root, directory);
  const manifest = readJson(join(source, MANIFEST));
  const stage = join(out, "stage", directory);
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  run(join(source, "node_modules/.bin/tsc"), ["-p", join(source, "tsconfig.json"), "--outDir", join(stage, "dist")], { cwd: source, stdio: "inherit" });
  const published = publishedManifest(manifest, { version, directory, publishedNames });
  const undeclared = undeclaredImports(published, runtimeModules(stage));
  if (undeclared.length) throw new Error(`${manifest.name} imports packages it does not declare:\n  ${undeclared.join("\n  ")}`);
  writeFileSync(join(stage, MANIFEST), `${JSON.stringify(published, null, 2)}\n`);
  cpSync(join(root, "LICENSE"), join(stage, "LICENSE"));
  if (existsSync(join(source, "README.md"))) cpSync(join(source, "README.md"), join(stage, "README.md"));
  const [packed] = JSON.parse(run(NPM, ["pack", stage, "--pack-destination", out, "--ignore-scripts", "--json"], { cwd: out }));
  const problems = unexpectedPackedFiles(manifest, packed.files.map(file => file.path));
  if (problems.length) throw new Error(`${manifest.name} would publish wrongly:\n  ${problems.join("\n  ")}`);
  return { name: manifest.name, version, directory, tarball: join(out, packed.filename) };
}

export function pack({ root = ROOT, tag, out }) {
  const version = releaseVersion(tag);
  const directory = resolve(out);
  mkdirSync(directory, { recursive: true });
  const publishedNames = PUBLISHED_PACKAGES.map(name => readJson(join(root, name, MANIFEST)).name);
  const packages = PUBLISHED_PACKAGES.map(name => packOne({ root, directory: name, version, publishedNames, out: directory }));
  writeFileSync(join(directory, "packages.json"), `${JSON.stringify(packages, null, 2)}\n`);
  return packages;
}

const stagedManifest = entry => readJson(join(entry.tarball, "..", "stage", entry.directory, MANIFEST));

export function consumerSources(manifests) {
  const specifiers = manifests.flatMap(exportSpecifiers);
  const imports = `const specifiers = ${JSON.stringify(specifiers, null, 2)};
const failures = [];
for (const specifier of specifiers) {
  try {
    await import(specifier);
  } catch (error) {
    failures.push(\`\${specifier}: \${error instanceof Error ? error.message : error}\`);
  }
}
if (failures.length) {
  console.error(\`\${failures.length} of \${specifiers.length} exports failed to import:\\n  \${failures.join("\\n  ")}\`);
  process.exit(1);
}
console.log(\`Imported all \${specifiers.length} exports\`);
`;
  const names = specifiers.map((_, index) => `module${index}`);
  const declarations = specifiers.map((specifier, index) => `import * as ${names[index]} from "${specifier}";`);
  const types = `${declarations.join("\n")}\n\nexport const modules = [${names.join(", ")}];\n`;
  return { specifiers, imports, types };
}

export function consumerDependencies(manifests) {
  const dependencies = {};
  for (const manifest of manifests) {
    for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      const range = manifest.peerDependencies?.[name];
      if (meta?.optional && range && !manifests.some(other => other.name === name)) dependencies[name] = range;
    }
  }
  return dependencies;
}

const CONSUMER_TSCONFIG = {
  compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: ["node"] },
  include: ["types.ts"],
};

export function verify({ out, typescript, typesNode }) {
  const entries = readJson(join(resolve(out), "packages.json"));
  const manifests = entries.map(stagedManifest);
  const consumer = mkdtempSync(join(tmpdir(), "octogee-package-consumer-"));
  try {
    const { specifiers, imports, types } = consumerSources(manifests);
    writeFileSync(join(consumer, MANIFEST), `${JSON.stringify({ name: "package-consumer", private: true, type: "module" }, null, 2)}\n`);
    writeFileSync(join(consumer, "imports.mjs"), imports);
    writeFileSync(join(consumer, "types.ts"), types);
    writeFileSync(join(consumer, "tsconfig.json"), `${JSON.stringify(CONSUMER_TSCONFIG, null, 2)}\n`);
    const extras = Object.entries({ ...consumerDependencies(manifests), typescript, "@types/node": typesNode }).map(([name, range]) => `${name}@${range}`);
    run(NPM, ["install", "--no-audit", "--no-fund", ...entries.map(entry => entry.tarball), ...extras], { cwd: consumer, stdio: "inherit" });
    run("node", ["imports.mjs"], { cwd: consumer, stdio: "inherit" });
    run(join(consumer, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], { cwd: consumer, stdio: "inherit" });
    console.log(`Type-checked all ${specifiers.length} exports`);
    return { consumer, specifiers: specifiers.length };
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

// eslint-disable-next-line sonarjs/no-os-command-from-path -- npm is the release runner's own tool.
const npmView = args => spawnSync(NPM, args, { encoding: "utf8" });

export function publishedVersionExists(name, version, view = npmView) {
  const result = view(["view", `${name}@${version}`, "version", "--json"]);
  if (result.status === 0) return result.stdout.trim() !== "";
  if (/\bE404\b/.test(result.stderr ?? "")) return false;
  throw new Error(`npm view ${name}@${version} failed:\n${result.stderr}`);
}

export function publish({ out, dryRun = false, exists = publishedVersionExists, npm = args => run(NPM, args, { stdio: "inherit" }) }) {
  const entries = readJson(join(resolve(out), "packages.json"));
  const outcomes = [];
  for (const entry of entries) {
    if (exists(entry.name, entry.version)) {
      console.log(`${entry.name}@${entry.version} is already published; skipping it`);
      outcomes.push({ name: entry.name, published: false });
      continue;
    }
    npm(["publish", entry.tarball, "--access", "public", ...(dryRun ? ["--dry-run", "--tag", "dry-run"] : ["--provenance"])]);
    outcomes.push({ name: entry.name, published: true });
  }
  return outcomes;
}

const option = (argv, name) => argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const COMMANDS = {
  pack: argv => pack({ tag: option(argv, "tag"), out: option(argv, "out") }),
  verify: argv => {
    const versions = readJson(join(ROOT, "core/package.json")).devDependencies;
    return verify({ out: option(argv, "out"), typescript: versions.typescript, typesNode: readJson(join(ROOT, "shared/package.json")).devDependencies["@types/node"] });
  },
  publish: argv => publish({ out: option(argv, "out"), dryRun: argv.includes("--dry-run") }),
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const [command, ...argv] = process.argv.slice(2);
    if (!Object.hasOwn(COMMANDS, command ?? "")) throw new Error("Usage: release-packages.mjs pack|verify|publish --out=DIR [--tag=vX.Y.Z] [--dry-run]");
    if (!option(argv, "out")) throw new Error("--out=DIR is required");
    COMMANDS[command](argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
