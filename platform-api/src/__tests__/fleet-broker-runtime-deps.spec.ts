import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinModules } from "node:module";
import { describe, it, expect } from "vitest";

// The fleet broker dynamically imports some route services at request time.
// Every package it can reach must be a declared octogee-api dependency, or the
// first request in the container fails with "Cannot find package".

const HERE = dirname(fileURLToPath(import.meta.url));
const API_DIR = resolve(HERE, "..", "..");
const REPO = resolve(API_DIR, "..");
const BROKER = join(API_DIR, "src", "routes", "fleet-broker.ts");

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
const apiPkg = JSON.parse(readFileSync(join(API_DIR, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
const DECLARED = new Set(
  Object.keys({ ...apiPkg.dependencies, ...apiPkg.devDependencies }),
);

function resolveSource(base: string, spec: string): string | null {
  const candidates = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")];
  if (spec.endsWith(".js")) candidates.push(base.replace(/\.js$/, ".ts"));
  return candidates.find((c) => !c.endsWith("/") && existsSync(c)) ?? null;
}

function resolveImport(fromFile: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    return resolveSource(resolve(dirname(fromFile), spec), spec);
  }
  return null;
}

function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

// Drop `import type` / `export type` statements — they are erased at runtime and
// do not require an installed package.
function stripTypeOnly(src: string): string {
  return src.replace(
    /^\s*(?:import|export)\s+type\s[\s\S]*?from\s+["'][^"']+["'];?\s*$/gm,
    "",
  );
}

function externalPackages(entry: string): Map<string, string> {
  const seen = new Set<string>();
  const external = new Map<string, string>();
  const walk = (file: string): void => {
    if (seen.has(file) || !existsSync(file)) return;
    seen.add(file);
    const src = stripTypeOnly(readFileSync(file, "utf8"));
    const specs: string[] = [];
    // `from "x"` covers static import/re-export; `import("x")` / `import "x"`
    // covers dynamic + side-effect imports. Two linear patterns instead of one
    // backtracking alternation.
    for (const re of [/\bfrom\s*["']([^"']+)["']/g, /\bimport\s*\(?\s*["']([^"']+)["']/g]) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) specs.push(m[1]);
    }
    for (const spec of specs) {
      const next = resolveImport(file, spec);
      if (next) {
        walk(next);
      } else if (!BUILTINS.has(spec)) {
        external.set(packageName(spec), file.replace(`${REPO}/`, ""));
      }
    }
  };
  walk(entry);
  return external;
}

function dynamicImportTargets(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const re = /import\(\s*["']([^"']+)["']\s*\)/g;
  const targets = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const resolved = resolveImport(file, m[1]);
    if (resolved) targets.add(resolved);
  }
  return [...targets];
}

describe("fleet-broker runtime deps are vendored by octogee-api", () => {
  it("dynamically imports route services at runtime (guard is exercising something)", () => {
    expect(dynamicImportTargets(BROKER).length).toBeGreaterThan(0);
  });

  it("declares every npm package its dynamically-imported closure needs", () => {
    const missing: Record<string, string> = {};
    for (const target of dynamicImportTargets(BROKER)) {
      for (const [pkg, importer] of externalPackages(target)) {
        if (!DECLARED.has(pkg)) missing[pkg] = importer;
      }
    }
    expect(missing).toEqual({});
  });
});
