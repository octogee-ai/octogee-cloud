import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export interface PlatformBoundaryManifest {
  platformEntrypoints: string[];
  platformRoots: string[];
  productModules: string[];
  ratchet: string[];
  referenceRatchet: string[];
  dependencyRatchet: string[];
}

export interface ReferenceReport {
  references: string[];
  newViolations: string[];
  staleRatchet: string[];
}

export interface BoundaryReport {
  reached: string[];
  newViolations: string[];
  staleRatchet: string[];
}

const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\(\s*["']([^"']+)["']\s*\)/g,
];
const PLATFORM_DIR = "platform/";
const PRODUCT_ROOT = "product";
const MANIFEST_PATH = `${PLATFORM_DIR}scripts/lib/platform-boundary.json`;
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];
const PACKAGE_MANIFEST = "package.json";
const PACKAGE_LOCK = "package-lock.json";
const FILE_PROTOCOL = "file:";

export function loadPlatformBoundaryManifest(repoRoot: string): PlatformBoundaryManifest {
  const path = join(repoRoot, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as PlatformBoundaryManifest;
  for (const key of ["platformEntrypoints", "platformRoots", "productModules", "ratchet", "referenceRatchet", "dependencyRatchet"] as const) {
    if (!Array.isArray(manifest[key])) throw new Error(`platform-boundary.json ${key} must be an array`);
  }
  return manifest;
}

export function isProductModule(file: string, productModules: readonly string[]): boolean {
  return productModules.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));
}

function findSourceFile(candidate: string): string | null {
  for (const ext of SOURCE_EXTENSIONS) {
    if (candidate.endsWith(ext) && existsSync(candidate)) return candidate;
  }
  const stripped = candidate.replace(/\.(js|mjs|cjs)$/u, "");
  for (const ext of SOURCE_EXTENSIONS) {
    if (existsSync(stripped + ext)) return stripped + ext;
  }
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    for (const ext of SOURCE_EXTENSIONS) {
      if (existsSync(join(candidate, `index${ext}`))) return join(candidate, `index${ext}`);
    }
  }
  return null;
}

function resolveSourceFile(candidate: string): string | null {
  const found = findSourceFile(candidate);
  return found ? realpathSync(found) : null;
}

interface PackageManifest {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  exports?: Record<string, { default?: string }>;
}

function readPackageManifest(packageDir: string): PackageManifest {
  return JSON.parse(readFileSync(join(packageDir, PACKAGE_MANIFEST), "utf8")) as PackageManifest;
}

function owningPackageDir(fromFile: string, repoRoot: string): string | null {
  const root = realpathSync(repoRoot);
  for (let dir = dirname(fromFile); !relative(root, dir).startsWith(".."); dir = dirname(dir)) {
    if (existsSync(join(dir, PACKAGE_MANIFEST))) return dir;
    if (dir === root) break;
  }
  return null;
}

const localPackages = new Map<string, Map<string, string>>();

function localPackageDir(name: string, repoRoot: string, platformDir: string): string | undefined {
  const root = realpathSync(repoRoot);
  const key = join(root, platformDir);
  let packages = localPackages.get(key);
  if (!packages) {
    packages = new Map();
    for (const parent of new Set([root, join(root, platformDir), join(root, PRODUCT_ROOT)])) {
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        const packageDir = join(parent, entry.name);
        if (!entry.isDirectory() || !existsSync(join(packageDir, PACKAGE_MANIFEST))) continue;
        const { name: packageName } = readPackageManifest(packageDir);
        if (packageName) packages.set(packageName, packageDir);
      }
    }
    localPackages.set(key, packages);
  }
  return packages.get(name);
}

function declaredPackageDir(name: string, fromFile: string, repoRoot: string): string | undefined {
  const consumer = owningPackageDir(fromFile, repoRoot);
  if (!consumer) return undefined;
  const consumerManifest = readPackageManifest(consumer);
  const spec = consumerManifest.dependencies?.[name] ?? consumerManifest.devDependencies?.[name];
  return spec?.startsWith(FILE_PROTOCOL) ? resolve(consumer, spec.slice(FILE_PROTOCOL.length)) : undefined;
}

