import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  componentImportReport,
  importSpecifiers,
  importViolationsOf,
  loadComponentImportRules,
} from "../lib/component-imports.js";

const q = (text: string) => text.replaceAll("`", '"');
const cloudRoot = resolve(import.meta.dirname, "../..");
const rules = loadComponentImportRules(resolve(import.meta.dirname, "../lib/component-imports.json"));
const report = componentImportReport(cloudRoot, rules);

describe("component import boundary", () => {
  it("lets no component import another component's files, or a service component's package", () => {
    expect(report.newViolations, "import a library by its package name through its exports map; another service component's code is not importable").toEqual([]);
  });

  it("keeps the exception list shrinking: every entry still occurs", () => {
    expect(report.staleExceptions, "these exceptions no longer occur; remove them from scripts/lib/component-imports.json").toEqual([]);
  });
});

describe("importSpecifiers", () => {
  it("finds static, type, side-effect, dynamic, re-export, require and mock specifiers", () => {
    expect(importSpecifiers([
      q('import { a } from `./a.js`;'),
      "import type {",
      "  B,",
      q('} from `../b.js`;'),
      q('import `./side-effect.js`;'),
      q('const c = await import(`../c.ts`);'),
      q('export * from `./d.js`;'),
      q('const e = require(`./e.cjs`);'),
      q('vi.mock(`../f.js`, () => ({}));'),
      q('const g = await vi.importActual<typeof import(`./g.js`)>(`./g.js`);'),
    ].join("\n")).sort()).toEqual(["../b.js", "../c.ts", "../f.js", "./a.js", "./d.js", "./e.cjs", "./g.js", "./side-effect.js"]);
  });
});

describe("importViolationsOf", () => {
  const packages = new Map([["@octogee/shared", "shared"], ["@octogee/core", "core"], ["@octogee/gateway-edge", "gateway-edge"], ["@octogee/scripts", "scripts"]]);
  const libraries = ["core", "shared"];

  it("allows imports inside the component and libraries by package name", () => {
    expect(importViolationsOf("scripts/lib/a.ts", [
      q('import { b } from `./b.js`;'),
      q('import { c } from `../entrypoints/c.js`;'),
      q('import type { D } from `@octogee/shared/types/identity`;'),
      q('import { e } from `@octogee/core/config`;'),
      q('import express from `express`;'),
    ].join("\n"), packages, libraries)).toEqual([]);
  });

  it("flags a library reached by relative path, even through its dist", () => {
    expect(importViolationsOf("scripts/lib/a.ts", [
      q('import type { D } from `../../shared/types/identity.js`;'),
      q('import { e } from `../../core/dist/config.js`;'),
      q('import { f } from `../../shared`;'),
    ].join("\n"), packages, libraries)).toEqual(["scripts/lib/a.ts -> core", "scripts/lib/a.ts -> shared"]);
  });

  it("flags another service component by relative path or by package name", () => {
    expect(importViolationsOf("platform-api/src/a.ts", [
      q('import { b } from `../../gateway-edge/src/b.js`;'),
      q('import { c } from `@octogee/scripts/lib/c`;'),
    ].join("\n"), packages, libraries)).toEqual(["platform-api/src/a.ts -> gateway-edge", "platform-api/src/a.ts -> scripts (package)"]);
  });

  it("flags a path that leaves the repository and skips files at the root", () => {
    expect(importViolationsOf("scripts/a.ts", q('import { b } from `../../product/b.js`;'), packages, libraries))
      .toEqual(["scripts/a.ts -> (outside the repository)"]);
    expect(importViolationsOf("eslint.config.mjs", q('import { a } from `./scripts/a.js`;'), packages, libraries)).toEqual([]);
  });

  it("lets a component import its own package name", () => {
    expect(importViolationsOf("gateway-edge/src/a.ts", q('import { b } from `@octogee/gateway-edge/auth`;'), packages, libraries)).toEqual([]);
  });
});

describe("componentImportReport", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "component-imports-"));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    return root;
  }

  it("separates excepted violations from new ones and reports exceptions that no longer occur", () => {
    const fixture = tree({
      "edge/package.json": JSON.stringify({ name: "@octogee/edge" }),
      "edge/src/a.ts": "export const a = 1;\n",
      "api/src/old.ts": q('import { a } from `../../edge/src/a.js`;\n'),
      "api/src/new.ts": q('import { a } from `@octogee/edge/a`;\n'),
    });
    const files = ["api/src/new.ts", "api/src/old.ts", "edge/src/a.ts"];
    expect(componentImportReport(fixture, { libraries: [], exceptions: ["api/src/old.ts -> edge", "api/src/gone.ts -> edge"] }, files)).toEqual({
      violations: ["api/src/new.ts -> edge (package)", "api/src/old.ts -> edge"],
      newViolations: ["api/src/new.ts -> edge (package)"],
      staleExceptions: ["api/src/gone.ts -> edge"],
    });
  });
});
