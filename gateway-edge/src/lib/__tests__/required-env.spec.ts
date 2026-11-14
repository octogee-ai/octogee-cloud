import { describe, it, expect } from "vitest";
import { validateRequiredEnv, REQUIRED_ENV } from "../required-env.js";

const full = {
  GCP_PROJECT_ID: "octogee",
};

describe("validateRequiredEnv", () => {
  it("returns no missing when all required env present (prod)", () => {
    expect(validateRequiredEnv(full, { isProd: true }).missing).toEqual([]);
  });

  it("flags each individually-missing required var (prod)", () => {
    for (const key of REQUIRED_ENV) {
      const { [key]: _omit, ...rest } = full;
      expect(validateRequiredEnv(rest, { isProd: true }).missing).toContain(key);
    }
  });

  it("treats empty string as missing — the exact silent-drop shape (#1131 fallout)", () => {
    expect(
      validateRequiredEnv({ ...full, GCP_PROJECT_ID: "" }, { isProd: true }).missing,
    ).toContain("GCP_PROJECT_ID");
  });

  it("treats whitespace-only as missing (a blank project ID fails the same at runtime)", () => {
    expect(
      validateRequiredEnv({ ...full, GCP_PROJECT_ID: "   " }, { isProd: true }).missing,
    ).toContain("GCP_PROJECT_ID");
  });

  it("does NOT require GITEA_ORG — gateway-edge never reads it from env", () => {
    expect(validateRequiredEnv(full, { isProd: true }).missing).toEqual([]);
    expect([...REQUIRED_ENV]).not.toContain("GITEA_ORG");
  });

  it("does NOT require platform secrets in the gateway pod runtime", () => {
    expect([...REQUIRED_ENV]).not.toContain("INTERNAL_SERVICE_KEY");
    expect([...REQUIRED_ENV]).not.toContain("GITEA_TOKEN");
  });

  it("lists ALL missing at once so one crash names every gap", () => {
    expect(validateRequiredEnv({}, { isProd: true }).missing.sort()).toEqual(
      [...REQUIRED_ENV].sort(),
    );
  });

  it("applies the same non-secret runtime requirements to shared and user profiles", () => {
    expect(validateRequiredEnv({}, { isProd: true, profile: "isolated" }).missing).toEqual(["GCP_PROJECT_ID"]);
    expect(validateRequiredEnv({}, { isProd: true, profile: "standard" }).missing).toEqual(["GCP_PROJECT_ID"]);
  });

  it("is a no-op in non-prod (dev/test/local legitimately lack them)", () => {
    expect(validateRequiredEnv({}, { isProd: false }).missing).toEqual([]);
  });
});
