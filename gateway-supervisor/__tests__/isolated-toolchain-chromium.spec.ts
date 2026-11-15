import { describe, expect, it } from "vitest";

import { chromiumModuleFromNamespace } from "../lib/isolated-toolchain-chromium.js";

describe("User Chromium module resolution", () => {
  it("finds executablePath on the class that @sparticuz/chromium exports as its default", () => {
    class Chromium {
      static async executablePath(): Promise<string> {
        return "/tmp/chromium";
      }
    }
    const namespace = { default: Chromium, inflate: async () => undefined };

    expect(chromiumModuleFromNamespace(namespace)?.executablePath).toBe(Chromium.executablePath);
  });

  it("accepts a plain-object default export", () => {
    const chromium = { executablePath: async () => "/tmp/chromium" };

    expect(chromiumModuleFromNamespace({ default: chromium })).toBe(chromium);
  });

  it("rejects a namespace without an executablePath function", () => {
    expect(chromiumModuleFromNamespace({ default: class Chromium {}, inflate: () => undefined }))
      .toBeNull();
  });
});
