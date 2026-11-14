import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { reachableSources, resolveImport } from "./platform-boundary.js";

export const FIREBASE_REACH_ENTRYPOINTS = [
  "gateway-edge/src/main.ts",
  "glm-controller/src/main.ts",
  "octogee-api/src/llm-broker.ts",
  "octogee-api/src/main.ts",
  "octogee-api/src/npm-cache-proxy.ts",
];

export const FIREBASE_HANDLE_MODULES = [
  "gateway-edge/src/lib/db.ts",
];

export const FIREBASE_REACH_MANIFEST = "scripts/lib/firebase-reach.json";

const STATEMENT_SPECIFIER_RE = /\bfrom\s*["']([^"']+)["']/gu;
const SIDE_EFFECT_SPECIFIER_RE = /\bimport\s*["']([^"']+)["']/gu;
const DYNAMIC_SPECIFIER_RE = /\bimport\(\s*["']([^"']+)["']\s*\)/gu;
const STATEMENT_KEYWORD_RE = /\b(?:import|export)\b/gu;
const TYPE_ONLY_STATEMENT_RE = /^(?:import|export)\s+type\s/u;
const FIREBASE_ADMIN_RE = /^firebase-admin(?:\/|$)/u;

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
  handleModules: readonly string[] = FIREBASE_HANDLE_MODULES,
): string[] {
  const root = realpathSync(cloudRoot);
  const handles = new Set(handleModules.map((file) => realpathSync(join(root, file))));
  const loadsFirebase = (file: string): boolean => {
    const path = join(root, file);
    return runtimeSpecifiers(readFileSync(path, "utf8")).some((specifier) =>
      FIREBASE_ADMIN_RE.test(specifier) || handles.has(resolveImport(specifier, path, root, "") ?? ""));
  };
  return [...reachableSources(entrypoints, root, "")].filter(loadsFirebase).sort();
}

export interface FirebaseReachReport {
  reached: string[];
  newFiles: string[];
  staleFiles: string[];
}

export function firebaseReachReport(cloudRoot: string): FirebaseReachReport {
  const ratchet = (JSON.parse(readFileSync(join(cloudRoot, FIREBASE_REACH_MANIFEST), "utf8")) as { files: string[] }).files;
  const reached = firebaseReach(cloudRoot);
  const reachedSet = new Set(reached);
  const ratchetSet = new Set(ratchet);
  return {
    reached,
    newFiles: reached.filter((file) => !ratchetSet.has(file)),
    staleFiles: ratchet.filter((file) => !reachedSet.has(file)),
  };
}
