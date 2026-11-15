import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export interface ComponentImportRules {
  libraries: string[];
  exceptions: string[];
}

export interface ComponentImportReport {
  violations: string[];
  newViolations: string[];
  staleExceptions: string[];
}

const CODE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u;
const BUILD_OUTPUT = /(?:^|\/)(?:dist|node_modules)\//u;
const SPECIFIER_RES = [
  /\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\(\s*["']([^"']+)["']\s*[,)]/gu,
  /\brequire\(\s*["']([^"']+)["']\s*\)/gu,
  /\bvi\.(?:do)?[mM]ock\(\s*["']([^"']+)["']/gu,
  /\bvi\.importActual(?:<[^>]*>)?\(\s*["']([^"']+)["']/gu,
];
const PACKAGE_SCOPE = /^(@octogee\/[^/]+)/u;
const OUTSIDE = "(outside the repository)";
const ROOT = "(repository root)";
const GIT_BINARY = "/usr/bin/git";

export function loadComponentImportRules(file: string): ComponentImportRules {
  const rules = JSON.parse(readFileSync(file, "utf8")) as ComponentImportRules;
  for (const key of ["libraries", "exceptions"] as const) {
    if (!Array.isArray(rules[key])) throw new Error(`${file}: ${key} must be an array`);
  }
  return rules;
}

export function importSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of SPECIFIER_RES) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}

export function componentOf(file: string): string | null {
  const slash = file.indexOf("/");
  return slash < 0 ? null : file.slice(0, slash);
}

export function componentPackages(root: string, components: Iterable<string>): Map<string, string> {
  const packages = new Map<string, string>();
  for (const component of components) {
    const manifest = join(root, component, "package.json");
    if (!existsSync(manifest)) continue;
    const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
    if (name) packages.set(name, component);
  }
  return packages;
}

function relativeTarget(file: string, specifier: string): string {
  const target = posix.normalize(posix.join(posix.dirname(file), specifier));
  if (target === ".." || target.startsWith("../")) return OUTSIDE;
  return target === "." ? ROOT : target.split("/")[0]!;
}

export function importViolationsOf(
  file: string,
  source: string,
  packages: ReadonlyMap<string, string>,
  libraries: readonly string[],
): string[] {
  const own = componentOf(file);
  if (own === null) return [];
  const reached = new Set<string>();
  for (const specifier of importSpecifiers(source)) {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const target = relativeTarget(file, specifier);
      if (target !== own) reached.add(target);
      continue;
    }
    const scope = PACKAGE_SCOPE.exec(specifier)?.[1];
    const target = scope ? packages.get(scope) : undefined;
    if (target && target !== own && !libraries.includes(target)) reached.add(`${target} (package)`);
  }
  return [...reached].sort().map((target) => `${file} -> ${target}`);
}

export function trackedCodeFiles(root: string): string[] {
  return execFileSync(GIT_BINARY, ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => CODE_FILE.test(file) && !BUILD_OUTPUT.test(file) && existsSync(join(root, file)))
    .sort();
}

export function componentImportReport(root: string, rules: ComponentImportRules, files = trackedCodeFiles(root)): ComponentImportReport {
  const components = new Set(files.map(componentOf).filter((component): component is string => component !== null));
  const packages = componentPackages(root, components);
  const violations = files.flatMap((file) =>
    importViolationsOf(file, readFileSync(join(root, file), "utf8"), packages, rules.libraries));
  const excepted = new Set(rules.exceptions);
  const found = new Set(violations);
  return {
    violations,
    newViolations: violations.filter((violation) => !excepted.has(violation)),
    staleExceptions: rules.exceptions.filter((exception) => !found.has(exception)),
  };
}
