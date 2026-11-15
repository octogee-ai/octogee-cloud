#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const LOCK_METADATA_FIELDS = [
  "version",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bin",
  "engines",
  "os",
  "cpu",
  "libc",
];
export const OVERLAY_DEPENDENCIES = "overlay-dependencies.json";
export const REGISTRY_DEPENDENCIES = "registry-dependencies";
const REGISTRY_LOCK_MARKER = ".registry-dependencies-lock";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SKIP_DIRS = new Set([
  ".git",
  ".claude",
  ".codex",
  "node_modules",
  "dist",
  "infra",
  "helm",
  "docs",
]);

export function discoverLocalFileDeps({ rootDir, consumerDirs = [] }) {
  const dirs = consumerDirs.length > 0 ? consumerDirs : topLevelPackageDirs(rootDir);

  return dirs.flatMap((consumerDir) => {
    const packageJsonPath = path.join(consumerDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) return [];
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const deps = new Map();

    for (const section of DEP_SECTIONS) {
      const values = packageJson[section];
      if (!values || typeof values !== "object") continue;
      for (const [packageName, spec] of Object.entries(values)) {
        if (typeof spec !== "string" || !isLocalDirectorySpec(spec)) continue;
        deps.set(`${packageName}\0${spec}`, {
          consumerDir,
          packageName,
          spec,
          sourceDir: path.resolve(consumerDir, spec.slice("file:".length)),
        });
      }
    }

    return [...deps.values(), ...overlayDependencies(consumerDir)];
  });
}

export function overlayDependencies(packageDir) {
  const manifestPath = path.join(packageDir, OVERLAY_DEPENDENCIES);
  if (!fs.existsSync(manifestPath)) return [];
  return Object.entries(readJson(manifestPath).dependencies ?? {}).map(([packageName, spec]) => {
    if (typeof spec !== "string" || !isLocalDirectorySpec(spec)) {
      throw new Error(`${manifestPath}: ${packageName} must be a file: directory dependency`);
    }
    return {
      consumerDir: packageDir,
      packageName,
      spec,
      sourceDir: path.resolve(packageDir, spec.slice("file:".length)),
      overlay: true,
    };
  });
}

export function stageOverlayDependencies(productRoot, { stdio = "inherit" } = {}) {
  for (const entry of fs.readdirSync(productRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(productRoot, entry.name);
    for (const dep of overlayDependencies(packageDir)) packDirectoryPackage(dep);
    const registry = registryDependencies(packageDir);
    if (registry) installRegistryDependencies(registry, stdio);
  }
}

export function registryDependencies(packageDir) {
  const projectDir = path.join(packageDir, REGISTRY_DEPENDENCIES);
  const manifestPath = path.join(projectDir, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  const declared = Object.entries(readJson(manifestPath).dependencies ?? {});
  for (const [packageName, spec] of declared) {
    if (typeof spec !== "string" || !EXACT_VERSION.test(spec)) {
      throw new Error(`${manifestPath}: ${packageName} must pin an exact version, not ${spec}`);
    }
  }
  const lockPath = path.join(projectDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) throw new Error(`${projectDir} must lock its dependencies in package-lock.json`);
  const lockSource = fs.readFileSync(lockPath, "utf8");
  const locked = JSON.parse(lockSource).packages ?? {};
  for (const [packageName] of declared) {
    if (!locked[`node_modules/${packageName}`]) throw new Error(`${lockPath} does not lock ${packageName}`);
  }
  return {
    consumerDir: packageDir,
    projectDir,
    packageNames: declared.map(([packageName]) => packageName),
    lockDigest: createHash("sha256").update(lockSource).digest("hex"),
  };
}

function registryMarkerPath(consumerDir) {
  return path.join(consumerDir, "node_modules", REGISTRY_LOCK_MARKER);
}

function registryDependenciesStale({ consumerDir, packageNames, lockDigest }) {
  return readFileIfPresent(registryMarkerPath(consumerDir)) !== lockDigest
    || packageNames.some((packageName) => !fs.existsSync(path.join(installedDirOf({ consumerDir, packageName }), "package.json")));
}

function installedPackageNames(nodeModulesDir) {
  return fs.readdirSync(nodeModulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .flatMap((entry) => (entry.name.startsWith("@")
      ? fs.readdirSync(path.join(nodeModulesDir, entry.name)).map((name) => `${entry.name}/${name}`)
      : [entry.name]));
}

function installRegistryDependencies({ consumerDir, projectDir, packageNames, lockDigest }, stdio) {
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-dependencies-"));
  try {
    for (const file of ["package.json", "package-lock.json", ".npmrc"]) {
      if (fs.existsSync(path.join(projectDir, file))) fs.copyFileSync(path.join(projectDir, file), path.join(installDir, file));
    }
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- npm is the toolchain the caller's checks and image builds pin on PATH.
    execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: installDir, stdio });
    const installed = path.join(installDir, "node_modules");
    const transitive = installedPackageNames(installed).filter((packageName) => !packageNames.includes(packageName));
    for (const packageName of packageNames) {
      const target = installedDirOf({ consumerDir, packageName });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(installed, ...packageName.split("/")), target, { recursive: true });
      for (const dependency of transitive) {
        const nested = path.join(target, "node_modules", ...dependency.split("/"));
        if (!fs.existsSync(nested)) fs.cpSync(path.join(installed, ...dependency.split("/")), nested, { recursive: true });
      }
    }
    fs.mkdirSync(path.dirname(registryMarkerPath(consumerDir)), { recursive: true });
    fs.writeFileSync(registryMarkerPath(consumerDir), lockDigest);
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true });
  }
}

