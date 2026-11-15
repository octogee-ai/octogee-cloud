import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { overlayTree } from "../ops/overlay.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-overlay-"));
  roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function overlay(root: string) {
  return overlayTree({ platform: path.join(root, "platform"), product: path.join(root, "product"), out: path.join(root, ".overlay") });
}

describe("overlayTree", () => {
  it("merges each product package over its platform package and links the other platform entries", () => {
    const root = tree({
      "platform/controller/package.json": "{}",
      "platform/controller/src/index.ts": "export const platform = 1;\n",
      "platform/core/src/index.ts": "export const core = 1;\n",
      "product/controller/src/product-rules.ts": "import { platform } from './index.js';\n",
    });

    expect(overlay(root)).toEqual({ controller: { platformFiles: 2, productFiles: 1, replaced: [] } });

    expect(read(root, ".overlay/controller/src/index.ts")).toBe("export const platform = 1;\n");
    expect(read(root, ".overlay/controller/src/product-rules.ts")).toBe("import { platform } from './index.js';\n");
    expect(fs.readlinkSync(path.join(root, ".overlay/core"))).toBe(path.join("..", "platform", "core"));
    expect(read(root, ".overlay/core/src/index.ts")).toBe("export const core = 1;\n");
  });

  it("lets the product replace the composition root", () => {
    const root = tree({
      "platform/controller/src/main.ts": "void main({ product: null });\n",
      "product/controller/src/main.ts": "void main(octogee);\n",
    });

    expect(overlay(root).controller).toMatchObject({ replaced: ["src/main.ts"] });
    expect(read(root, ".overlay/controller/src/main.ts")).toBe("void main(octogee);\n");
  });

  it("refuses a product file that shadows any other platform file", () => {
    const root = tree({
      "platform/controller/src/index.ts": "export const platform = 1;\n",
      "product/controller/src/index.ts": "export const platform = 2;\n",
    });

    expect(() => overlay(root)).toThrow(/shadows platform files: src\/index\.ts/);
  });

  it("leaves a standalone product package with its own manifest out of the overlay", () => {
    const root = tree({
      "platform/core/package.json": "{\"name\":\"@octogee/core\"}",
      "platform/core/src/index.ts": "export const core = 1;\n",
      "product/core/package.json": "{\"name\":\"@octogee/product-core\"}",
      "product/core/src/index.ts": "export const productCore = 1;\n",
      "product/library/package.json": "{}",
    });

    expect(overlay(root)).toEqual({});
    expect(fs.readlinkSync(path.join(root, ".overlay/core"))).toBe(path.join("..", "platform", "core"));
    expect(read(root, ".overlay/core/src/index.ts")).toBe("export const core = 1;\n");
  });

  it("refuses a product package with no platform package", () => {
    const root = tree({
      "platform/controller/src/index.ts": "",
      "product/edge/src/product-routes.ts": "",
    });

    expect(() => overlay(root)).toThrow(/product\/edge has no platform package/);
  });

  it("skips installed and built output of the sources and keeps the merged tree's own", () => {
    const root = tree({
      "platform/controller/src/index.ts": "",
      "platform/controller/node_modules/dep/index.js": "",
      "platform/controller/dist/index.js": "",
      "product/controller/src/product-rules.ts": "",
    });
    overlay(root);
    fs.mkdirSync(path.join(root, ".overlay/controller/node_modules/installed"), { recursive: true });
    fs.mkdirSync(path.join(root, ".overlay/controller/dist"), { recursive: true });

    overlay(root);

    expect(fs.existsSync(path.join(root, ".overlay/controller/node_modules/dep"))).toBe(false);
    expect(fs.existsSync(path.join(root, ".overlay/controller/node_modules/installed"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".overlay/controller/dist"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".overlay/controller/dist/index.js"))).toBe(false);
  });

  it("removes files that left both trees since the last overlay", () => {
    const root = tree({
      "platform/controller/src/index.ts": "",
      "platform/controller/src/retired.ts": "",
      "product/controller/src/lib/product-rules.ts": "",
    });
    overlay(root);
    fs.rmSync(path.join(root, "platform/controller/src/retired.ts"));
    fs.rmSync(path.join(root, "product/controller/src/lib"), { recursive: true });

    overlay(root);

    expect(fs.readdirSync(path.join(root, ".overlay/controller/src"))).toEqual(["index.ts"]);
  });
});
