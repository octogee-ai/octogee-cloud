import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, ".."); // platform-api/src
const PKG_ROOT = resolve(here, "../.."); // octogee-api

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

// A relative import that resolves outside platform-api/ reaches another
// package's source and breaks the standalone image build.
describe("octogee-api imports no sibling-package source", () => {
  it("has zero relative imports escaping the package root", () => {
    const spec = /(?:from|import)\s*\(?\s*['"](\.\.?\/[^'"]*)['"]/g;
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      for (const m of readFileSync(file, "utf8").matchAll(spec)) {
        const target = resolve(dirname(file), m[1]);
        if (!relative(PKG_ROOT, target).startsWith("..")) continue; // inside octogee-api
        offenders.push(`${relative(PKG_ROOT, file)} → ${m[1]}`);
      }
    }
    expect(
      offenders,
      `import siblings via @octogee/core or @octogee/shared, not relative paths into their source:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