function resolveLocalPackageImport(specifier: string, fromFile: string, repoRoot: string, platformDir: string): string | null {
  const match = /^(@octogee\/[^/]+)\/(.+)$/u.exec(specifier);
  if (!match) return null;
  const packageDir = declaredPackageDir(match[1]!, fromFile, repoRoot) ?? localPackageDir(match[1]!, repoRoot, platformDir);
  if (!packageDir) return null;
  const built = readPackageManifest(packageDir).exports?.[`./${match[2]}`]?.default?.replace(/^\.\/dist\//u, "");
  if (built === undefined) return null;
  return resolveSourceFile(join(packageDir, "src", built))
    ?? resolveSourceFile(join(packageDir, built))
    ?? resolveSourceFile(join(dirname(packageDir), built));
}

export function resolveImport(specifier: string, fromFile: string, repoRoot: string, platformDir = PLATFORM_DIR): string | null {
  if (specifier.startsWith(".")) return resolveSourceFile(resolve(dirname(fromFile), specifier));
  if (specifier.startsWith("@octogee/core/")) {
    return resolveSourceFile(join(repoRoot, platformDir, "core/src", specifier.slice("@octogee/core/".length)));
  }
  if (specifier.startsWith("@octogee/shared/")) {
    return resolveSourceFile(join(repoRoot, platformDir, "shared", specifier.slice("@octogee/shared/".length)));
  }
  if (specifier.startsWith("@shared/")) {
    return resolveSourceFile(join(repoRoot, platformDir, "shared", specifier.slice("@shared/".length)));
  }
  if (specifier.startsWith("@/")) {
    const segments = relative(realpathSync(repoRoot), fromFile).split("/");
    const pkg = platformDir !== "" && `${segments[0]}/` === platformDir ? segments.slice(0, 2).join("/") : segments[0]!;
    return resolveSourceFile(join(repoRoot, pkg, "src", specifier.slice(2)));
  }
  return resolveLocalPackageImport(specifier, fromFile, repoRoot, platformDir);
}

export function importsOf(file: string, repoRoot: string, platformDir = PLATFORM_DIR): string[] {
  return importsOfSource(readFileSync(file, "utf8"), file, repoRoot, platformDir);
}

export function importsOfSource(source: string, file: string, repoRoot: string, platformDir = PLATFORM_DIR): string[] {
  const targets = new Set<string>();
  for (const pattern of SPECIFIER_RES) {
    for (const match of source.matchAll(pattern)) {
      const resolved = resolveImport(match[1]!, file, repoRoot, platformDir);
      if (resolved) targets.add(resolved);
    }
  }
  return [...targets];
}

export function reachableSources(entrypoints: readonly string[], repoRoot: string, platformDir = PLATFORM_DIR): Set<string> {
  const root = realpathSync(repoRoot);
  const seen = new Set<string>();
  for (const entry of entrypoints) {
    if (!existsSync(join(root, entry))) throw new Error(`platform entrypoint does not exist: ${entry}`);
  }
  const queue = entrypoints.map((entry) => realpathSync(join(root, entry)));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const target of importsOf(file, repoRoot, platformDir)) {
      if (!seen.has(target)) queue.push(target);
    }
  }
  return new Set([...seen].map((file) => relative(root, file)));
}

export function platformBoundaryReport(manifest: PlatformBoundaryManifest, repoRoot: string): BoundaryReport {
  const reached = [...reachableSources(manifest.platformEntrypoints, repoRoot)]
    .filter((file) => isProductModule(file, manifest.productModules))
    .sort();
  const ratchet = new Set(manifest.ratchet);
  const reachedSet = new Set(reached);
  return {
    reached,
    newViolations: reached.filter((file) => !ratchet.has(file)),
    staleRatchet: manifest.ratchet.filter((file) => !reachedSet.has(file)),
  };
}

