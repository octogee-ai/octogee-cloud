import { describe, expect, it } from "vitest";

import {
  describeBindingLayout,
  readNativeModules,
  verifyNativeModules,
} from "../ops/verify-native-modules.mjs";

const packageRoot = "/octogee/scripts";

describe("readNativeModules", () => {
  it("reads the explicit package manifest list", () => {
    expect(readNativeModules({
      packageRoot,
      read: () => JSON.stringify({ nativeModules: ["example-native"] }),
    })).toEqual(["example-native"]);
  });

  it("rejects an absent or malformed manifest list", () => {
    expect(() => readNativeModules({
      packageRoot,
      read: () => JSON.stringify({ nativeModules: ["example-native", 7] }),
    })).toThrow(/nativeModules/);
  });
});

describe("verifyNativeModules", () => {
  it("reports no failures when every module loads", () => {
    const loaded: string[] = [];
    const failures = verifyNativeModules({
      names: ["example-native"],
      load: (name: string) => {
        loaded.push(name);
        return {};
      },
    });

    expect(loaded).toEqual(["example-native"]);
    expect(failures).toEqual([]);
  });

  it("names the failing module and keeps the loader error message", () => {
    const failures = verifyNativeModules({
      names: ["example-native"],
      load: () => {
        throw new Error("Failed to load native module");
      },
    });

    expect(failures).toEqual([
      { name: "example-native", message: "Failed to load native module" },
    ]);
  });

  it("checks every module even after one fails", () => {
    const failures = verifyNativeModules({
      names: ["example-native", "another-native"],
      load: (name: string) => {
        throw new Error(`broken ${name}`);
      },
    });

    expect(failures.map((failure) => failure.name)).toEqual(["example-native", "another-native"]);
  });

  it("treats a module that resolves to nothing as a failure", () => {
    const failures = verifyNativeModules({ names: ["example-native"], load: () => undefined });

    expect(failures).toEqual([{ name: "example-native", message: "module resolved to nothing" }]);
  });
});

describe("describeBindingLayout", () => {
  it("reports the missing platform prebuild and the absent node-gyp output", () => {
    const layout = describeBindingLayout({
      packageRoot,
      name: "example-native",
      platform: "linux",
      arch: "x64",
      exists: (candidate: string) => candidate === `${packageRoot}/node_modules/example-native/prebuilds`,
      readdir: () => ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"],
    });

    expect(layout).toContain("prebuilds/linux-x64 missing");
    expect(layout).toContain("darwin-arm64");
    expect(layout).toContain("build/Release missing");
  });

  it("reports a present node-gyp build", () => {
    const layout = describeBindingLayout({
      packageRoot,
      name: "example-native",
      platform: "linux",
      arch: "x64",
      exists: (candidate: string) =>
        candidate === `${packageRoot}/node_modules/example-native/build/Release`,
      readdir: () => [],
    });

    expect(layout).toContain("build/Release present");
  });
});
