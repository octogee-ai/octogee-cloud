// Every external package the cluster routes reach must be declared by
// platform-api/package.json, the only install in the octogee-api image.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { isBuiltin } from "node:module";

const API_ROOT = path.resolve(__dirname, "../..");
const REPO_ROOT = path.resolve(API_ROOT, "..");
const BUNDLE_ENTRY = path.join(API_ROOT, "src/routes/mount-cluster-routes.ts");

// Catches single-line, multi-line, and re-export forms; side-effect imports too.
// Type-only imports are NOT filtered — over-reporting a types-only package errs
// safe (the net demands a dep) and external type-only imports are all real deps
// here anyway (express et al).
const FROM_RE = /from\s+["']([^"']+)["']/g;
const SIDE_EFFECT_RE = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

function resolveInternal(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.js$/, ".tsx"),
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  throw new Error(`Unresolvable internal import "${specifier}" from ${fromFile}`);
}

function crawlBundleExternals(entry: string): Map<string, string> {
  const seen = new Set<string>();
  const externals = new Map<string, string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = fs.readFileSync(file, "utf-8");

    const specifiers = [
      ...[...source.matchAll(FROM_RE)].map((m) => m[1]),
      ...[...source.matchAll(SIDE_EFFECT_RE)].map((m) => m[1]),
    ];
    for (const specifier of specifiers) {
      if (!specifier) continue;
      const internal = resolveInternal(file, specifier);
      if (internal) {
        queue.push(internal);
        continue;
      }
      if (isBuiltin(specifier)) continue;
      const pkg = packageNameOf(specifier);
      if (!externals.has(pkg)) externals.set(pkg, path.relative(REPO_ROOT, file));
    }
  }
  return externals;
}

const BOOT_ENTRY = path.join(API_ROOT, "src/main.ts");

describe("cluster bundle dependencies — installable from octogee-api's own package.json, overlay dependencies or registry dependencies", () => {
  function declaredDependencies(): Set<string> {
    const manifests = ["package.json", "overlay-dependencies.json", "registry-dependencies/package.json"]
      .map((file) => path.join(API_ROOT, file))
      .filter((file) => fs.existsSync(file));
    return new Set(manifests.flatMap((file) => {
      const manifest = JSON.parse(fs.readFileSync(file, "utf-8")) as { dependencies?: Record<string, string> };
      return Object.keys(manifest.dependencies ?? {});
    }));
  }

  function missingFrom(entry: string): string[] {
    const declared = declaredDependencies();
    return [...crawlBundleExternals(entry).entries()]
      .filter(([dep]) => !declared.has(dep))
      .map(([dep, importer]) => `${dep} (first imported by ${importer})`);
  }

  it("every external package the FULL boot graph reaches is declared here", () => {
    const missing = missingFrom(BOOT_ENTRY);
    expect(missing, `boot-graph imports missing from octogee-api dependencies:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every external package the cluster bundle reaches is declared here", () => {
    const missing = missingFrom(BUNDLE_ENTRY);
    expect(missing, `bundle imports missing from octogee-api dependencies:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the crawl actually reaches the bundle (sanity: express is found)", () => {
    const externals = crawlBundleExternals(BUNDLE_ENTRY);
    expect([...externals.keys()]).toContain("express");
  });
});
