import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const platformRoot = resolve(import.meta.dirname, "../..");
const PUBLISHED_PACKAGES = ["gateway-edge"];

interface ExportTarget {
  types?: string;
  default?: string;
}

const manifest = (name: string) => JSON.parse(readFileSync(resolve(platformRoot, name, "package.json"), "utf8")) as {
  files?: string[];
  exports?: Record<string, ExportTarget>;
};

const sourceOf = (name: string, target: string) => resolve(platformRoot, name, "..", target.replace(/^\.\/dist\//, "").replace(/\.(?:d\.ts|js)$/, ".ts"));

describe.each(PUBLISHED_PACKAGES)("%s package interface", (name) => {
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
      expect(source.startsWith(resolve(platformRoot, name, "src")), `${entry} must come from ${name}/src`).toBe(true);
      expect(existsSync(source), `${entry} → ${source}`).toBe(true);
    }
  });

  it("packs the built output", () => {
    expect(files).toContain("dist");
  });
});
