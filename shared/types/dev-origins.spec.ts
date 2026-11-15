import { afterEach, describe, expect, it } from "vitest";

import {
  isAllowedLocalhostHostname,
  isAllowedLocalhostOrigin,
  localDevOriginsAllowed,
} from "./dev-origins.js";

const ENV_KEY = "OCTOGEE_ALLOW_LOCAL_ORIGINS";
const ORIGINAL = process.env[ENV_KEY];

describe("dev-origins gate", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = ORIGINAL;
  });

  it("denies localhost by default (production-safe: unset env)", () => {
    delete process.env[ENV_KEY];
    expect(localDevOriginsAllowed()).toBe(false);
    expect(isAllowedLocalhostOrigin("http://localhost:4322")).toBe(false);
    expect(isAllowedLocalhostHostname("localhost")).toBe(false);
  });

  it("denies localhost for any value other than the exact string 'true'", () => {
    for (const value of ["false", "1", "TRUE", "", "yes"]) {
      process.env[ENV_KEY] = value;
      expect(localDevOriginsAllowed()).toBe(false);
      expect(isAllowedLocalhostOrigin("http://localhost:4322")).toBe(false);
    }
  });

  it("admits localhost origins only when the flag is exactly 'true'", () => {
    process.env[ENV_KEY] = "true";
    expect(localDevOriginsAllowed()).toBe(true);
    expect(isAllowedLocalhostOrigin("http://localhost:4322")).toBe(true);
    expect(isAllowedLocalhostOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedLocalhostHostname("localhost")).toBe(true);
  });

  it("never admits non-localhost shapes even when enabled", () => {
    process.env[ENV_KEY] = "true";
    expect(isAllowedLocalhostOrigin("https://localhost:4322")).toBe(false);
    expect(isAllowedLocalhostOrigin("http://localhost.evil.com:80")).toBe(false);
    expect(isAllowedLocalhostOrigin("http://127.0.0.1:4322")).toBe(false);
    expect(isAllowedLocalhostHostname("localhost.evil.com")).toBe(false);
  });
});
