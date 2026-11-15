import { describe, expect, it } from "vitest";
import config from "../vitest.config.js";

interface VitestConfig {
  test?: { include?: string[] };
}

describe("chat tools vitest config", () => {
  it("discovers extension-owned specs only", () => {
    expect((config as VitestConfig).test?.include).toEqual(["__tests__/**/*.spec.ts"]);
  });
});