function installedDirOf({ consumerDir, packageName }) {
  return path.join(consumerDir, "node_modules", ...packageName.split("/"));
}

function packDirectoryPackage(dep) {
  const installedDir = installedDirOf(dep);
  const { files } = readJson(path.join(dep.sourceDir, "package.json"));
  if (!Array.isArray(files)) throw new Error(`${dep.packageName} must list its packed files`);
  fs.rmSync(installedDir, { recursive: true, force: true });
  fs.mkdirSync(installedDir, { recursive: true });
  fs.copyFileSync(path.join(dep.sourceDir, "package.json"), path.join(installedDir, "package.json"));
  for (const entry of files) fs.cpSync(path.join(dep.sourceDir, entry), path.join(installedDir, entry), { recursive: true });
}

function resolvesFrom(directory, packageName) {
  for (let dir = directory; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== "node_modules"
      && fs.existsSync(path.join(dir, "node_modules", ...packageName.split("/"), "package.json"))) return true;
    if (dir === path.dirname(dir)) return false;
  }
}

function assertDependenciesInstalled(dep) {
  const installedDir = installedDirOf(dep);
  const manifest = readJson(path.join(installedDir, "package.json"));
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    if (!resolvesFrom(installedDir, name)) {
      throw new Error(`${dep.packageName} needs ${name}, which ${dep.consumerDir} does not install`);
    }
  }
}

function packedOverlayDependency(state) {
  if (!fs.existsSync(path.join(state.installedDir, "package.json"))) {
    throw new Error(`${state.packageName} has no source at ${state.sourceDir} and no packed copy in ${state.installedDir}`);
  }
  return { ...state, installed: true, staleReasons: [] };
}

export function inspectLocalFileDep({ consumerDir, packageName, spec, sourceDir, overlay = false }) {
  const installedDir = installedDirOf({ consumerDir, packageName });
  if (overlay && !fs.existsSync(path.join(sourceDir, "package.json"))) {
    return packedOverlayDependency({ consumerDir, packageName, spec, sourceDir, installedDir });
  }
  const staleReasons = [];
  const sourcePackageJson = readJson(path.join(sourceDir, "package.json"));

  if (!fs.existsSync(installedDir)) {
    staleReasons.push("installed-package");
  } else {
    const installedPackageJson = readJson(path.join(installedDir, "package.json"));
    if (normalizeJson(sourcePackageJson) !== normalizeJson(installedPackageJson)) {
      staleReasons.push("installed-package");
    }
    if (diffDirectories(path.join(sourceDir, "dist"), path.join(installedDir, "dist")).length > 0) {
      staleReasons.push("installed-dist");
    }
  }
  if (!overlay) {
    staleReasons.push(...compareLockMetadata({
      consumerDir,
      packageName,
      sourcePackageJson,
      spec,
    }));
  }

  return {
    consumerDir,
    packageName,
    spec,
    sourceDir,
    installedDir,
    installed: fs.existsSync(installedDir),
    staleReasons,
  };
}

