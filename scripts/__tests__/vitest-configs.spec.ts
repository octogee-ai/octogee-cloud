import type { PathLike } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configDefaults } from "vitest/config";
import unitConfig from "../vitest.config.js";

interface ScriptsVitestConfig {
  resolve?: { alias?: Record<string, string> };
  test?: {
    include?: string[];
    exclude?: string[];
    fileParallelism?: boolean;
    testTimeout?: number;
  };
}

const productDirectory = path.resolve(__dirname, "../../../product");
const gitDirectory = path.resolve(__dirname, "../../.git");

async function unitExcludesOn(
  platform: NodeJS.Platform,
  { productCheckout = true, gitCheckout = true } = {},
): Promise<string[]> {
  const present = new Map([[productDirectory, productCheckout], [gitDirectory, gitCheckout]]);
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...original, value: platform });
  vi.doMock("node:fs", async (importOriginal) => {
    const fs = await importOriginal<typeof import("node:fs")>();
    return { ...fs, existsSync: (file: PathLike) => present.get(String(file)) ?? fs.existsSync(file) };
  });
  try {
    vi.resetModules();
    const { default: cfg } = await import("../vitest.config.js");
    return (cfg as ScriptsVitestConfig).test?.exclude ?? [];
  } finally {
    vi.doUnmock("node:fs");
    Object.defineProperty(process, "platform", original);
  }
}

describe("scripts vitest configs", () => {
  it("keeps unit tests on non-emulator specs with shared aliases", () => {
    const cfg = unitConfig as ScriptsVitestConfig;
    const alias = cfg.resolve?.alias as Record<string, string>;

    expect(alias["@shared"]).toBe(path.resolve(__dirname, "../../shared"));
    expect(cfg.test?.include).toEqual(["__tests__/**/*.spec.ts"]);
    expect(cfg.test?.exclude).toContain("**/*.emulator.spec.ts");
  });

  it("runs Linux-host specs on Linux and skips them on other hosts", async () => {
    const linux = await unitExcludesOn("linux");
    const darwin = await unitExcludesOn("darwin");

    expect(linux).toEqual([...configDefaults.exclude, "**/*.emulator.spec.ts", "__tests__/firebase-reach.spec.ts"]);
    expect(darwin).toEqual(expect.arrayContaining([...linux, "__tests__/rsync-staged-symlinks.spec.ts"]));
  });

  it("skips specs that read the product checkout only when the platform stands alone", async () => {
    const inside = await unitExcludesOn("linux");
    const standalone = await unitExcludesOn("linux", { productCheckout: false });

    expect(inside).not.toContain("__tests__/deploy-workflow-log-level.spec.ts");
    expect(standalone).toEqual(expect.arrayContaining(["__tests__/deploy-workflow-log-level.spec.ts", "__tests__/platform-boundary.spec.ts"]));
  });

  it("runs specs that read this repository's commits only in its git checkout", async () => {
    const checkout = await unitExcludesOn("linux");
    const overlay = await unitExcludesOn("linux", { gitCheckout: false });

    expect(checkout).not.toContain("__tests__/publish-plugin.spec.ts");
    expect(overlay).toEqual([...checkout, "__tests__/publish-plugin.spec.ts"]);
  });

  it("runs the platform's Firebase reach ratchet only when the platform stands alone", async () => {
    const inside = await unitExcludesOn("linux");
    const standalone = await unitExcludesOn("linux", { productCheckout: false });

    expect(inside).toContain("__tests__/firebase-reach.spec.ts");
    expect(standalone).not.toContain("__tests__/firebase-reach.spec.ts");
  });
});
