import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = resolve(import.meta.dirname, "../..");
const EXPORTING_PACKAGES = ["gateway-edge", "llm-broker", "platform-api"];

interface ExportTarget {
  types?: string;
  default?: string;
}

const manifest = (name: string) => JSON.parse(readFileSync(resolve(platformRoot, name, "package.json"), "utf8")) as {
  files?: string[];
  exports?: Record<string, ExportTarget>;
};

const tsconfig = (name: string) => JSON.parse(readFileSync(resolve(platformRoot, name, "tsconfig.json"), "utf8")) as {
  compilerOptions: { rootDir: string; outDir: string };
  include: string[];
};

const sourceRoots = (name: string) => tsconfig(name).include.map((pattern) => resolve(platformRoot, name, pattern.split("/**")[0]!));

const sourceOf = (name: string, target: string) => {
  const { rootDir, outDir } = tsconfig(name).compilerOptions;
  const built = relative(outDir, target.replace(/^\.\//, ""));
  return resolve(platformRoot, name, rootDir, built.replace(/\.(?:d\.ts|js)$/, ".ts"));
};

describe.each(EXPORTING_PACKAGES)("%s package interface", (name) => {
  const { exports = {}, files = [] } = manifest(name);

  it("names every entry explicitly, with no wildcard", () => {
    expect(Object.keys(exports).length).toBeGreaterThan(0);
    for (const [entry, target] of Object.entries(exports)) {
      expect(entry).not.toContain("*");
      expect(JSON.stringify(target)).not.toContain("*");
    }
  });

  it("gives every entry built types and a built module from a source file of the package", () => {
    for (const [entry, target] of Object.entries(exports)) {
      expect(target, entry).toEqual({ types: expect.stringMatching(/^\.\/dist\/.+\.d\.ts$/), default: expect.stringMatching(/^\.\/dist\/.+\.js$/) });
      expect(target.types!.replace(/\.d\.ts$/, ""), entry).toBe(target.default!.replace(/\.js$/, ""));
      const source = sourceOf(name, target.default!);
      expect(sourceRoots(name).some((root) => source.startsWith(`${root}/`)), `${entry} must come from a source root ${name} compiles`).toBe(true);
      expect(existsSync(source), `${entry} → ${source}`).toBe(true);
    }
  });

  it("packs the built output", () => {
    expect(files).toContain("dist");
  });
});