export function syncLocalFileDeps({
  rootDir = DEFAULT_ROOT,
  consumerDirs = [],
  check = false,
  stdio = "inherit",
  installConsumerDepsFn = installConsumerDeps,
} = {}) {
  const discovered = discoverLocalFileDeps({ rootDir, consumerDirs });
  const stale = discovered
    .map((dep) => ({ dep, state: inspectLocalFileDep(dep) }))
    .filter(({ state }) => state.staleReasons.length > 0);
  const registries = (consumerDirs.length > 0 ? consumerDirs : topLevelPackageDirs(rootDir))
    .map(registryDependencies)
    .filter(Boolean);
  const staleRegistries = registries.filter(registryDependenciesStale);

  for (const { dep, state } of stale) {
    const label = `${path.relative(rootDir, dep.consumerDir) || "."}:${dep.packageName}`;
    console.error(`[file-deps] ${label} stale (${state.staleReasons.join(", ")})`);
  }
  for (const registry of staleRegistries) {
    console.error(`[file-deps] ${path.relative(rootDir, registry.consumerDir) || "."}:${REGISTRY_DEPENDENCIES} stale`);
  }

  const staleCount = stale.length + staleRegistries.length;
  if (staleCount === 0 || check) {
    return { staleCount, syncedConsumers: [] };
  }

  const byConsumer = new Map();
  for (const item of stale.filter(({ dep }) => !dep.overlay)) {
    const existing = byConsumer.get(item.dep.consumerDir) ?? [];
    existing.push(item);
    byConsumer.set(item.dep.consumerDir, existing);
  }

  const syncedConsumers = [];
  for (const [consumerDir, items] of byConsumer) {
    const manifestPath = path.join(consumerDir, "package.json");
    const lockPath = path.join(consumerDir, "package-lock.json");
    const manifestBefore = readFileIfPresent(manifestPath);
    const lockBefore = readFileIfPresent(path.join(consumerDir, "package-lock.json"));
    for (const { dep } of items) {
      fs.rmSync(path.join(consumerDir, "node_modules", ...dep.packageName.split("/")), {
        recursive: true,
        force: true,
      });
    }
    const specsByName = new Map();
    const visitedSourceDirs = new Set();
    for (const { dep } of items) {
      for (const runtimeDep of localRuntimeDependencySpecs(
        dep.sourceDir,
        consumerDir,
        visitedSourceDirs,
      )) {
        specsByName.set(runtimeDep.packageName, runtimeDep.spec);
      }
      specsByName.set(dep.packageName, `${dep.packageName}@${dep.spec}`);
    }
    const specs = Array.from(specsByName.values());
    const preserveLock = items.every(({ state }) =>
      !state.staleReasons.some((reason) => reason.startsWith("package-lock.json:")));
    console.error(`[file-deps] refreshing ${path.relative(rootDir, consumerDir) || "."}: ${specs.join(" ")}`);
    installConsumerDepsFn(consumerDir, specs, preserveLock, stdio);
    if (manifestBefore !== readFileIfPresent(manifestPath)) {
      restoreFile(manifestPath, manifestBefore);
      throw new Error(`directory refresh changed ${path.relative(rootDir, manifestPath) || "package.json"}`);
    }
    const lockAfter = readFileIfPresent(lockPath);
    if (preserveLock && lockBefore !== lockAfter) {
      restoreFile(lockPath, lockBefore);
      throw new Error(`directory refresh changed ${path.relative(rootDir, consumerDir) || "."}/package-lock.json`);
    }
    for (const { dep } of items) {
      const state = inspectLocalFileDep(dep);
      if (state.staleReasons.length > 0) {
        throw new Error(`${dep.packageName} remains stale (${state.staleReasons.join(", ")})`);
      }
    }
    syncedConsumers.push(consumerDir);
  }

  for (const registry of registries.filter(registryDependenciesStale)) {
    console.error(`[file-deps] installing ${path.relative(rootDir, registry.consumerDir) || "."}:${REGISTRY_DEPENDENCIES}`);
    installRegistryDependencies(registry, stdio);
    if (!syncedConsumers.includes(registry.consumerDir)) syncedConsumers.push(registry.consumerDir);
  }

  const overlays = discovered.filter((dep) => dep.overlay && inspectLocalFileDep(dep).staleReasons.length > 0);
  for (const dep of overlays) {
    console.error(`[file-deps] packing ${path.relative(rootDir, dep.consumerDir) || "."}:${dep.packageName}`);
    packDirectoryPackage(dep);
  }
  for (const dep of overlays) {
    assertDependenciesInstalled(dep);
    if (!syncedConsumers.includes(dep.consumerDir)) syncedConsumers.push(dep.consumerDir);
  }

  return { staleCount, syncedConsumers };
}

