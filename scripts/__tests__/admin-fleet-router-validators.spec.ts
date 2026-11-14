import { describe, expect, it } from "vitest";
import { validateDeployBody, validateDesiredStatusPatch } from "@octogee/core/admin-fleet-router";

describe("validateDesiredStatusPatch", () => {
  it("rejects retired because retirement requires teardown", () => {
    const result = validateDesiredStatusPatch("retired");
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error.body.error).toMatch(/DELETE \/gateways\/:id/);
  });

  it("accepts active lifecycle states", () => {
    for (const status of ["running", "paused", "draining"] as const) {
      expect(validateDesiredStatusPatch(status)).toEqual({ ok: status });
    }
  });
});

describe("validateDeployBody", () => {
  it("accepts one exact full source SHA", () => {
    const sourceSha = "a".repeat(40);
    expect(validateDeployBody({ sourceSha })).toEqual({ ok: { sourceSha } });
  });

  it("rejects short SHAs and additional process fields", () => {
    expect(validateDeployBody({ sourceSha: "deadbeef" })).toMatchObject({
      error: { status: 400 },
    });
    expect(validateDeployBody({
      sourceSha: "a".repeat(40),
      version: "v1.2.3",
    })).toMatchObject({ error: { status: 400 } });
  });
});