const TEST_PATH_RE = /(?:(?:^|\/)(?:__tests__|test-setup)\/)|(?:\.(?:spec|test)\.[cm]?[jt]sx?$)/u;
const TYPESCRIPT_RE = /\.(?:ts|tsx|mts)$/u;
const GIT_BINARY = "/usr/bin/git";
const NAME_CHARS = /[A-Za-z0-9_-]/u;

function startsOf(source: string, path: string): number[] {
  const starts: number[] = [];
  for (let index = source.indexOf(path); index >= 0; index = source.indexOf(path, index + 1)) starts.push(index);
  return starts;
}

function endsName(source: string, end: number): boolean {
  return !NAME_CHARS.test(source.charAt(end));
}

const VARIABLE_ROOT = /(?:\$\{\w+\}|\$\w+|\$\([^()]*\))\/$/u;

function startsPath(source: string, start: number, climbs = true): boolean {
  const before = source.charAt(start - 1);
  if (!NAME_CHARS.test(before) && before !== "." && before !== "/") return true;
  const head = source.slice(Math.max(0, start - 80), start);
  if (head.endsWith("../")) return climbs;
  return head.endsWith("./") || VARIABLE_ROOT.test(head);
}

function mentionsRepoPath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => startsPath(source, start) && endsName(source, start + path.length));
}

function mentionsRootPath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => startsPath(source, start, false) && source.charAt(start + path.length) === "/");
}

function mentionsRelativePath(source: string, path: string): boolean {
  return startsOf(source, path).some((start) => {
    const before = source.charAt(start - 1);
    return !NAME_CHARS.test(before) && before !== "." && source.slice(start - 3, start) !== "../"
      && endsName(source, start + path.length);
  });
}

export function productAssetEntries(manifest: PlatformBoundaryManifest): string[] {
  return manifest.productModules.filter((entry) => manifest.platformRoots.some((root) => entry.startsWith(root)));
}

export function platformFiles(manifest: PlatformBoundaryManifest, repoRoot: string): string[] {
  const listed = execFileSync(GIT_BINARY, ["ls-files", "--recurse-submodules", "-z", "--", ...manifest.platformRoots], { cwd: repoRoot, encoding: "utf8" });
  return listed
    .split("\0")
    .filter((file) => file.length > 0 && existsSync(join(repoRoot, file)))
    .filter((file) => file !== MANIFEST_PATH && !TEST_PATH_RE.test(file) && !isProductModule(file, manifest.productModules))
    .sort();
}

export function productReferencesOf(
  file: string,
  source: string,
  manifest: PlatformBoundaryManifest,
  repoRoot: string,
): string[] {
  const referenced = new Set<string>();
  for (const entry of productAssetEntries(manifest)) {
    const repoPath = entry.replace(/\/$/u, "");
    const platformPath = repoPath.startsWith(PLATFORM_DIR) ? repoPath.slice(PLATFORM_DIR.length) : null;
    const fromFile = relative(dirname(file), repoPath);
    const sharedRoot = manifest.platformRoots.find((root) => file.startsWith(root) && entry.startsWith(root));
    const fromRoot = sharedRoot ? entry.slice(sharedRoot.length).replace(/\/$/u, "") : null;
    if (
      mentionsRepoPath(source, repoPath)
      || (platformPath !== null && mentionsRepoPath(source, platformPath))
      || (fromFile.startsWith("../") && mentionsRelativePath(source, fromFile))
      || (fromRoot !== null && mentionsRootPath(source, fromRoot))
    ) {
      referenced.add(entry);
    }
  }
  if (TYPESCRIPT_RE.test(file)) {
    const root = realpathSync(repoRoot);
    for (const target of importsOfSource(source, join(root, file), repoRoot)) {
      const targetFile = relative(root, target);
      const entry = manifest.productModules.find((candidate) => isProductModule(targetFile, [candidate]));
      if (entry) referenced.add(entry);
    }
  }
  return [...referenced].sort();
}