export function staleLocalFileDepLocks({ rootDir = DEFAULT_ROOT } = {}) {
  return discoverLocalFileDeps({ rootDir })
    .filter((dep) => !dep.overlay)
    .map(({ consumerDir, packageName, spec, sourceDir }) => ({
      consumer: path.relative(rootDir, consumerDir),
      packageName,
      reasons: compareLockMetadata({
        consumerDir,
        packageName,
        sourcePackageJson: readJson(path.join(sourceDir, "package.json")),
        spec,
      }),
    }))
    .filter(({ reasons }) => reasons.length > 0);
}

function compareLockMetadata({ consumerDir, packageName, sourcePackageJson, spec }) {
  const lockPath = path.join(consumerDir, "package-lock.json");
  if (!fs.existsSync(lockPath)) return ["package-lock.json:missing"];

  const lock = readJson(lockPath);
  const entry = lock.packages?.[`node_modules/${packageName}`];
  if (!entry) return ["package-lock.json:entry"];

  const reasons = [];
  if (entry.resolved !== spec) reasons.push("package-lock.json:resolved");
  for (const field of LOCK_METADATA_FIELDS) {
    if (normalizeJson(entry[field]) !== normalizeJson(sourcePackageJson[field])) {
      reasons.push(`package-lock.json:${field}`);
    }
  }

  const scripts = sourcePackageJson.scripts ?? {};
  const expectedInstallScript = ["preinstall", "install", "postinstall"]
    .some((name) => typeof scripts[name] === "string");
  if (Boolean(entry.hasInstallScript) !== expectedInstallScript) {
    reasons.push("package-lock.json:hasInstallScript");
  }
  return reasons;
}

function isLocalDirectorySpec(spec) {
  return spec.startsWith("file:") && !spec.endsWith(".tgz");
}

function packageDirsIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !SKIP_DIRS.has(entry.name))
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => path.join(dir, entry.name))
    .filter((packageDir) => fs.existsSync(path.join(packageDir, "package.json")));
}

function topLevelPackageDirs(rootDir) {
  const platformDir = path.join(rootDir, "platform");
  return [...packageDirsIn(rootDir), ...(fs.existsSync(platformDir) ? packageDirsIn(platformDir) : [])];
}

export function fileDepInstallArgs(specs, preserveLock) {
  const saveArgs = preserveLock ? ["--no-save", "--package-lock=false"] : [];
  return [
    "install",
    "--install-links=true",
    "--no-audit",
    "--no-fund",
    "--ignore-scripts",
    "--min-release-age=0",
    ...saveArgs,
    ...specs,
  ];
}

