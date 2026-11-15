import { describe, expect, it } from "vitest";
import * as secretManagerCore from "@octogee/core/secret-manager";
import * as secretManagerShim from "../lib/secret-manager.js";

const shims = [
  ["secret-manager", secretManagerShim, secretManagerCore],
] as const;

describe("core re-export shims", () => {
  it.each(shims)("%s mirrors the core export surface", (_name, shim, core) => {
    expect(Object.keys(shim).sort()).toEqual(Object.keys(core).sort());
  });
});