export function platformReferenceReport(manifest: PlatformBoundaryManifest, repoRoot: string): ReferenceReport {
  const references: string[] = [];
  for (const file of platformFiles(manifest, repoRoot)) {
    const source = readFileSync(join(repoRoot, file), "utf8");
    if (source.includes("\0")) continue;
    for (const entry of productReferencesOf(file, source, manifest, repoRoot)) references.push(`${file} -> ${entry}`);
  }
  const ratchet = new Set(manifest.referenceRatchet);
  const referenced = new Set(references);
  return {
    references,
    newViolations: references.filter((reference) => !ratchet.has(reference)),
    staleRatchet: manifest.referenceRatchet.filter((reference) => !referenced.has(reference)),
  };
}

const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"] as const;
const PACKAGE_FILES = new Set([PACKAGE_MANIFEST, PACKAGE_LOCK]);
const NODE_MODULES = "node_modules/";

interface LockEntry {
  name?: string;
  resolved?: string;
}

interface LocalDependency {
  name?: string;
  target: string | null;
}

function localTarget(spec: string): string | null {
  const target = spec.startsWith(FILE_PROTOCOL) ? spec.slice(FILE_PROTOCOL.length) : spec;
  return /^[a-z][a-z0-9+.-]*:/iu.test(target) ? null : target;
}

function leavesPlatform(file: string, target: string, repoRoot: string): boolean {
  const root = resolve(repoRoot);
  return !relative(root, resolve(root, dirname(file), target)).startsWith(PLATFORM_DIR);
}

function lockedDependency(key: string, entry: LockEntry): LocalDependency {
  if (!key.includes(NODE_MODULES)) return { name: entry.name, target: key };
  const name = key.slice(key.lastIndexOf(NODE_MODULES) + NODE_MODULES.length);
  return { name, target: entry.resolved ? localTarget(entry.resolved) : null };
}

function lockDependencies(lock: Record<string, unknown>): LocalDependency[] {
  return Object.entries((lock.packages ?? {}) as Record<string, LockEntry>)
    .filter(([key]) => key !== "")
    .map(([key, entry]) => lockedDependency(key, entry));
}

function manifestDependencies(manifest: Record<string, unknown>): LocalDependency[] {
  return DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.entries((manifest[section] ?? {}) as Record<string, string>).map(([name, spec]) => ({
      name,
      target: spec.startsWith(FILE_PROTOCOL) ? localTarget(spec) : null,
    })));
}

export function outsideDependenciesOf(file: string, source: string, repoRoot: string): string[] {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const dependencies = file.endsWith(PACKAGE_LOCK) ? lockDependencies(parsed) : manifestDependencies(parsed);
  const outside = dependencies
    .filter(({ name, target }) => name && target && leavesPlatform(file, target, repoRoot))
    .map(({ name }) => `${file} -> ${name}`);
  return [...new Set(outside)].sort();
}

export function platformDependencyReport(manifest: PlatformBoundaryManifest, repoRoot: string): ReferenceReport {
  const listed = execFileSync(GIT_BINARY, ["ls-files", "--recurse-submodules", "-z", "--", PLATFORM_DIR], { cwd: repoRoot, encoding: "utf8" });
  const references = listed
    .split("\0")
    .filter((file) => PACKAGE_FILES.has(file.slice(file.lastIndexOf("/") + 1)) && existsSync(join(repoRoot, file)))
    .flatMap((file) => outsideDependenciesOf(file, readFileSync(join(repoRoot, file), "utf8"), repoRoot));
  const ratchet = new Set(manifest.dependencyRatchet);
  const referenced = new Set(references);
  return {
    references,
    newViolations: references.filter((reference) => !ratchet.has(reference)),
    staleRatchet: manifest.dependencyRatchet.filter((reference) => !referenced.has(reference)),
  };
}