export function fileDepLockOnlyArgs() {
  return [
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--min-release-age=0",
  ];
}

function installConsumerDeps(consumerDir, specs, preserveLock, stdio) {
  const manifestPath = path.join(consumerDir, "package.json");
  const lockPath = path.join(consumerDir, "package-lock.json");
  const originalManifest = fs.readFileSync(manifestPath);
  const originalLock = fs.existsSync(lockPath) ? fs.readFileSync(lockPath) : null;

  try {
    execFileSync(process.execPath, [
      npmCliPath(),
      ...fileDepInstallArgs(specs, preserveLock),
    ], { cwd: consumerDir, stdio });

    if (!preserveLock) {
      fs.writeFileSync(manifestPath, originalManifest);
      execFileSync(process.execPath, [
        npmCliPath(),
        ...fileDepLockOnlyArgs(),
      ], { cwd: consumerDir, stdio });
    }
  } catch (error) {
    fs.writeFileSync(manifestPath, originalManifest);
    restoreFile(lockPath, originalLock);
    throw error;
  }
}

function localRuntimeDependencySpecs(sourceDir, consumerDir, visitedSourceDirs) {
  const canonicalSourceDir = fs.realpathSync(sourceDir);
  if (visitedSourceDirs.has(canonicalSourceDir)) return [];
  visitedSourceDirs.add(canonicalSourceDir);

  const sourcePackage = readJson(path.join(sourceDir, "package.json"));
  const specs = [];
  for (const section of ["dependencies", "optionalDependencies"]) {
    const dependencies = sourcePackage[section];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const [packageName, dependencySpec] of Object.entries(dependencies)) {
      if (typeof dependencySpec !== "string" || !isLocalDirectorySpec(dependencySpec)) {
        continue;
      }
      const dependencyDir = path.resolve(
        sourceDir,
        dependencySpec.slice("file:".length),
      );
      if (!fs.existsSync(path.join(dependencyDir, "package.json"))) {
        throw new Error(`runtime directory dependency source is missing: ${dependencyDir}`);
      }
      specs.push(...localRuntimeDependencySpecs(
        dependencyDir,
        consumerDir,
        visitedSourceDirs,
      ));
      const relativePath = path.relative(consumerDir, dependencyDir)
        .split(path.sep)
        .join("/");
      specs.push({
        packageName,
        spec: `${packageName}@file:${relativePath}`,
      });
    }
  }
  return specs;
}

function npmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  throw new Error("npm_execpath is not set; run this through an npm script");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readFileIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
}

function restoreFile(filePath, contents) {
  if (contents === null) {
    fs.rmSync(filePath, { force: true });
  } else {
    fs.writeFileSync(filePath, contents);
  }
}

function diffDirectories(sourceDir, installedDir) {
  const source = fingerprintDirectory(sourceDir);
  const installed = fingerprintDirectory(installedDir);
  const allPaths = new Set([...source.keys(), ...installed.keys()]);
  return Array.from(allPaths)
    .filter((filePath) => source.get(filePath) !== installed.get(filePath))
    .sort();
}

function fingerprintDirectory(directory) {
  const fingerprints = new Map();
  if (!fs.existsSync(directory)) return fingerprints;
  for (const filePath of walkFiles(directory)) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
    fingerprints.set(relativePath, createHash("sha512").update(fs.readFileSync(filePath)).digest("base64"));
  }
  return fingerprints;
}

function walkFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizeJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function parseArgs(argv) {
  const args = { rootDir: DEFAULT_ROOT, consumerDirs: [], check: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--root") {
      index += 1;
      args.rootDir = path.resolve(argv[index]);
    } else if (arg === "--consumer") {
      index += 1;
      args.consumerDirs.push(path.resolve(process.cwd(), argv[index]));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const result = syncLocalFileDeps(parseArgs(process.argv.slice(2)));
    if (result.staleCount > 0 && result.syncedConsumers.length === 0) process.exitCode = 1;
  } catch (error) {
    console.error(`[file-deps] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
