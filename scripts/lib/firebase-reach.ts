import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { reachableSources } from "./platform-boundary.js";

export const FIREBASE_REACH_ENTRYPOINTS = [
  "gateway-edge/src/main.ts",
  "fleet-controller/src/main.ts",
  "llm-broker/src/main.ts",
  "platform-api/src/main.ts",
  "platform-api/src/npm-cache-proxy.ts",
];

const STATEMENT_SPECIFIER_RE = /\bfrom\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_SPECIFIER_RE = /\bimport\s*["']([^"']+)["']/gu;
const DYNAMIC_SPECIFIER_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const STATEMENT_KEYWORD_RE = /\b(?:import|export)\b/gu;
const TYPE_ONLY_STATEMENT_RE = /^(?:import|export)\s+type\s/u;
const FIREBASE_SPECIFIER_RE = /^firebase-(?:admin|functions)(?:\/|$)/u;
const FIREBASE_PACKAGES = new Set(["firebase-admin", "firebase-functions"]);
const INSTALLED_SECTIONS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;
const SKIPPED_DIRECTORIES = new Set([".git", "dist", "node_modules"]);

export function runtimeSpecifiers(source: string): string[] {
  const statementStarts = Array.from(source.matchAll(STATEMENT_KEYWORD_RE), (match) => match.index);
  const statementBefore = (at: number): string => {
    let start = 0;
    for (const candidate of statementStarts) {
      if (candidate >= at) break;
      start = candidate;
    }
    return source.slice(start, at);
  };
  const specifiers = new Set<string>();
  for (const match of source.matchAll(STATEMENT_SPECIFIER_RE)) {
    if (!TYPE_ONLY_STATEMENT_RE.test(statementBefore(match.index))) specifiers.add(match[1]!);
  }
  for (const pattern of [SIDE_EFFECT_SPECIFIER_RE, DYNAMIC_SPECIFIER_RE]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]!);
  }
  return [...specifiers];
}

export function firebaseReach(
  cloudRoot: string,
  entrypoints: readonly string[] = FIREBASE_REACH_ENTRYPOINTS,
): string[] {
  const root = realpathSync(cloudRoot);
  const loadsFirebase = (file: string): boolean =>
    runtimeSpecifiers(readFileSync(join(root, file), "utf8")).some((specifier) => FIREBASE_SPECIFIER_RE.test(specifier));
  return [...reachableSources(entrypoints, root, "")].filter(loadsFirebase).sort();
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

function packageManifests(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : packageManifests(join(dir, entry.name));
    return entry.name === "package.json" ? [join(dir, entry.name)] : [];
  });
}

export function firebaseRuntimeDependencies(cloudRoot: string): string[] {
  const root = realpathSync(cloudRoot);
  return packageManifests(root).flatMap((path) => {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
    const file = relative(root, path).split(sep).join("/");
    return INSTALLED_SECTIONS.flatMap((section) => Object.keys(manifest[section] ?? {})
      .filter((name) => FIREBASE_PACKAGES.has(name))
      .filter((name) => section !== "peerDependencies" || manifest.peerDependenciesMeta?.[name]?.optional !== true)
      .map((name) => `${file} ${section}.${name}`));
  }).sort();
}
