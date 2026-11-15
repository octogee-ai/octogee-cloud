import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, ".."); // platform-api/src
const PKG_ROOT = resolve(here, "../.."); // octogee-api
const GATEWAY_EDGE_SRC = resolve(PKG_ROOT, "../gateway-edge/src");

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory()
      ? tsFiles(p)
      : p.endsWith(".ts")
        ? [p]
        : [];
  });
}

// A relative import that resolves OUTSIDE platform-api/ reaches another package's
// source. It "works" only because the monorepo worktree has that source checked
// out, and silently breaks any standalone build (Docker image, packed directory dependency).
// octogee-api consumes siblings through @octogee/core + @octogee/shared — with ONE
// deliberate exception: it compiles gateway-edge/src/* (the cluster route handlers
// physically live there and are imported by relative path from index.ts). Every
// other sibling reach must go through @octogee/*; this pins both halves.
describe("octogee-api imports no sibling-package source (except gateway-edge routes)", () => {
  it("has zero relative imports escaping the package root other than gateway-edge/src", () => {
    const spec = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]*)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(spec)) {
        const target = resolve(dirname(file), m[1]);
        if (!relative(PKG_ROOT, target).startsWith("..")) continue; // inside octogee-api
        if (!relative(GATEWAY_EDGE_SRC, target).startsWith("..")) continue; // gateway-edge routes — allowed
        offenders.push(`${relative(PKG_ROOT, file)} → ${m[1]}`);
      }
    }
    expect(
      offenders,
      `import siblings via @octogee/core or @octogee/shared, not relative paths into their source:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
